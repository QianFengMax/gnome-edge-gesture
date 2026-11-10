import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BrightnessControl} from './brightness.js';
import {VolumeControl} from './volume.js';
import * as Log from './logger.js';

/**
 * 屏幕边缘滚轮（evdev 事件驱动）。
 *
 * 为什么不用 stage 的 captured-event：真实会话里滚轮事件直接转发给指针下的
 * 客户端窗口，根本不经过 shell 的 stage，所以扩展收不到（嵌套测试能过是因为
 * 那里没有客户端窗口）。evdev 拿的是硬件原始流，不受窗口路由影响。
 *
 * 副作用：窗口仍会收到这次滚动（我们只观察不拦截）。
 * 边缘 28px 内基本都是窗口边框/桌面，实际影响很小；真要彻底拦需要
 * uinput 重新注入，代价大得多。
 */
export class EdgeWheel {
    constructor(settings, geometry) {
        this._cfg = settings;
        this._geometry = geometry;      // () => {monitors: [{x,y,w,h}], pointer:[x,y]}
        this._brightness = null;
        this._volume = null;
        this._lastTs = new Map();       // 方向 -> 上次触发时间
        this._wheelAccum = 0;
        this._wheelAxis = null;
        this._wheelFlushId = 0;
    }

    enable() {
        this._brightness = new BrightnessControl();
        this._volume = new VolumeControl();
        Log.info('边缘滚轮就绪 亮度后端=' + this._brightness.backend +
            ' 音量=' + (this._volume.available ? 'ok' : '不可用'));
    }

    disable() {
        this._flushWheel();
        this._volume?.destroy();
        this._volume = null;
        this._brightness = null;
    }

    get status() {
        return {
            brightness: this._brightness?.backend ?? 'none',
            volume: this._volume?.available ?? false,
        };
    }

    /** @param {'up'|'down'|'left'|'right'} dir @param {number} value */
    onWheel(dir, value) {
        if (!this._cfg.edge.enabled || value === 0)
            return;
        if (Main.overview.visible || Main.screenShield?.active ||
            Main.screenshotUI?.visible)
            return;

        const zone = this._zoneAt();
        if (!zone)
            return;
        const target = this._cfg.edge[zone];
        if (!target || target === 'none')
            return;

        // 一帧内的高精度滚动合并：触摸板会把一格拆成很多小 delta
        const axis = (dir === 'up' || dir === 'down') ? 'y' : 'x';
        if (axis !== this._wheelAxis && this._wheelAccum !== 0)
            this._flushWheel();
        this._wheelAxis = axis;
        this._wheelAccum += (dir === 'up' || dir === 'right') ? value : -value;
        this._pendingZone = zone;
        this._pendingTarget = target;

        if (!this._wheelFlushId) {
            this._wheelFlushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
                this._wheelFlushId = 0;
                this._flushWheel();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _flushWheel() {
        const notches = this._wheelAccum;
        const target = this._pendingTarget;
        this._wheelAccum = 0;
        this._pendingTarget = null;
        if (Math.abs(notches) < 0.01 || !target)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const key = target;
        const last = this._lastTs.get(key) ?? 0;
        if (now - last < (this._cfg.edge.cooldownMs ?? 20))
            return;
        this._lastTs.set(key, now);

        const delta = Math.sign(notches) *
            Math.min(3, Math.max(1, Math.round(Math.abs(notches)))) *
            (this._cfg.edge.step ?? 0.05);

        Log.debug(`边缘滚轮 ${target} delta=${delta.toFixed(3)}`);
        if (target === 'brightness')
            this._brightness?.nudge(delta);
        else if (target === 'volume')
            this._volume?.nudge(delta);
    }

    /** 当前指针落在哪条边（四角归最近的边），没有则 null。 */
    _zoneAt() {
        const {monitors, pointer} = this._geometry();
        const [x, y] = pointer;
        const margin = this._cfg.edge.margin ?? 28;

        for (const m of monitors) {
            if (x < m.x || x >= m.x + m.w || y < m.y || y >= m.y + m.h)
                continue;
            const cands = [
                [x - m.x, 'left'],
                [m.x + m.w - x, 'right'],
                [y - m.y, 'top'],
                [m.y + m.h - y, 'bottom'],
            ].filter(([d]) => d <= margin).sort((a, b) => a[0] - b[0]);
            return cands[0]?.[1] ?? null;
        }
        return null;
    }
}
