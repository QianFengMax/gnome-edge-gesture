import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Config from './lib/config.js';
import * as Log from './lib/logger.js';
import {InputSource, BUTTONS} from './lib/inputSource.js';
import {EdgeWheel} from './lib/edgeWheel.js';
import {GestureEngine} from './lib/gesture.js';
import {OcrRunner} from './lib/ocr.js';
import {StickManager} from './lib/stick.js';
import {grabArea, bytesToFile, tmpPath, copyImage, copyText} from './lib/screenshot.js';

// 版本戳：日志里能一眼看出 shell 跑的是哪一版代码
// （ESM 模块会被 shell 缓存，改了代码必须重启 shell 才生效）
const BUILD = '2.0-evdev';

const PANEL_ICON = 'input-mouse-symbolic';

export default class EdgeGestureExtension extends Extension {
    enable() {
        const dir = this.dir.get_path();
        this._dir = dir;
        const {config, path} = Config.loadConfig(dir);
        this._cfg = config;

        Log.init(config.debug ? Log.Level.DEBUG : Log.Level.INFO,
            GLib.build_filenamev([dir, 'logs']));
        Log.info('═══ 启用 edgegesture ' + BUILD + ' ═══');
        Log.info('配置:', path, 'debug=' + !!config.debug);
        const env = Config.envSummary();
        Log.info('环境: session=' + env.sessionType + ' desktop=' + env.desktop +
            ' mode=' + env.shell);
        Log.info('日志文件:', Log.logPath());

        try {
            this._boot(dir);
            Log.info('启动完成');
        } catch (e) {
            Log.error('启动失败:', e);
            Main.notify('Edge Gesture 启动失败', e.message);
            this.disable();
        }
    }

    _boot(dir) {
        this._ocr = new OcrRunner(this._cfg.ocr);
        this._popup = null;

        this._sticks = new StickManager({opacity: this._cfg.stick?.opacity ?? 1});
        this._sticks.enable();

        this._wheel = new EdgeWheel(this._cfg, () => this._geometry());
        this._wheel.enable();

        this._gesture = new GestureEngine(this._cfg, {
            onRectangle: (rect, action) => this._onRectangle(rect, action),
        });
        this._gesture.setYieldCheck(() => this._pointerOverOwnActor());
        this._gesture.enable();

        this._input = new InputSource({
            onWheel: (dir, val) => this._onWheel(dir, val),
            onButton: (code, pressed) => this._onButton(code, pressed),
            onMotion: (dx, dy) => this._onMotion(dx, dy),
            onEscape: () => this._onEscape(),
        });
        this._input.enable();

        this._loadStyle();
        Log.info('指针设备数:', this._input.pointerCount);

        if (this._input.pointerCount === 0) {
            Main.notify('Edge Gesture',
                '读不到鼠标设备。请确认在 input 组：sudo usermod -aG input $USER 后重新登录');
        }
    }

    disable() {
        Log.info('─── 禁用 edgegesture ───');
        this._input?.disable();
        this._input = null;
        this._gesture?.disable();
        this._gesture = null;
        this._wheel?.disable();
        this._wheel = null;
        this._sticks?.disable();
        this._sticks = null;
        this._closePopup();
        this._unloadStyle();
        Log.init(Log.Level.INFO, null);
    }

    // ---- 几何 ----

    _geometry() {
        const monitors = Main.layoutManager.monitors.map(m => ({
            x: m.x, y: m.y, w: m.width, h: m.height,
        }));
        const [px, py] = global.get_pointer();
        return {monitors, pointer: [px, py]};
    }

    _pointerOverOwnActor() {
        const [px, py] = global.get_pointer();
        const x = Math.round(px);
        const y = Math.round(py);
        if (this._popup && this._popupBounds &&
            x >= this._popupBounds.x && x < this._popupBounds.x + this._popupBounds.w &&
            y >= this._popupBounds.y && y < this._popupBounds.y + this._popupBounds.h)
            return true;
        return this._sticks?.hitTest(x, y) ?? false;
    }

    // ---- evdev 事件分发 ----

    _onWheel(dir, value) {
        if (this._sticks?.handleWheel(...global.get_pointer().slice(0, 2), dir))
            return;
        this._wheel?.onWheel(dir, value);
    }

