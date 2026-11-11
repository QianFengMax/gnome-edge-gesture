import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TraceOverlay} from './overlay.js';
import {detectRectangle} from './recognizer.js';
import {BUTTONS} from './inputSource.js';
import * as Log from './logger.js';

/**
 * 右键手势引擎（事件驱动）。
 *
 * 事件来源是 evdev（inputSource），不是 Clutter：
 *  - 真实会话里 Clutter 的按钮掩码与文档不符，无法可靠区分左右键；
 *  - 指针落在 reactive actor 上时事件被吞，路由不可预期。
 *
 * 超时语义修过一次：以前的实现是「按下后固定 1500ms 就收尾」，
 * 画得慢一点就会在途中被截断。现在改成「按住期间不超时，
 * 只有真正静止超过 timeoutMs 才收尾」。
 */
export class GestureEngine {
    constructor(cfg, handlers) {
        this._cfg = cfg;
        this._handlers = handlers;
        this._overlay = null;
        this._state = 'idle';     // idle | armed | drawing
        this._points = [];
        this._start = null;
        this._idleTimer = 0;
        this._lastMoveAt = 0;
        this._rect = null;
        this._buttonDown = false;
        this._shouldYield = () => false;
    }

    /** 由 extension 注入：指针是否落在我们自己的贴图/弹窗上。 */
    setYieldCheck(fn) {
        this._shouldYield = fn;
    }

    enable() {
        this._overlay = new TraceOverlay();
        this._overlay.setStyle({
            color: this._cfg.gesture.traceColor,
            width: this._cfg.gesture.traceWidth,
        });
        Log.info('手势引擎就绪（evdev 事件驱动）');
    }

    disable() {
        this._cancelIdleTimer();
        this._overlay?.destroy();
        this._overlay = null;
        this._state = 'idle';
        this._points = [];
        this._buttonDown = false;
    }

    get _active() {
        if (!this._cfg.gesture.enabled || Main.overview.visible)
            return false;
        if (Main.screenShield?.active)
            return false;
        if (Main.screenshotUI?.visible)
            return false;
        return true;
    }

    // ---- 来自 inputSource 的原始事件 ----

    onButton(code, pressed) {
        if (code !== BUTTONS.RIGHT)
            return;
        if (!this._active)
            return;

        if (pressed) {
            if (this._state !== 'idle')
                return;
            // 指针在我们自己的浮层上：这次右键归它处理
            if (this._shouldYield())
                return;
            const [x, y] = global.get_pointer();
            this._buttonDown = true;
            this._state = 'armed';
            this._start = [x, y];
            this._points = [[x, y]];
            this._rect = null;
            this._lastMoveAt = GLib.get_monotonic_time();
            this._armIdleTimer();
            Log.debug(`右键按下 @${Math.round(x)},${Math.round(y)}`);
        } else {
            this._buttonDown = false;
            if (this._state === 'idle')
                return;
            const wasDrawing = this._state === 'drawing';
            const points = this._points.slice();
            this._reset();
            if (!wasDrawing) {
                // 只点了一下没画，交给窗口自己处理右键菜单
                return;
            }
            this._decide(points);
        }
    }

    onMotion(dx, dy) {
        if (this._state === 'idle')
            return;
        const [x, y] = global.get_pointer();
        this._lastMoveAt = GLib.get_monotonic_time();
        this._armIdleTimer();

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
            Log.debug('开始记录轨迹');
        }

        const last = this._points[this._points.length - 1];
        if (last && Math.hypot(x - last[0], y - last[1]) < 1.2)
            return;

        this._points.push([x, y]);
        if (this._points.length > 3000)
            this._points.splice(0, 500);

        this._rect = detectRectangle(this._points, {minSize: 80});
        this._overlay?.update(this._points, this._rect?.bbox ?? null);
    }

    onEscape() {
        if (this._state === 'idle')
            return false;
        Log.debug('Esc 取消手势');
        this._reset();
        return true;
    }

    // ---- 内部 ----

    /**
     * 静止超时：只有「按住但不再移动」才收尾，画的过程中永远不会超时。
     * 这是之前「画到一半被截断」的根因修复。
     */
    _armIdleTimer() {
        this._cancelIdleTimer();
        const ms = this._cfg.gesture.timeoutMs ?? 3000;
        this._idleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._idleTimer = 0;
            if (this._state === 'idle')
                return GLib.SOURCE_REMOVE;
            const idle = (GLib.get_monotonic_time() - this._lastMoveAt) / 1000;
            if (idle < ms) {
                this._armIdleTimer();
                return GLib.SOURCE_REMOVE;
            }
            const points = this._points.slice();
            const wasDrawing = this._state === 'drawing';
            this._reset();
            Log.debug('静止超时，收尾（' + (wasDrawing ? '判定' : '放弃') + '）');
            if (wasDrawing)
                this._decide(points);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelIdleTimer() {
        if (this._idleTimer) {
            GLib.source_remove(this._idleTimer);
            this._idleTimer = 0;
        }
    }

    _reset() {
        this._cancelIdleTimer();
        this._overlay?.hide();
        this._state = 'idle';
        this._points = [];
        this._rect = null;
    }

    _decide(points) {
        if (points.length < 3)
            return;

        const rect = detectRectangle(points, {minSize: 80});
        if (!rect) {
            // 模板手势默认关闭。以前这里会拿模板库去硬匹配，把任意一条向左的
            // 短线判成 LEFT 然后弹「LEFT → none」的通知，属于误触发，已移除。
            Log.debug('不是矩形也不是已启用的模板，忽略');
            return;
        }

        const action = rect.clockwise
            ? this._cfg.gesture.rectCw
            : this._cfg.gesture.rectCcw;
        Log.info(`矩形 ${rect.clockwise ? '顺时针' : '逆时针'} ${JSON.stringify(rect.bbox)} -> ${action}`);
        if (!action || action === 'none') {
            Log.debug('该方向未配置动作，忽略');
            return;
        }
        this._handlers.onRectangle?.(rect, action);
    }
}
