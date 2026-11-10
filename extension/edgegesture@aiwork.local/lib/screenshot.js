import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Log from './logger.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');

/**
 * 截取一块区域，返回 PNG 字节。
 *
 * Shell.Screenshot.screenshot_area 吃的是**物理像素**（和 shell 内部的
 * _scaleArea 一致），而界面坐标是逻辑像素，这里显式换算。
 */
export async function grabArea(x, y, w, h) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const px = Math.round(x * scale);
    const py = Math.round(y * scale);
    const pw = Math.max(1, Math.round(w * scale));
    const ph = Math.max(1, Math.round(h * scale));

    const stream = Gio.MemoryOutputStream.new_resizable();
    const shooter = new Shell.Screenshot();
    await shooter.screenshot_area(px, py, pw, ph, stream);
    stream.close(null);
    const bytes = stream.steal_as_bytes();

    Log.debug('截图 逻辑(' + x + ',' + y + ' ' + w + 'x' + h + ') -> 物理(' +
        px + ',' + py + ' ' + pw + 'x' + ph + ') scale=' + scale +
        ' png=' + bytes.get_size() + 'B');
    return {bytes, scale, physical: {x: px, y: py, w: pw, h: ph}};
}

/**
 * PNG 字节 -> {content, width, height}，尺寸为物理像素。
 *
 * 关键修复：截图出来通常是 3 通道 RGB，直接 read_pixel_bytes 再按 RGBA_8888
 * 解释会通道错位，画面发暗（之前「贴图比窗口黑」的根因）。
 */
export function imageContentFromBytes(bytes) {
    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    let pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
    stream.close(null);

    if (pixbuf.get_n_channels() !== 4)
        pixbuf = pixbuf.add_alpha(false, 0, 0, 0);

    const cogl = global.stage.context.get_backend().get_cogl_context();
    const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
    const ok = content.set_bytes(cogl,
        pixbuf.read_pixel_bytes(),
        Cogl.PixelFormat.RGBA_8888,
        pixbuf.width, pixbuf.height, pixbuf.rowstride);

    if (!ok)
        Log.error('ImageContent.set_bytes 失败');

    return {content, width: pixbuf.width, height: pixbuf.height};
}

export function bytesToFile(bytes, path) {
    Gio.File.new_for_path(path).replace_contents(bytes.get_data(), null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
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
