import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BrightnessControl} from './brightness.js';
import {VolumeControl} from './volume.js';
import * as Log from './logger.js';

/**
 * 滚轮方向 + 幅度 -> 带符号的步进量。
 *
 * 纯函数，有单测（scripts/test_wheel.mjs）。
 * dir 已经带方向（inputSource 归一化过），所以这里只处理符号和幅度，
 * 绝不能再乘 value 自身的正负号 —— 之前就是这样双重取反，
 * 导致上下滚都变成「增加」。
 */
export function computeDelta(dir, magnitude, step) {
    const mag = Math.abs(magnitude);
    if (mag < 1e-6)
        return 0;
    const positive = (dir === 'up' || dir === 'right');
    const notches = Math.min(3, Math.max(1, Math.round(mag)));
    return (positive ? 1 : -1) * notches * step;
}

const FLUSH_MS = 16;

/**
 * 屏幕边缘滚轮（evdev 事件驱动）。
 *
 * 为什么不用 stage 的 captured-event：真实会话里滚轮直接转发给指针下的
 * 客户端窗口，根本不经过 shell 的 stage，扩展收不到。
 *
 * 副作用：窗口仍会收到这次滚动（只观察不拦截）。边缘 28px 内大多是
 * 窗口边框或桌面，实际无感。
 */
export class EdgeWheel {
    constructor(settings, geometry) {
        this._cfg = settings;
        this._geometry = geometry;
        this._brightness = null;
        this._volume = null;
        this._accum = 0;
        this._lastDir = null;
        this._lastTarget = null;
        this._flushId = 0;
        this._lastTs = new Map();
    }

    enable() {
        this._brightness = new BrightnessControl();
        this._volume = new VolumeControl();
        Log.info('边缘滚轮就绪 亮度后端=' + this._brightness.backend +
            ' 音量=' + (this._volume.available ? 'ok' : '不可用') +
            ' 左=' + this._cfg.edge.left + ' 右=' + this._cfg.edge.right +
            ' margin=' + this._cfg.edge.margin + ' step=' + this._cfg.edge.step);
    }

    disable() {
        this._flush();
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

    /** @param {'up'|'down'|'left'|'right'} dir @param {number} value 原始值，可正可负 */
    onWheel(dir, value) {
        if (!this._cfg.edge.enabled)
            return;
        if (Main.overview.visible || Main.screenShield?.active ||
            Main.screenshotUI?.visible)
            return;

        const [px, py] = this._geometry().pointer;
        const zone = this._zoneAt(px, py);
        if (!zone) {
            Log.debug('滚轮 ' + dir + ' 忽略：指针不在边缘带 @' +
                Math.round(px) + ',' + Math.round(py));
            return;
        }

        const target = this._cfg.edge[zone];
        if (!target || target === 'none') {
            Log.debug('滚轮 ' + dir + ' 忽略：' + zone + ' 边未配置动作');
            return;
        }

        // 方向以 dir 为准（已归一化），这里只累加幅度
        const axis = (dir === 'up' || dir === 'down') ? 'y' : 'x';
        const positive = (dir === 'up' || dir === 'right');
        if (axis !== this._lastDir && this._accum !== 0)
            this._flush();
        this._lastDir = axis;
        this._accum += positive ? Math.abs(value) : -Math.abs(value);
        this._lastTarget = target;

        if (!this._flushId) {
            this._flushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLUSH_MS, () => {
                this._flushId = 0;
                this._flush();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _flush() {
        const notches = this._accum;
        const target = this._lastTarget;
        this._accum = 0;
        this._lastTarget = null;
        if (!target || Math.abs(notches) < 1e-6)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        const last = this._lastTs.get(target) ?? 0;
        if (now - last < (this._cfg.edge.cooldownMs ?? 20))
            return;
        this._lastTs.set(target, now);

        const dir = notches > 0 ? 'up' : 'down';
        const delta = computeDelta(dir, notches, this._cfg.edge.step ?? 0.05);
        if (delta === 0)
            return;

        Log.info('边缘滚轮 ' + target + ' ' + dir + ' 幅度=' + notches.toFixed(2) +
            ' -> delta=' + delta.toFixed(3));

        if (target === 'brightness')
            this._brightness?.nudge(delta);
        else if (target === 'volume')
            this._volume?.nudge(delta);
    }

    /** 指针落在哪条边（四角归最近的边），没有则 null。 */
    _zoneAt(x, y) {
        const margin = this._cfg.edge.margin ?? 28;
        for (const m of this._geometry().monitors) {
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
