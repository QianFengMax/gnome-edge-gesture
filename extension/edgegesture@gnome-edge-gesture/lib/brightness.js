import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';

const OSD_ICON = 'display-brightness-symbolic';
const BACKLIGHT_DIR = '/sys/class/backlight';

/**
 * 亮度控制，三级后端（按优先级自动降级）：
 *  1. Main.brightnessManager —— Mutter 背光对象，走合成器，自动弹原生 OSD
 *  2. org.freedesktop.login1 Session.SetBrightness —— 无需 root，seat 会话即可
 *  3. sysfs 直写 /sys/class/backlight/&lt;dev&gt;/brightness，需要 input/video 组或 udev 规则
 */
export class BrightnessControl {
    constructor() {
        this._manager = Main.brightnessManager ?? null;
        this._device = BrightnessControl._findDevice();
        this._logindChecked = false;
        this._logindOk = false;
        this._logind = null;
        this._last = null;

        if (!this._manager?.globalScale)
            this._tryLogind();
    }

    get backend() {
        if (this._manager?.globalScale)
            return 'mutter';
        if (this._logindOk)
            return 'logind';
        if (this._device?.writable)
            return 'sysfs';
        return 'none';
    }

    get available() {
        return this.backend !== 'none';
    }

    get value() {
        if (this._manager?.globalScale)
            return this._manager.globalScale.value;
        if (this._last !== null)
            return this._last;
        const d = this._device;
        if (!d)
            return 1;
        return BrightnessControl._readRaw(d) / d.max;
    }

    set value(v) {
        const clamped = Math.clamp(v, 0.02, 1);
        this._last = clamped;

        if (this._manager?.globalScale) {
            this._manager.globalScale.value = clamped;
            return;
        }
        const d = this._device;
        if (!d)
            return;
        const raw = Math.max(1, Math.round(clamped * d.max));

        if (this._logindOk) {
            this._setViaLogind(d.name, raw);
            return;
        }
        if (d.writable) {
            BrightnessControl._writeRaw(d, raw);
            return;
        }
        Log.info('亮度后端不可用，跳过写入');
    }

    nudge(delta) {
        const before = this.value;
        this.value = before + delta;
        const after = this.value;
        if (this.backend !== 'mutter')
            this._showOsd(after);
        return Math.abs(after - before) > 1e-4;
    }

    // ---- logind ----
    // 注意：CanSetBrightness 常被 D-Bus 策略拒（AccessDenied），
    // 但 SetBrightness 本身对 seat 会话是放行的，所以直接试写同一个值来探测。
    _tryLogind() {
        if (this._logindChecked)
            return;
        this._logindChecked = true;
        const d = this._device;
        if (!d)
            return;
        try {
            const proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.login1', '/org/freedesktop/login1/session/auto',
                'org.freedesktop.login1.Session', null);
            const probe = Math.max(1, BrightnessControl._readRaw(d));
            proxy.call_sync('SetBrightness',
                new GLib.Variant('(ssu)', ['backlight', d.name, probe]),
                Gio.DBusCallFlags.NONE, 800, null);
            this._logind = proxy;
            this._logindOk = true;
            Log.info('logind SetBrightness 可用');
        } catch (e) {
            Log.warn('logind 不可用，继续尝试 sysfs', e.message);
        }
    }

    _setViaLogind(name, raw) {
        try {
            this._logind.call_sync('SetBrightness',
                new GLib.Variant('(ssu)', ['backlight', name, raw]),
                Gio.DBusCallFlags.NONE, 800, null);
        } catch (e) {
            Log.warn('logind SetBrightness 失败，降级 sysfs', e.message);
            this._logindOk = false;
            if (this._device?.writable)
                BrightnessControl._writeRaw(this._device, raw);
        }
    }

    _showOsd(level) {
        try {
            Main.osdWindowManager.showAll(
                Gio.ThemedIcon.new(OSD_ICON), null, level, 1.0);
        } catch (e) {
            Log.warn('OSD 失败', e.message);
        }
    }

    // ---- 设备发现 ----
    static _findDevice() {
        let best = null;
        try {
            const dir = Gio.File.new_for_path(BACKLIGHT_DIR);
            const en = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const name = info.get_name();
                const base = `${BACKLIGHT_DIR}/${name}`;
                try {
                    const max = BrightnessControl._readInt(`${base}/max_brightness`);
                    if (!(max > 0))
                        continue;
                    const writable = BrightnessControl._canWrite(`${base}/brightness`);
                    const type = BrightnessControl._readText(`${base}/type`).trim();
                    const cand = {name, base, max, writable, type};
                    // 优先 raw/firmware 类型，其次能写的
                    const score = (writable ? 2 : 0) + (type === 'raw' ? 1 : 0);
                    if (!best || score > best.score)
                        best = {...cand, score};
                } catch {
                    continue;
                }
            }
        } catch (e) {
            Log.warn('枚举 backlight 失败', e.message);
        }
        if (best) {
            delete best.score;
            Log.info('backlight 设备', best.name, 'max=' + best.max,
                'writable=' + best.writable, 'type=' + best.type);
        }
        return best;
    }

    static _readInt(path) {
        return parseInt(BrightnessControl._readText(path).trim(), 10) || 0;
    }

    static _readText(path) {
        try {
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            return ok ? new TextDecoder().decode(bytes) : '';
        } catch {
            return '';
        }
    }

    static _canWrite(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info('access::can-write',
                Gio.FileQueryInfoFlags.NONE, null);
            return info.get_attribute_boolean('access::can-write');
        } catch {
            return false;
        }
    }

    static _readRaw(d) {
        return BrightnessControl._readInt(`${d.base}/brightness`);
    }

    static _writeRaw(d, raw) {
        try {
            Gio.File.new_for_path(`${d.base}/brightness`).replace_contents(
                String(raw), null, false, Gio.FileCreateFlags.NONE, null);
        } catch (e) {
            Log.warn('sysfs 写入失败', e.message);
        }
    }
}
/** brightnessManager 在部分会话里是懒加载的，这里只做存在性兜底。 */
export function ensureManager() {
    try {
        if (!Main.brightnessManager)
            Log.info('brightnessManager 尚未就绪，等待 shell 初始化');
        return Main.brightnessManager ?? null;
    } catch (e) {
        Log.warn('brightnessManager 访问失败', e.message);
        return null;
    }
}
