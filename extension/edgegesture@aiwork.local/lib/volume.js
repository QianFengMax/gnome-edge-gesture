import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import * as Log from './logger.js';

const ICONS = [
    'audio-volume-muted-symbolic',
    'audio-volume-low-symbolic',
    'audio-volume-medium-symbolic',
    'audio-volume-high-symbolic',
    'audio-volume-overamplified-symbolic',
];

/** 音量控制：复用 shell 的 Gvc 混音器单例，OSD 与原生一致。 */
export class VolumeControl {
    constructor() {
        this._control = getMixerControl();
        this._ready = false;
        this._pending = 0;
        this._control.connectObject('state-changed', () => {
            if (this._control.get_state() === Gvc.MixerControlState.READY) {
                this._ready = true;
                this._flush();
            }
        }, this);
        this._ready = this._control.get_state() === Gvc.MixerControlState.READY;
    }

    get available() {
        return this._ready && !!this._control.get_default_sink();
    }

    get value() {
        const sink = this._control.get_default_sink();
        if (!sink)
            return 0;
        if (sink.is_muted)
            return 0;
        return sink.volume / this._control.get_vol_max_norm();
    }

    set value(v) {
        const sink = this._control.get_default_sink();
        if (!sink)
            return;
        const max = this._control.get_vol_max_norm();
        const clamped = Math.clamp(v, 0, 1);
        const volume = clamped * max;
        const wasMuted = sink.is_muted;
        sink.set_volume(volume < 1 ? 0 : volume);
        if (volume < 1 && !wasMuted)
            sink.change_is_muted(true);
        else if (volume >= 1 && wasMuted)
            sink.change_is_muted(false);
        sink.push_volume();
    }

    async nudge(delta) {
        if (!this._ready) {
            this._pending = Math.clamp(this._pending + delta, -1, 1);
            return false;
        }
        const before = this.value;
        this.value = before + delta;
        const after = this.value;
        this._showOsd(after);
        return Math.abs(after - before) > 1e-4;
    }

    _flush() {
        if (this._pending) {
            const d = this._pending;
            this._pending = 0;
            this.value = this.value + d;
        }
    }

    _showOsd(level) {
        const sink = this._control.get_default_sink();
        let idx = 0;
        if (sink && !sink.is_muted && level > 0)
            idx = Math.clamp(Math.ceil(3 * level), 1, ICONS.length - 1);
        const gicon = Gio.ThemedIcon.new(ICONS[idx]);
        const maxLevel = this._control.get_vol_max_amplified() /
            this._control.get_vol_max_norm();
        try {
            Main.osdWindowManager.showAll(gicon, null, level, Math.max(1, maxLevel));
        } catch (e) {
            Log.warn('音量 OSD 失败', e.message);
        }
    }

    destroy() {
        this._control?.disconnectObject(this);
        this._control = null;
    }
}
