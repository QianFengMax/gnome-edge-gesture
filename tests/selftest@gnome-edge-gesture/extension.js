// 端到端自测：在隔离的 headless shell 里跑（每次全新加载，不受模块缓存影响）。
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// 首次 enable 时从 this.dir 推导项目根
let ROOT = '';
let EXT = '';
function outPath() { return ROOT + '/.tmp/nested/selftest.txt'; }

let _fail = 0;
const _log = [];

function report(line) {
    const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S');
    console.log('[selftest] ' + line);
    _log.push(stamp + ' ' + line);
    try {
        Gio.File.new_for_path(outPath()).replace_contents(
            _log.join('\n') + '\n', null, false, Gio.FileCreateFlags.NONE, null);
    } catch {
        // ignore
    }
}

function check(cond, label) {
    report((cond ? 'PASS ' : 'FAIL ') + label);
    if (!cond)
        _fail++;
}

function sleep(ms) {
    return new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        r();
        return GLib.SOURCE_REMOVE;
    }));
}

export default class SelfTest extends Extension {
    enable() {
        // this.dir 可能是符号链接路径，先解析成真实路径
        const d = this.dir.query_info('standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            .get_symlink_target() || this.dir.get_path();
        const real = d.startsWith('/') ? d : GLib.canonicalize_filename(d, '.');
        ROOT = GLib.path_get_dirname(GLib.path_get_dirname(real));
        EXT = ROOT + '/extension/edgegesture@gnome-edge-gesture';
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._boot().catch(e => report('BOOT ERROR ' + e.message));
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}

    async _boot() {
        report('stage=' + global.stage.width + 'x' + global.stage.height);
        await sleep(3000);

        const ext = Main.extensionManager?.lookup('edgegesture@gnome-edge-gesture');
        const inst = (ext?.stateObj ?? ext)?._impl;
        if (!inst) {
            check(false, 'edgegesture 已启用');
            return;
        }
        check(true, 'edgegesture 已启用');
        check((inst._input?.pointerCount ?? 0) > 0,
            '读到鼠标设备（' + (inst._input?.pointerCount ?? 0) + ' 个）');

        await this._wheelCase(inst);
        await this._zoneCase(inst);
        await this._shotCase();
        await this._ocrCase();

        report('selftest 结束，失败 ' + _fail + ' 项');
    }

    /** 滚轮方向符号（核心回归）。 */
    async _wheelCase() {
        const mod = await import('file://' + EXT + '/lib/edgeWheel.js');
        const cd = mod.computeDelta;
        check(typeof cd === 'function', 'computeDelta 已导出');
        if (typeof cd !== 'function')
            return;
        const s = 0.05;
        check(cd('up', 1, s) > 0, 'UP -> 正向 (' + cd('up', 1, s) + ')');
        check(cd('down', 1, s) < 0, 'DOWN -> 负向 (' + cd('down', 1, s) + ')');
        check(cd('up', -1, s) > 0 && cd('down', -1, s) < 0, '负幅度不翻转方向');
        check(cd('left', 1, s) < 0 && cd('right', 1, s) > 0, '左右方向正确');
    }

    /** 边缘判定：四条边 + 四角 + 中间不触发。 */
    async _zoneCase(inst) {
        const w = inst._wheel;
        if (!w) {
            check(false, 'EdgeWheel 实例存在');
            return;
        }
        const mon = [{x: 0, y: 0, w: global.stage.width, h: global.stage.height}];
        const probe = (x, y) => {
            // 直接调用 _zoneAt
            const saved = w._geometry;
            w._geometry = () => ({monitors: mon, pointer: [x, y]});
            const z = w._zoneAt(x, y);
            w._geometry = saved;
            return z;
        };
        const W = global.stage.width;
        const H = global.stage.height;
        check(probe(5, 500) === 'left', '左边缘 -> left');
        check(probe(W - 5, 500) === 'right', '右边缘 -> right');
        check(probe(500, 5) === 'top', '上边缘 -> top');
        check(probe(500, H - 5) === 'bottom', '下边缘 -> bottom');
        check(probe(W / 2, H / 2) === null, '屏幕中间不触发');
        check(probe(120, 500) === null, '离边缘 120px 不触发');
    }

    /** 截图：尺寸必须是 逻辑 × scale。 */
    async _shotCase() {
        const mod = await import('file://' + EXT + '/lib/screenshot.js');
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const {bytes, physical} = await mod.grabArea(400, 300, 200, 150);
        const buf = GdkPixbuf.Pixbuf.new_from_stream(
            Gio.MemoryInputStream.new_from_bytes(bytes), null);
        report('截图 200x150 逻辑 -> ' + buf.width + 'x' + buf.height +
            ' 物理, scale=' + scale + ', ch=' + buf.get_n_channels());
        check(buf.width === Math.round(200 * scale), '截图宽度 = 逻辑宽 × scale');
        check(buf.get_n_channels() >= 3, '截图通道数正常');

        const ic = mod.imageContentFromBytes(bytes);
        report('ImageContent ' + ic.width + 'x' + ic.height);
        check(ic.width === buf.width, 'ImageContent 尺寸与 PNG 一致');
    }

    /** OCR 后端：放一段文字，截下来识别。 */
    async _ocrCase() {
        const label = new St.Label({text: '边缘手势 OCR 自测 42'});
        label.set_position(500, 400);
        Main.uiGroup.add_child(label);
        await sleep(700);

        const shot = await import('file://' + EXT + '/lib/screenshot.js');
        const {bytes} = await shot.grabArea(480, 380, 400, 120);

        const ext = Main.extensionManager?.lookup('edgegesture@gnome-edge-gesture');
        const inst = (ext?.stateObj ?? ext)?._impl;
        const path = shot.tmpPath('selftest-ocr.png');
        shot.bytesToFile(bytes, path);
        try {
            const text = await inst._ocr.run(path, 'chi_sim+eng');
            report('OCR 结果: ' + JSON.stringify(text.slice(0, 60)));
            check(/42|OCR|边缘/.test(text), 'OCR 识别出屏上文字');
        } catch (e) {
            check(false, 'OCR 执行: ' + e.message);
        } finally {
            try {
                Gio.File.new_for_path(path).delete(null);
            } catch {
                // ignore
            }
            label.destroy();
        }
    }
}
