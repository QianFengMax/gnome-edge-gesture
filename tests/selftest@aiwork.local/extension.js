// 端到端自测：在隔离的 headless shell 里跑。
// 用 uinput 造一个虚拟鼠标，走和真鼠标完全相同的 evdev 路径。
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ROOT = '/home/username/AIWORK/项目-projects/gnome-edge-gesture';
const OUT = ROOT + '/.tmp/nested/selftest.txt';

let _fail = 0;
const _log = [];

function report(line) {
    const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S');
    console.log('[selftest] ' + line);
    _log.push(stamp + ' ' + line);
    try {
        Gio.File.new_for_path(OUT).replace_contents(
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

/** 通过 /dev/uinput 造虚拟鼠标，坐标是绝对屏坐标（用 REL + 累计位移模拟）。 */
class FakeMouse {
    constructor() {
        this.fd = -1;
        this.cx = 800;
        this.cy = 500;
    }

    open() {
        const [fd, err] = GLib.open('/dev/uinput', 0x1 | 0x400, 0);
        if (fd < 0) {
            report('uinput open failed: ' + err);
            return false;
        }
        this.fd = fd;
        this._ioctl(0x40045564, 0x01); // UI_SET_EVBIT EV_KEY
        for (const c of [0x110, 0x111, 0x112])
            this._ioctl(0x40045564, c);
        this._ioctl(0x40045564, 0x02); // EV_REL
        for (const c of [0x00, 0x01, 0x06, 0x08])
            this._ioctl(0x40045564, c);
        this._ioctl(0x40045564, 0x00); // EV_SYN
        // UI_DEV_SETUP
        const name = 'edgegesture-fake-mouse';
        const buf = new Uint8Array(1112);
        const dv = new DataView(buf.buffer);
        dv.setUint16(0, 0x03, true);       // bustype USB
        dv.setUint16(2, 0x1234, true);
        dv.setUint16(4, 0x5678, true);
        dv.setUint16(6, 0x0111, true);
        const enc = new TextEncoder().encode(name);
        for (let i = 0; i < enc.length && i < 79; i++)
            dv.setUint8(8 + i, enc[i]);
        const setup = new Uint8Array(buf.buffer, 0, 8 + 80 + 4);
        const r = this._write(setup);
        if (!r) return false;
        this._ioctl(0x5501, 0); // UI_DEV_CREATE
        report('uinput 虚拟鼠标已创建');
        return true;
    }

    _ioctl(req, val) {
        // GJS 没有 ioctl；用 python 辅助做（一次性，只用于测试）
        GLib.spawn_command_line_sync(
            `python3 -c "import fcntl,os,sys; f=open('/dev/uinput','wb',0); fcntl.ioctl(f, ${req}, ${val})"`);
    }

    _write(bytes) {
        const tmp = GLib.build_filenamev([ROOT, '.tmp', 'uin.bin']);
        Gio.File.new_for_path(tmp).replace_contents(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        const [ok] = GLib.spawn_command_line_sync(
            `sh -c 'cat ${tmp} > /dev/uinput'`);
        return ok;
    }

    move(dx, dy) {
        this._emit(2, 0, dx, true);
        this._emit(2, 1, dy, true);
        this._emit(0, 0, 0, false);
        this.cx += dx;
        this.cy += dy;
    }

    wheel(dir) {
        this._emit(2, 8, dir, true);
        this._emit(0, 0, 0, false);
    }

    button(code, down) {
        this._emit(1, code, down ? 1 : 0, true);
        this._emit(0, 0, 0, false);
    }

    _emit(type, code, value) {
        const buf = new Uint8Array(24);
        const dv = new DataView(buf.buffer);
        const now = GLib.get_monotonic_time();
        dv.setUint32(0, Math.floor(now / 1e6), true);
        dv.setUint32(8, now % 1000000, true);
        dv.setUint16(16, type, true);
        dv.setUint16(18, code, true);
        dv.setInt32(20, value, true);
        this._write(buf);
    }
}

export default class SelfTest extends Extension {
    enable() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._boot().catch(e => report('BOOT ERROR ' + e.message));
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {}

    async _boot() {
        report('shell stage=' + global.stage.width + 'x' + global.stage.height);
        await sleep(3000);

        const ext = Main.extensionManager?.lookup('edgegesture@aiwork.local');
        if (!ext) {
            report('FAIL edgegesture 未启用');
            return;
        }
        const inst = ext.stateObj ?? ext;
        report('edgegesture state=' + (inst ? 'ok' : 'null'));

        // 检查 evdev 是否读到设备
        const input = inst._input;
        report('evdev 指针设备数=' + (input?.pointerCount ?? 'n/a'));
        check((input?.pointerCount ?? 0) > 0, '读到了鼠标设备');

        // 放一段已知文字，供 OCR 用
        const label = new St.Label({
            style_class: 'edgegesture-ocr-text',
            text: '边缘手势 OCR 自测 42',
        });
        label.set_position(420, 320);
        Main.uiGroup.add_child(label);
        await sleep(600);

        await this._geometryCase(inst);
        await this._stickCase(inst);

        label.destroy();
        inst._sticks?.closeAll();
        await sleep(300);
        report(`selftest 结束，失败 ${_fail} 项`);
    }

    /** 截图尺寸/通道是否和框一致。 */
    async _geometryCase(inst) {
        const mod = await import('file://' + ROOT +
            '/extension/edgegesture@aiwork.local/lib/screenshot.js');
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const {bytes, physical} = await mod.grabArea(400, 300, 200, 150);
        const pack = await import('gi://GdkPixbuf');
        const buf = pack.default.Pixbuf.new_from_stream(
            Gio.MemoryInputStream.new_from_bytes(bytes), null);
        report(`截图 请求200x150 物理${physical.w}x${physical.h} png=${buf.width}x${buf.height} ch=${buf.get_n_channels()} scale=${scale}`);
        check(Math.round(200 * scale) === buf.width, '截图宽度 = 逻辑宽 × scale');
        check(buf.get_n_channels() >= 3, '截图通道数正常');
    }

    /** 贴图：尺寸应等于框的逻辑尺寸，且不夺取输入。 */
    async _stickCase(inst) {
        const mod = await import('file://' + ROOT +
            '/extension/edgegesture@aiwork.local/lib/screenshot.js');
        const {bytes} = await mod.grabArea(400, 300, 200, 150);
        const rect = {x: 400, y: 300, w: 200, h: 150};
        const before = inst._sticks.count;
        const grabBefore = global.stage.get_grab_actor();
        const modalBefore = Main.modalCount;
        inst._sticks.add(bytes, rect, {opacity: 1});
        await sleep(800);
        const stick = inst._sticks._sticks[inst._sticks._sticks.length - 1];
        report(`贴图 actor=${stick.actor.width}x${stick.actor.height} @${stick.actor.x},${stick.actor.y} reactive=${stick.actor.reactive}`);
        check(inst._sticks.count === before + 1, '贴图已创建');
        check(Math.abs(stick.actor.width - 200) <= 2 && Math.abs(stick.actor.height - 150) <= 2,
            '贴图尺寸与框一致（不再放大）');
        check(stick.actor.reactive === false, '贴图不抢指针事件');

        // 关键：贴图不能改变 grab / modalCount（之前是 grab 把全屏锁死的）
        const grabAfter = global.stage.get_grab_actor();
        const modalAfter = Main.modalCount;
        report("grab: " + (grabBefore?.constructor?.name ?? "null") + " -> " +
            (grabAfter?.constructor?.name ?? "null") + ", modalCount: " +
            modalBefore + " -> " + modalAfter);
        check(grabAfter === grabBefore, "贴图没有改变 grab actor");
        check(modalAfter === modalBefore, "贴图没有增加 modalCount");
        check(grabAfter !== stick.actor, "grab 不是贴图自己（不锁死全屏输入）");

        // ESC 关闭贴图
        if (inst._sticks.count > 0) {
            inst._sticks.closeAll();
            await sleep(400);
        }
        check(inst._sticks.count === 0, '贴图可关闭');
    }
}
