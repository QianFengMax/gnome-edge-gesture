import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Config from './lib/config.js';
import * as Log from './lib/logger.js';
import {EdgeWheel} from './lib/edgeWheel.js';
import {GestureEngine} from './lib/gesture.js';
import {OcrRunner} from './lib/ocr.js';
import {StickManager} from './lib/stick.js';
import {grabArea, bytesToFile, tmpPath, copyImage, copyText} from './lib/screenshot.js';

export default class EdgeGestureExtension extends Extension {
    enable() {
        const dir = this.dir.get_path();
        const {config, path} = Config.loadConfig(dir);
        this._cfg = config;
        this._dir = dir;
        Log.init(!!config.debug, GLib.build_filenamev([dir, 'debug.log']));
        Log.log('启用', path);

        this._ocr = new OcrRunner(config.ocr);
        this._popup = null;
        this._popupGrab = null;

        this._sticks = new StickManager({opacity: config.stick?.opacity ?? 240});
        this._sticks.enable();

        this._wheel = new EdgeWheel(config);
        this._wheel.enable();

        this._gesture = new GestureEngine(config, {
            onRectangle: (rect, action) => this._onRectangle(rect, action),
            onTemplate: (name, action) => this._onTemplate(name, action),
        });
        this._gesture.isPointerOverOwnActor = () => {
            const [px, py] = global.get_pointer();
            const x = Math.round(px);
            const y = Math.round(py);
            if (this._popup && x >= this._popup.x && x < this._popup.x + this._popup.width &&
                y >= this._popup.y && y < this._popup.y + this._popup.height)
                return true;
            return this._sticks?.hitTest(x, y) ?? false;
        };
        this._gesture.enable();

        this._loadStyle();
    }

    disable() {
        this._gesture?.disable();
        this._gesture = null;
        this._wheel?.disable();
        this._wheel = null;
        this._sticks?.disable();
        this._sticks = null;
        this._closePopup();
        this._unloadStyle();
        Log.log('已禁用');
        Log.init(false, null);
    }

    // ---- 样式 ----
    _loadStyle() {
        try {
            this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            const css = GLib.build_filenamev([this._dir, 'stylesheet.css']);
            this._theme.load_stylesheet(Gio.File.new_for_path(css));
            this._cssPath = css;
        } catch (e) {
            Log.log('加载样式失败', e.message);
        }
    }

    _unloadStyle() {
        if (!this._cssPath)
            return;
        try {
            this._theme?.unload_stylesheet(Gio.File.new_for_path(this._cssPath));
        } catch {
            // ignore
        }
        this._cssPath = null;
        this._theme = null;
    }

    // ---- 手势动作 ----
    async _onRectangle(rect, action) {
        Log.log('矩形动作', action);
        if (!action || action === 'none')
            return;
        try {
            const bytes = await grabArea(rect.bbox.x, rect.bbox.y,
                rect.bbox.w, rect.bbox.h);
            copyImage(bytes);

            if (action === 'stick') {
                this._sticks.add(bytes, rect.bbox, {opacity: this._cfg.stick?.opacity ?? 240});
            } else if (action === 'ocr') {
                await this._runOcr(bytes, rect.bbox);
            }
        } catch (e) {
            Log.log('矩形动作失败', e.message);
            Main.notify('截图失败', e.message);
        }
    }

    _onTemplate(name, action) {
        Log.log('模板动作', name, action);
        Main.notify('手势', `${name} → ${action}`);
    }

    async _runOcr(bytes, bbox) {
        if (!this._ocr.available) {
            Main.notify('OCR 未配置', this._cfg.ocr.script || '（缺少 python/script 路径）');
            return;
        }
        const path = tmpPath(`ocr-${Date.now()}.png`);
        bytesToFile(bytes, path);
        try {
            const text = await this._ocr.run(path, this._cfg.ocr.lang ?? 'chi_sim+eng');
            if (!text) {
                Main.notify('OCR 无结果', '框选区域没有识别到文字');
                return;
            }
            if (this._cfg.ocr.copyText)
                copyText(text);
            this._showOcrPopup(text);
        } catch (e) {
            Log.log('OCR 出错', e.message);
            Main.notify('OCR 失败', e.message);
        } finally {
            try {
                Gio.File.new_for_path(path).delete(null);
            } catch {
                // ignore
            }
        }
    }

    /** 结果浮层：stage.grab 取键盘焦点，Esc 关闭。 */
    _showOcrPopup(text) {
        this._closePopup();

        const box = new St.BoxLayout({
            style_class: 'edgegesture-ocr',
            vertical: true,
            reactive: true,
            can_focus: true,
        });
        box.add_child(new St.Label({
            style_class: 'edgegesture-ocr-header',
            text: 'OCR 结果（已复制到剪贴板，Esc 或点击关闭）',
        }));

        const scroll = new St.ScrollView({
            style_class: 'edgegesture-ocr-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        const label = new St.Label({
            style_class: 'edgegesture-ocr-text',
            text,
            x_expand: true,
            reactive: true,
        });
        label.clutter_text?.set_line_wrap(true);
        label.clutter_text?.set_selectable?.(true);
        scroll.add_child(label);
        box.add_child(scroll);

        const w = Math.min(760, Math.round(global.stage.width * 0.6));
        const h = Math.min(520, Math.round(global.stage.height * 0.5));
        box.set_size(w, h);
        box.set_position(
            Math.round((global.stage.width - w) / 2),
            Math.round((global.stage.height - h) / 2));

        Main.uiGroup.add_child(box);
        this._popup = box;
        this._popupGrab = global.stage.grab(box);
        // 外部直接 destroy 这个 actor 时也要把 grab 收回，
        // 否则 grab 会一直吃事件，手势和边缘滚轮全部失灵。
        box.connect('destroy', () => {
            try {
                this._popupGrab?.dismiss();
            } catch {
                // 已释放
            }
            this._popupGrab = null;
            if (this._popup === box)
                this._popup = null;
        });

        box.connect('key-press-event', (_a, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closePopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // 点一下窗口外也关掉：和系统弹窗一致，也让 grab 尽早释放
        box.connect('captured-event', (_a, event) => {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                return Clutter.EVENT_PROPAGATE;
            const [px, py] = event.get_coords();
            const inside = px >= box.x && px < box.x + box.width &&
                py >= box.y && py < box.y + box.height;
            if (!inside) {
                this._closePopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        box.connect('button-press-event', () => {
            this._closePopup();
            return Clutter.EVENT_STOP;
        });
        Log.log('OCR 结果已展示', text.length, '字符');
    }

    _closePopup() {
        if (!this._popup)
            return;
        try {
            this._popupGrab?.dismiss();
        } catch {
            // 已释放
        }
        this._popupGrab = null;
        this._popup.destroy();
        this._popup = null;
    }
}