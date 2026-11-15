import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Config from './lib/config.js';
import * as Log from './lib/logger.js';
import {InputSource, BUTTONS} from './lib/inputSource.js';
import {InputGuard} from './lib/inputGuard.js';
import {EdgeGrab} from './lib/edgeGrab.js';
import {EdgeWheel} from './lib/edgeWheel.js';
import {GestureEngine} from './lib/gesture.js';
import {OcrRunner} from './lib/ocr.js';
import {grabArea, bytesToFile, tmpPath, copyImage, copyText} from './lib/screenshot.js';

// 版本戳：日志里能一眼看出 shell 跑的是哪一版代码。
// ESM 模块会被 shell 缓存，改了代码必须重启 shell（注销重登）才生效。
const BUILD = '3.5-swallow';

export class Impl {
    /**
     * @param {object} ext 外层 Extension 实例（用来拿 dir）
     * @param {string} [dir] 扩展的真实目录。extension.js 从缓存快照加载 impl.js 时
     *   会显式传进来：快照目录里没有 config.json / logs / bin，配置和日志必须
     *   落在源码目录，否则每次重载都读默认值、日志写到看不见的地方。
     */
    constructor(ext, dir = null) {
        this._ext = ext;
        this._dir = dir;
    }

    enable() {
        const dir = this._dir ?? this._ext.dir.get_path();
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

        /*
         * 拦截器优先：它能拿到边缘带内、已经被吞掉的滚轮。
         * 不可用（缺可执行文件 / 没有 /dev/uinput 权限）时退回 evdev 直读，
         * 功能不变，只是窗口会跟着滚一下。
         */
        /*
         * 可执行文件在项目根的 bin/ 下（与 OCR 二进制同一套布局）。
         * dir 是扩展目录，往上两级才是项目根 —— 直接用 Config.projectRoot，
         * 它认得符号链接安装（~/.local/share/.../x ->
         * 项目/extension/x）这种情况，自己拼路径会在装完链接后指空。
         */
        this._guard = new InputGuard({
            binary: GLib.build_filenamev([
                Config.projectRoot(this._dir), 'bin', 'edgegesture-input']),
            onWheel: (d, v) => {
                this._lastGuardWheelAt = GLib.get_monotonic_time() / 1000;
                this._wheel?.onWheel(d, v);
            },
            onButton: (code, pressed) => this._gesture?.onButton(code, pressed),
            onMotion: () => this._gesture?.onMotion(0, 0),
        });
        const guardOk = this._guard.enable();

        this._lastGuardWheelAt = 0;

        this._input = new InputSource({
            onWheel: (dir2, val, name, path) => {
                /*
                 * 两道去重：
                 *  - 拦截器握着设备时，evdev 这条流本来就读不到东西，正常不会到这里；
                 *  - 万一 grab 与已排队事件抢了一下，30ms 内的同向滚轮丢弃。
                 * 两次都算进去的话音量会跳两格，用户会以为滚轮坏了。
                 */
                if (this._guard?.grabbed)
                    return;
                const now = GLib.get_monotonic_time() / 1000;
                if (now - this._lastGuardWheelAt < 30)
                    return;
                this._grab?.notifyWheel(path);
                this._wheel?.onWheel(dir2, val);
            },
            onButton: (code, pressed) => this._gesture?.onButton(code, pressed),
            onMotion: (dx, dy, name, path) => {
                this._gesture?.onMotion(dx, dy);
                this._grab?.notifyMotion(path);
            },
            onEscape: () => this._gesture?.onEscape(),
        });
        this._input.enable();

        // 拦截期间物理设备被独占、inputSource 断流，画框的按钮事件从拦截器来；
        // 位置状态也要靠它提前扣设备。
        this._grab = new EdgeGrab({
            cfg: this._cfg,
            guard: this._guard,
            geometry: () => this._geometry(),
            busy: () => (this._gesture?.state ?? 'idle') !== 'idle',
        });
        if (guardOk) {
            // 拦截器一扣设备，本模块的 fd 就读不到东西；明确挂起比空转干净，
            // 也彻底杜绝「两个读者抢同一个 fd」那类老问题。
            this._guard.onGrabChange = grabbed => {
                if (grabbed)
                    this._input?.suspend();
                else
                    this._input?.resume();
            };
            /*
             * 子进程是异步启动的：enable() 返回时还没收到 READY，
             * available 仍是 false。等 onReady 再启用 EdgeGrab，
             * 否则会在启动瞬间打出「拦截器不可用」然后永远不启用。
             */
            if (this._guard.available)
                this._grab.enable();
            else
                this._guard.onReady = () => this._grab?.enable();
        }

        Log.info('指针设备数:', this._input.pointerCount);

        if (this._input.pointerCount === 0) {
            Main.notify('Edge Gesture',
                '读不到鼠标设备。确认在 input 组：sudo usermod -aG input $USER 后重新登录');
        }
    }

    disable() {
        Log.info('─── 禁用 edgegesture ───');
        // 先放设备再退进程：顺序反了会有一段「已 ungrab 但仍被当拦截」的窗口
        this._grab?.disable();
        this._grab = null;
        this._guard?.disable();
        this._guard = null;
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