    _onButton(code, pressed) {
        const [gx, gy] = global.get_pointer();
        const x = Math.round(gx);
        const y = Math.round(gy);

        if (code === BUTTONS.RIGHT && pressed) {
            // 指针在自己的贴图上：这次右键用于关闭贴图，不进手势
            if (this._sticks?.hitTest(x, y))
                this._sticks.handlePress(x, y, 'right');
            else
                this._gesture?.onButton(code, true);
            return;
        }

        if (code === BUTTONS.RIGHT) {
            this._gesture?.onButton(code, false);
            return;
        }

        if (code === BUTTONS.LEFT) {
            if (this._sticks?.hitTest(x, y)) {
                this._sticks.handlePress(x, y, 'left');
                return;
            }
            if (pressed)
                this._sticks?.handleRelease();
            // 左键永不进手势：之前误用「任意按键」掩码，导致左键拖动也画箭头
            return;
        }
    }

    _onMotion(dx, dy) {
        const [gx, gy] = global.get_pointer();
        const x = Math.round(gx);
        const y = Math.round(gy);
        if (this._sticks?.handleMotion(x, y))
            return;
        this._gesture?.onMotion(dx, dy);
    }

    _onEscape() {
        if (this._popup) {
            this._closePopup();
            return;
        }
        if (this._sticks?.closeActive()) {
            Log.debug('Esc 关闭贴图');
            return;
        }
        this._gesture?.onEscape();
    }

    // ---- 样式 ----

    _loadStyle() {
        try {
            this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            const css = GLib.build_filenamev([this._dir, 'stylesheet.css']);
            this._theme.load_stylesheet(Gio.File.new_for_path(css));
            this._cssPath = css;
        } catch (e) {
            Log.warn('加载样式失败:', e.message);
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

    // ---- 动作 ----

    async _onRectangle(rect, action) {
        Log.info('执行矩形动作:', action, JSON.stringify(rect.bbox));
        try {
            const {bytes, scale} = await grabArea(
                rect.bbox.x, rect.bbox.y, rect.bbox.w, rect.bbox.h);
            copyImage(bytes);

            if (action === 'stick') {
                this._sticks.add(bytes, rect.bbox,
                    {opacity: this._cfg.stick?.opacity ?? 1});
            } else if (action === 'ocr') {
                await this._runOcr(bytes, rect.bbox);
            }
            void scale;
        } catch (e) {
            Log.error('矩形动作失败:', e);
            Main.notify('Edge Gesture 截图失败', e.message);
        }
    }

    async _runOcr(bytes, bbox) {
        if (!this._ocr.available) {
            Log.warn('OCR 后端不可用:', this._cfg.ocr.script);
            Main.notify('Edge Gesture', 'OCR 后端未就绪：检查 config.json 的 pythonBin / script');
            return;
        }
        const path = tmpPath('ocr-' + Date.now() + '.png');
        bytesToFile(bytes, path);
        try {
            Log.debug('OCR 开始', path);
            const text = await this._ocr.run(path, this._cfg.ocr.lang ?? 'chi_sim+eng');
            Log.info('OCR 完成，' + text.length + ' 字符');
            if (!text) {
                Main.notify('Edge Gesture', '没识别到文字');
                return;
            }
            if (this._cfg.ocr.copyText)
                copyText(text);
            this._showOcrPopup(text);
        } catch (e) {
            Log.error('OCR 失败:', e);
            Main.notify('Edge Gesture OCR 失败', e.message);
        } finally {
            try {
                Gio.File.new_for_path(path).delete(null);
            } catch {
                // ignore
            }
        }
    }

    /** OCR 结果浮层：不 grab，点任意处或 Esc 关闭。 */
    _showOcrPopup(text) {
        this._closePopup();

        const w = Math.min(720, Math.round(global.stage.width * 0.55));
        const lines = text.split('\n').length;
        const h = Math.min(520, Math.max(160, 90 + lines * 22));

        const box = new St.BoxLayout({
            style_class: 'edgegesture-ocr',
            vertical: true,
            reactive: true,
        });
        box.add_child(new St.Label({
            style_class: 'edgegesture-ocr-header',
            text: 'OCR 结果（已复制到剪贴板 · Esc 或点击关闭）',
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
        });
        label.clutter_text?.set_line_wrap(true);
        label.clutter_text?.set_selectable?.(true);
        scroll.add_child(label);
        box.add_child(scroll);

        box.set_size(w, h);
        box.set_position(
            Math.round((global.stage.width - w) / 2),
            Math.round((global.stage.height - h) / 2));

        Main.uiGroup.add_child(box);
        this._popup = box;
        this._popupBounds = {x: box.x, y: box.y, w, h};
        Log.debug('OCR 浮层 ' + w + 'x' + h);
    }

    _closePopup() {
        if (!this._popup)
            return;
        this._popup.destroy();
        this._popup = null;
        this._popupBounds = null;
    }
}
