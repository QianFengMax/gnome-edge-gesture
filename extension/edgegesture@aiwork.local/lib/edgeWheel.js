import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BrightnessControl, ensureManager} from './brightness.js';
import {VolumeControl} from './volume.js';
import * as Log from './logger.js';

/**
 * 屏幕边缘滚轮。
 *
 * 在 stage 的 captured-event 里拦下落在边缘带内的滚轮，直接吃掉这次事件，
 * 不让它透给下面的窗口（窗口滚动、列表滚动都不会发生）。
 */
export class EdgeWheel {
    constructor(settings) {
        this._cfg = settings;
        this._debug = !!settings.debug;
        this._brightness = null;
        this._volume = null;
        this._lastTs = 0;
        this._stageId = 0;
        this._monitorsId = 0;
    }

    enable() {
        ensureManager();
        this._brightness = new BrightnessControl();
        this._volume = new VolumeControl();
        this._stageId = global.stage.connect('captured-event', (_a, event) => {
            try {
                return this._handle(event);
            } catch (e) {
                // 这里抛异常会让 stage 跳过后续处理器，必须吃掉。
                Log.log('边缘滚轮异常', e.message);
                return Clutter.EVENT_PROPAGATE;
            }
        });
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => Log.log('显示器变化，边缘带重算'));
        Log.log('EdgeWheel 就绪 亮度=' + this._brightness.backend +
            ' 音量=' + this._volume.available);
    }

    disable() {
        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._volume?.destroy();
        this._volume = null;
        this._brightness = null;
    }

    _handle(event) {
        if (!this._cfg.edge.enabled)
            return Clutter.EVENT_PROPAGATE;
        if (event.type() !== Clutter.EventType.SCROLL)
            return Clutter.EVENT_PROPAGATE;
        // 概览 / 锁屏 / 截图界面里把滚轮让回去
        if (Main.overview.visible || Main.screenShield?.active ||
            Main.screenshotUI?.visible)
            return Clutter.EVENT_PROPAGATE;

        const [x, y] = event.get_coords();
        const zone = this._zoneAt(x, y);
        if (!zone)
            return Clutter.EVENT_PROPAGATE;

        const target = this._cfg.edge[zone];
        if (!target || target === 'none')
            return Clutter.EVENT_PROPAGATE;

        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastTs < (this._cfg.edge.cooldownMs ?? 30))
            return Clutter.EVENT_STOP;

        const notches = this._notches(event);
        if (notches === 0)
            return Clutter.EVENT_PROPAGATE;
        this._lastTs = now;

        const delta = notches * (this._cfg.edge.step ?? 0.05);
        if (target === 'brightness')
            this._brightness?.nudge(delta);
        else if (target === 'volume')
            this._volume?.nudge(delta);

        return Clutter.EVENT_STOP;
    }

    /** 滚轮方向 -> 带符号齿数（向上/向右为正）。 */
    _notches(event) {
        const dir = event.get_scroll_direction();
        if (dir === Clutter.ScrollDirection.UP)
            return 1;
        if (dir === Clutter.ScrollDirection.DOWN)
            return -1;
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = event.get_scroll_delta();
            if (Math.abs(dy) < 0.02)
                return 0;
            // 平滑滚动里向上是负 dy
            return -Math.sign(dy) * Math.min(1, Math.abs(dy) * 2);
        }
        return 0;
    }

    /** 命中的边缘（left/right/top/bottom）或 null。四角归属最近的边。 */
    _zoneAt(x, y) {
        const margin = this._cfg.edge.margin ?? 28;
        for (const monitor of Main.layoutManager.monitors) {
            const inX = x >= monitor.x && x < monitor.x + monitor.width;
            const inY = y >= monitor.y && y < monitor.y + monitor.height;
            if (!inX || !inY)
                continue;

            const dLeft = x - monitor.x;
            const dRight = monitor.x + monitor.width - x;
            const dTop = y - monitor.y;
            const dBottom = monitor.y + monitor.height - y;

            const cands = [
                [dLeft, 'left'], [dRight, 'right'],
                [dTop, 'top'], [dBottom, 'bottom'],
            ].filter(([d]) => d <= margin).sort((a, b) => a[0] - b[0]);

            return cands[0]?.[1] ?? null;
        }
        return null;
    }
}
