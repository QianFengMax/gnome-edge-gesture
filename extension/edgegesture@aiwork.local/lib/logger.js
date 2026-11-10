import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _enabled = false;
let _path = null;

export function init(enabled, path) {
    _enabled = enabled;
    _path = path;
}

export function log(...args) {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    if (_enabled) {
        const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S');
        log_console(`[edgegesture ${stamp}] ${line}`);
        if (_path) {
            try {
                const out = Gio.File.new_for_path(_path)
                    .append_to(Gio.FileCreateFlags.NONE, null);
                out.write_all(`[${stamp}] ${line}\n`, null);
                out.close(null);
            } catch {
                // 日志失败不影响功能
            }
        }
    }
}

function log_console(s) {
    console.log(s);
}
