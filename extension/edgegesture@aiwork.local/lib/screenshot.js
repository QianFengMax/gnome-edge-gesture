import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Log from './logger.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');

/** 逻辑坐标 -> 输出 PNG 字节。 */
export async function grabArea(x, y, w, h) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const stream = Gio.MemoryOutputStream.new_resizable();
    const shooter = new Shell.Screenshot();
    await shooter.screenshot_area(
        Math.round(x * scale), Math.round(y * scale),
        Math.round(w * scale), Math.round(h * scale),
        stream);
    stream.close(null);
    return stream.steal_as_bytes();
}

export function bytesToFile(bytes, path) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(bytes.get_data(), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return file;
}

export function tmpPath(name) {
    const dir = GLib.build_filenamev([GLib.get_tmp_dir(), 'edgegesture']);
    GLib.mkdir_with_parents(dir, 0o700);
    return GLib.build_filenamev([dir, name]);
}

export function copyImage(bytes) {
    St.Clipboard.get_default().set_content(
        St.ClipboardType.CLIPBOARD, 'image/png', bytes);
}

export function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

export function log(...a) {
    Log.log(...a);
}
