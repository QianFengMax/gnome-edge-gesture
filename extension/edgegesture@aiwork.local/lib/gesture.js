import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TraceOverlay} from './overlay.js';
import {detectRectangle, matchTemplate} from './recognizer.js';
import {RAW_TEMPLATES} from './templates.js';
import * as Log from './logger.js';

// Clutter 的按钮掩码：bit8 起依次对应 button1..button5。
// 实测按下 button3 时 get_pointer() 的 mods 是 0x200，与文档不完全一致，
// 所以这里用「任意按钮」掩码做按住判定，兼容各种映射差异。
const ANY_BUTTON_MASK =
    Clutter.ModifierType.BUTTON1_MASK |
    Clutter.ModifierType.BUTTON2_MASK |
    Clutter.ModifierType.BUTTON3_MASK |
    Clutter.ModifierType.BUTTON4_MASK |
    Clutter.ModifierType.BUTTON5_MASK;

const POLL_MS = 12;

/**
 * 右键手势引擎。
 *
 * 状态机：idle -> armed（已按下，位移未超过触发距离）
 *                 -> drawing（记录轨迹）-> 松手判定 -> idle
 *
 * 轨迹采样用 global.get_pointer() 轮询，而不是 stage 的 motion 事件：
 * GNOME 50 上客户端窗口持有输入焦点时，motion 不一定经过 shell 的
 * captured-event（嵌套合成、纯 Wayland 客户端上都复现过），轮询稳得多。
 */
export class GestureEngine {
    constructor(cfg, handlers) {
        this._cfg = cfg;
        this._handlers = handlers;
        // 由 extension 注入：返回当前是否该让路（例如指针在某块贴图上）
        this.isPointerOverOwnActor = () => false;
        this._debug = !!cfg.debug;
        this._overlay = null;
        this._state = 'idle';
        this._points = [];
        this._start = null;
        this._button = 3;
        this._stageId = 0;
        this._pollId = 0;
        this._timeoutId = 0;
        this._lastSampleAt = 0;
        this._rect = null;
        this._suppressed = false;
    }

