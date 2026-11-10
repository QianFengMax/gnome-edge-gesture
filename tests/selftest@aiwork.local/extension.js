// 注入式端到端自测：只在隔离的 headless gnome-shell 里跑。
// 覆盖：逆时针画框 -> 贴图；顺时针画框 -> OCR；左右边缘滚轮 -> 亮度/音量。
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const ROOT = '/home/username/AIWORK/项目-projects/gnome-edge-gesture';
const OUT = ROOT + '/.tmp/nested/selftest.txt';

let _fail = 0;

function report(line) {
    const stamp = GLib.DateTime.new_now_local().format('%H:%M:%S.%f');
    console.log('[selftest] ' + line);
    try {
        const out = Gio.File.new_for_path(OUT).append_to(Gio.FileCreateFlags.NONE, null);
        out.write_all(stamp + ' ' + line + '\n', null);
        out.close(null);
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
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

export default class SelfTest extends Extension {
    enable() {
        this._dev = null;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._boot().catch(e => report('BOOT ERROR ' + e.message + '\n' + e.stack));
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._dev = null;
    }

    async _boot() {
        const seat = Clutter.get_default_backend().get_default_seat();
        this._dev = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        report('虚拟指针已创建，stage=' + global.stage.width + 'x' + global.stage.height);
        await sleep(2500);

        // 第一个 notify_absolute_motion 的 y 会被丢掉，先空打一次把指针钉住
        this._move(400, 300);
        await sleep(200);
        this._move(600, 400);
        await sleep(200);

        this._resetEnv();
        await sleep(800);
        report('基线 亮度=' + this._brightness() + ' 音量=' + this._volume());

        await this._rectCase();
        await this._wheelCase();
        report(`selftest 结束，失败 ${_fail} 项`);
    }

    _t() {
        return GLib.get_monotonic_time();
    }

    _move(x, y) {
        this._dev.notify_absolute_motion(this._t(), x, y);
    }

    _btn(button, down) {
        this._dev.notify_button(this._t(), button,
            down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
    }

    _resetEnv() {
        const spawn = argv => {
            try {
                Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            } catch {
                // ignore
            }
        };
        spawn(['gdbus', 'call', '--system',
            '--dest', 'org.freedesktop.login1',
            '--object-path', '/org/freedesktop/login1/session/auto',
            '--method', 'org.freedesktop.login1.Session.SetBrightness',
            'backlight', 'ktz8866-backlight', '900']);
        spawn(['wpctl', 'set-mute', '@DEFAULT_AUDIO_SINK@', '0']);
        spawn(['wpctl', 'set-volume', '@DEFAULT_AUDIO_SINK@', '0.4']);
    }

    _brightness() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(
                '/sys/class/backlight/ktz8866-backlight/brightness').load_contents(null);
            return ok ? new TextDecoder().decode(bytes).trim() : 'n/a';
        } catch {
            return 'n/a';
        }
    }

    _volume() {
        try {
            const proc = Gio.Subprocess.new(['wpctl', 'get-volume', '@DEFAULT_AUDIO_SINK@'],
                Gio.SubprocessFlags.STDOUT_PIPE);
            const [, out] = proc.communicate_utf8(null, null);
            return out.trim();
        } catch (e) {
            return 'n/a: ' + e.message;
        }
    }

    _visibleSticks() {
        let n = 0;
        for (const c of Main.uiGroup.get_children()) {
            if (c.style_class === 'edgegesture-stick' && c.visible)
                n++;
        }
        return n;
    }

    async _rectCase() {
        // 逆时针画框 -> 贴图
        const before = this._visibleSticks();
        await this._drawRect(1100, 650, 320, 220, false);
        await sleep(1500);
        const afterCcw = this._visibleSticks();
        report(`逆时针后可见贴图 ${before} -> ${afterCcw}`);
        check(afterCcw === before + 1, '逆时针画框 -> 贴图');

        // 在贴图中心点右键关闭
        for (const c of Main.uiGroup.get_children()) {
            if (c.style_class !== 'edgegesture-stick' || !c.visible)
                continue;
            const cx = Math.round(c.x + c.width / 2);
            const cy = Math.round(c.y + c.height / 2);
            for (let k = 0; k < 5; k++) {
                this._move(cx - 40 + k * 20, cy - 40 + k * 20);
                await sleep(70);
            }
            this._btn(3, true);
            await sleep(150);
            this._btn(3, false);
            await sleep(200);
        }
        this._move(760, 400);
        await sleep(1000);
        report('右键关闭后可见贴图 ' + this._visibleSticks());
        check(this._visibleSticks() === 0, '贴图上右键 -> 关闭');

        // 贴图关闭后 Clutter 需要一次完整的 enter 才会恢复投递，先划一下桌面
        for (let k = 0; k < 5; k++) {
            this._move(700 + k * 8, 420 + k * 8);
            await sleep(80);
        }
        await sleep(400);

        // 顺时针画框 -> OCR
        // headless 虚拟屏本身没有文字，先放一块已知文案进去，截图才有东西可识别
        this._label = new St.Label({
            style_class: 'edgegesture-ocr-text',
            text: '边缘手势 OCR 自测 Label 42',
        });
        this._label.set_position(320, 260);
        this._label.clutter_text?.set_line_wrap(false);
        Main.uiGroup.add_child(this._label);
        await sleep(500);

        await this._drawRect(300, 200, 420, 240, true);
        await sleep(4500);
        const popup = Main.uiGroup.get_children()
            .find(c => c.style_class === 'edgegesture-ocr');
        check(!!popup, '顺时针画框 -> OCR 弹窗');
        if (popup) {
            const texts = [];
            const walk = a => {
                if (a.text)
                    texts.push(a.text);
                for (const ch of a.get_children?.() ?? [])
                    walk(ch);
            };
            walk(popup);
            const shown = texts.slice(-1).join('').replace(/\s+/g, ' ');
            report('  OCR 文本: ' + shown.slice(0, 120));
            check(/42|OCR|边缘/.test(shown), 'OCR 识别出屏幕上的文字');
            popup.destroy();
            await sleep(400);
        }

        if (this._label) {
            this._label.destroy();
            this._label = null;
            await sleep(300);
        }
    }

    async _wheelCase() {
        const b0 = parseInt(this._brightness(), 10);
        for (let i = 0; i < 3; i++) {
            this._move(6, 500);
            await sleep(60);
            this._dev.notify_discrete_scroll(this._t(),
                Clutter.ScrollDirection.UP, Clutter.ScrollSource.WHEEL);
            await sleep(160);
        }
        await sleep(600);
        const b1 = parseInt(this._brightness(), 10);
        report(`左边缘滚轮 亮度 ${b0} -> ${b1}`);
        check(b1 > b0, '左边缘滚轮 -> 亮度上升');

        const v0 = parseFloat((this._volume().match(/([0-9.]+)/) ?? [])[1] ?? 'NaN');
        for (let i = 0; i < 3; i++) {
            this._move(1590, 500);
            await sleep(60);
            this._dev.notify_discrete_scroll(this._t(),
                Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL);
            await sleep(160);
        }
        await sleep(600);
        const v1 = parseFloat((this._volume().match(/([0-9.]+)/) ?? [])[1] ?? 'NaN');
        report(`右边缘滚轮 音量 ${v0} -> ${v1}`);
        check(v1 < v0, '右边缘滚轮 -> 音量下降');
    }

    async _drawRect(x, y, w, h, clockwise) {
        const steps = 16;
        const corners = clockwise
            ? [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
            : [[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]];

        this._move(corners[0][0], corners[0][1]);
        await sleep(100);
        this._btn(3, true);
        await sleep(200);
        for (let i = 0; i < corners.length - 1; i++) {
            const [x1, y1] = corners[i];
            const [x2, y2] = corners[i + 1];
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                this._move(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
                await sleep(14);
            }
        }
        await sleep(100);
        this._btn(3, false);
    }
}