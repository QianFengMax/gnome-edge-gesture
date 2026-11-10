import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const LOG_PATH = '/home/username/AIWORK/项目-projects/gnome-edge-gesture/extension/probe/probe.log';

export default class EdgeProbeExtension extends Extension {
    enable() {
        this._stageId = global.stage.connect('captured-event',
            (_a, event) => this._onEvent('stage-captured', event));
        this._displayId = global.display.connect('grab-op-begin', (_d, win, op) => {
            this._log(`grab-op-begin win=${win?.get_wm_class()} op=${op}`);
        });
        this._log('probe enabled; monitors=' +
            Main.layoutManager.monitors.map(m =>
                `${m.x},${m.y} ${m.width}x${m.height}@${m.geometry_scale ?? '?'}`).join(' | '));
    }

    disable() {
        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
        if (this._displayId) {
            global.display.disconnect(this._displayId);
            this._displayId = 0;
        }
        this._log('probe disabled');
    }

    _onEvent(tag, event) {
        const t = event.type();
        if (t === Clutter.EventType.MOTION)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        let extra = '';
        if (t === Clutter.EventType.SCROLL) {
            const dir = event.get_scroll_direction();
            extra = ` dir=${dir} delta=${JSON.stringify(event.get_scroll_delta())}`;
        } else if (t === Clutter.EventType.BUTTON_PRESS || t === Clutter.EventType.BUTTON_RELEASE) {
            extra = ` button=${event.get_button()}`;
        }
        this._log(`${tag} type=${t}${extra} at=${x | 0},${y | 0} pointer=${JSON.stringify(global.get_pointer().slice(0, 2))}`);
        return Clutter.EVENT_PROPAGATE;
    }

    _log(line) {
        const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S.%f');
        const msg = `[${stamp}] ${line}\n`;
        log(`[edgeprobe] ${line}`);
        try {
            const f = Gio.File.new_for_path(LOG_PATH);
            const out = f.append_to(Gio.FileCreateFlags.NONE, null);
            out.write_all(msg, null);
            out.close(null);
        } catch (e) {
            logError(e, 'edgeprobe write');
        }
    }
}