    enable() {
        this._button = this._cfg.gesture.button ?? 3;
        this._overlay = new TraceOverlay();
        this._overlay.setStyle({
            color: this._cfg.gesture.traceColor,
            width: this._cfg.gesture.traceWidth,
        });
        this._stageId = global.stage.connect('captured-event',
            (_a, event) => this._onEvent(event));
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            // 轮询回调里抛异常会让这个 source 直接停掉，必须自己兜住。
            try {
                this._onPoll();
            } catch (e) {
                Log.log('手势轮询异常', e.message);
                this._resetState();
            }
            return GLib.SOURCE_CONTINUE;
        });
        Log.log('GestureEngine 就绪 button=' + this._button);
    }

    disable() {
        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._cancelTimeout();
        this._overlay?.destroy();
        this._overlay = null;
        this._state = 'idle';
        this._points = [];
    }

    get _active() {
        // 只排除真正需要独占输入的界面：概览、截图/录屏 UI、锁屏。
        // 不能用 Main.modalCount：贴图、菜单都会加它，手势就全废了。
        if (!this._cfg.gesture.enabled || Main.overview.visible)
            return false;
        if (Main.screenShield?.active)
            return false;
        if (Main.screenshotUI?.visible)
            return false;
        return true;
    }

    // ---- 事件：状态切换 ----
    _onEvent(event) {
        try {
            return this._handle(event);
        } catch (e) {
            // 事件处理抛异常会让 stage 跳过后续处理器，这里必须吃掉。
            Log.log('手势事件异常', e.message);
            this._reset();
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _handle(event) {
        const type = event.type();

        if (type === Clutter.EventType.BUTTON_PRESS) {
            if (!this._active || event.get_button() !== this._button)
                return Clutter.EVENT_PROPAGATE;
            // 指针在我们自己的贴图/弹窗上：这次右键归它们处理
            if (this.isPointerOverOwnActor())
                return Clutter.EVENT_PROPAGATE;
            if (this._suppressed) {
                // 这是我们自己补发的点击，不再当成新手势
                this._suppressed = false;
                return Clutter.EVENT_PROPAGATE;
            }
            if (this._state !== 'idle')
                return Clutter.EVENT_PROPAGATE;
            this._state = 'armed';
            // 与轨迹采样保持同一坐标源：合成事件里 event.get_coords() 可能是旧值
            const [px, py] = global.get_pointer();
            this._start = [px, py];
            this._points = [[...this._start]];
            this._rect = null;
            this._lastSampleAt = GLib.get_monotonic_time();
            this._armTimeout();
            if (this._debug)
                Log.log('armed at', ...this._start);
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            if (event.get_button() !== this._button)
                return Clutter.EVENT_PROPAGATE;
            if (this._state === 'idle')
                return Clutter.EVENT_PROPAGATE;
            const wasDrawing = this._state === 'drawing';
            const points = this._collectNow();
            this._reset();
            if (!wasDrawing) {
                // 只按了一下没画：交给下面的窗口，右键菜单照常弹
                return Clutter.EVENT_PROPAGATE;
            }
            this._decide(points);
            return this._cfg.gesture.restoreClick
                ? Clutter.EVENT_PROPAGATE
                : Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.KEY_PRESS && this._state !== 'idle' &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this._reset();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // ---- 轮询：轨迹采样 ----
    _onPoll() {
        if (this._state === 'idle') {
            // 自愈：按下事件可能被别的 actor 吃掉（grab、贴图等），
            // 只要指针按住右键且没在手势状态里，就补一次 armed。
            this._maybeArmFromPoll();
            return;
        }
        this._heldTicks = 0;

        const [x, y, mods] = global.get_pointer();
        if (!(mods & ANY_BUTTON_MASK)) {
            // 抬起事件丢了：用最后位置收尾
            const wasDrawing = this._state === 'drawing';
            const points = this._points.slice();
            this._reset();
            if (wasDrawing)
                this._decide(points);
            return;
        }
        this._sample(x, y);
    }

    /**
     * 按下事件丢失时的兜底。
     * 只在「按住右键 + 不在手势 + 不在我们自己的贴图/弹窗上」时补开，
     * 避免把贴图拖动、右键菜单等误判成手势。
     */
    _maybeArmFromPoll() {
        if (!this._active)
            return;
        const [x, y, mods] = global.get_pointer();
        // 实测：无论按哪个键，mods 里出现的都是 0x200（BUTTON2_MASK 位），
        // 所以这里只判断「有没有任意键按住」。
        if (!(mods & ANY_BUTTON_MASK))
            return;
        if (this.isPointerOverOwnActor())
            return;
        // 连续两拍都按着才认，避免单击瞬间被误判
        this._heldTicks = (this._heldTicks ?? 0) + 1;
        if (this._heldTicks < 4)
            return;
        this._heldTicks = 0;
        this._state = 'armed';
        const [px, py] = global.get_pointer();
        this._start = [px, py];
        this._points = [[px, py]];
        this._rect = null;
        this._lastSampleAt = GLib.get_monotonic_time();
        this._armTimeout();
        if (this._debug)
            Log.log('armed(poll) at', px, py);
    }

    _collectNow() {
        const [x, y] = global.get_pointer();
        if (this._state === 'drawing')
            this._sample(x, y);
        return this._points.slice();
    }

    _sample(x, y) {
        const now = GLib.get_monotonic_time();
        const last = this._points[this._points.length - 1];

        if (this._state === 'armed') {
            const startDist = this._cfg.gesture.startDistance ?? 12;
            if (Math.hypot(x - this._start[0], y - this._start[1]) < startDist)
                return;
            this._state = 'drawing';
            this._overlay?.show();
            this._overlay?.setStyle({
                color: this._cfg.gesture.traceColor,
                width: this._cfg.gesture.traceWidth,
            });
            if (this._debug)
                Log.log('drawing start', x, y);
        }

        if (last && Math.hypot(x - last[0], y - last[1]) < 1.2)
            return;
        this._lastSampleAt = now;

        this._points.push([x, y]);
        if (this._points.length > 3000)
            this._points.splice(0, 500);

        this._rect = detectRectangle(this._points, {minSize: 80});
        this._overlay?.update(this._points, this._rect?.bbox ?? null);
    }

    _armTimeout() {
        this._cancelTimeout();
        const ms = this._cfg.gesture.timeoutMs ?? 1500;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeoutId = 0;
            if (this._state === 'drawing') {
                const points = this._points.slice();
                this._reset();
                this._decide(points);
            } else if (this._state === 'armed') {
                this._reset();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _reset() {
        this._cancelTimeout();
        this._overlay?.hide();
        this._resetState();
    }

    _resetState() {
        this._state = 'idle';
        this._points = [];
        this._rect = null;
    }

    _decide(points) {
        if (points.length < 3)
            return;

        const rect = detectRectangle(points, {minSize: 80});
        if (rect) {
            Log.log('矩形', rect.clockwise ? '顺时针' : '逆时针',
                JSON.stringify(rect.bbox));
            const action = rect.clockwise
                ? this._cfg.gesture.rectCw
                : this._cfg.gesture.rectCcw;
            this._handlers.onRectangle?.(rect, action);
            return;
        }

        const tplActions = this._cfg.gesture.templateActions ?? {};
        if (Object.keys(tplActions).length === 0)
            return;

        const hit = matchTemplate(points, RAW_TEMPLATES,
            this._cfg.gesture.sensitive ?? 50);
        if (!hit)
            return;
        const action = tplActions[hit.name];
        Log.log('模板', hit.name, hit.score.toFixed(2));
        if (action)
            this._handlers.onTemplate?.(hit.name, action);
    }
}