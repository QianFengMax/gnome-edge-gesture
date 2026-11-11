import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Config from './lib/config.js';
import * as Log from './lib/logger.js';
import {InputSource, BUTTONS} from './lib/inputSource.js';
import {EdgeWheel} from './lib/edgeWheel.js';
import {GestureEngine} from './lib/gesture.js';
import {OcrRunner} from './lib/ocr.js';
import {grabArea, bytesToFile, tmpPath, copyImage, copyText} from './lib/screenshot.js';

// 版本戳：日志里能一眼看出 shell 跑的是哪一版代码。
// ESM 模块会被 shell 缓存，改了代码必须重启 shell（注销重登）才生效。
const BUILD = '3.4-hotreload-proof';

export class Impl {
    /** @param {object} ext 外层 Extension 实例（用来拿 dir） */
    constructor(ext) {
        this._ext = ext;
    }

    enable() {
        const dir = this._ext.dir.get_path();
        this._dir = dir;
        const {config, path} = Config.loadConfig(dir);
        this._cfg = config;

        Log.init(config.debug ? Log.Level.DEBUG : Log.Level.INFO,
            GLib.build_filenamev([dir, 'logs']));
        Log.info('═══ 启用 edgegesture ' + BUILD + ' ═══');
        Log.info('配置:', path, 'debug=' + !!config.debug);

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
        this._ocr = new OcrRunner(this._cfg.ocr, Config.projectRoot(this._dir));

        this._wheel = new EdgeWheel(this._cfg, () => this._geometry());
        this._wheel.enable();

        this._gesture = new GestureEngine(this._cfg, {
            onRectangle: (rect, action) => this._onRectangle(rect, action),
        });
        this._gesture.setYieldCheck(() => false);
        this._gesture.enable();

        this._input = new InputSource({
            onWheel: (dir2, val) => this._wheel?.onWheel(dir2, val),
            onButton: (code, pressed) => this._gesture?.onButton(code, pressed),
            onMotion: (dx, dy) => this._gesture?.onMotion(dx, dy),
            onEscape: () => this._gesture?.onEscape(),
        });
        this._input.enable();

        Log.info('指针设备数:', this._input.pointerCount);

        if (this._input.pointerCount === 0) {
            Main.notify('Edge Gesture',
                '读不到鼠标设备。确认在 input 组：sudo usermod -aG input $USER 后重新登录');
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
        Log.init(Log.Level.INFO, null);
    }

    _geometry() {
        const monitors = Main.layoutManager.monitors.map(m => ({
            x: m.x, y: m.y, w: m.width, h: m.height,
        }));
        const [px, py] = global.get_pointer();
        return {monitors, pointer: [px, py]};
    }

    /** 画框：顺时针 OCR（只复制到剪贴板，不弹窗），逆时针忽略。 */
    async _onRectangle(rect, action) {
        Log.info('矩形动作:', action, JSON.stringify(rect.bbox));
        if (action !== 'ocr')
            return;

        try {
            const {bytes} = await grabArea(
                rect.bbox.x, rect.bbox.y, rect.bbox.w, rect.bbox.h);
            copyImage(bytes);
            await this._runOcr(bytes);
        } catch (e) {
            Log.error('OCR 流程失败:', e);
            Main.notify('Edge Gesture OCR 失败', e.message);
        }
    }

    async _runOcr(bytes) {
        if (!this._ocr.available) {
            Log.warn('OCR 后端不可用:', this._cfg.ocr.script);
            Main.notify('Edge Gesture', 'OCR 后端未就绪：检查 config.json 的 pythonBin / script');
            return;
        }
        const path = tmpPath('ocr-' + Date.now() + '.png');
        bytesToFile(bytes, path);
        try {
            const t0 = GLib.get_monotonic_time();
            const text = await this._ocr.run(path, this._cfg.ocr.lang ?? 'chi_sim+eng');
            const ms = Math.round((GLib.get_monotonic_time() - t0) / 1000);
            Log.info('OCR 完成 ' + ms + 'ms，' + text.length + ' 字符');
            if (!text) {
                Main.notify('Edge Gesture', '没识别到文字');
                return;
            }
            // 只写剪贴板，不弹任何窗口（按要求去掉结果弹窗）
            copyText(text);
            Main.notify('OCR 已复制', text.slice(0, 60).replace(/\s+/g, ' '));
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
}
