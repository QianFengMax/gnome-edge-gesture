import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Log from './logger.js';

/**
 * 「边缘暂扣」拦截器桥。
 *
 * 为什么需要它：README 里那条「边缘滚轮只监听不拦截」的限制是真机测出来的
 * —— Wayland 下滚轮由 mutter 直接派给指针下的 surface，shell 的 stage 收不到，
 * 扩展没有能力在合成器层吞掉它。唯一可靠的办法是内核 EVIOCGRAB 独占设备，
 * 自己再把事件写回 uinput。
 *
 * 影响范围：不常驻独占。只有指针进了边缘带才 GRAB，指针一离开就 UNGRAB，
 * 平时物理设备的输出去向与没装扩展时完全一样。
 *
 * 进程模型：Gio.Subprocess 拉起 bin/edgegesture-input，stdin 发命令，
 * stdout 收事件。扩展卸载 / shell 退出 → stdin 关闭 → 子进程立即 ungrab
 * 并退出，鼠标不会留在被扣住的状态；子进程另有 3 秒心跳看门狗兜底。
 */
export class InputGuard {
    /**
     * @param {object} opts
     * @param {string} opts.binary   可执行文件绝对路径
     * @param {(dir:string, value:number)=>void} opts.onWheel  拦截到的滚轮
     * @param {(code:number, pressed:boolean)=>void} opts.onButton 拦截到的按键
     * @param {()=>void} opts.onMotion 拦截期间的运动提示（坐标请自己取 pointer）
     */
    constructor(opts) {
        this._bin = opts.binary;
        this._onWheel = opts.onWheel;
        this._onButton = opts.onButton;
        this._onMotion = opts.onMotion;
        this._proc = null;
        this._out = null;
        this._stdin = null;
        this._grabbed = false;
        this._ready = false;
        this._heartbeatId = 0;
        this._moveFlushId = 0;
        this._movePending = false;
        this._destroyed = false;
        this._failed = false;
        this._err = null;
        /** 扣放状态变化时回调（扩展用来挂起/恢复 evdev 读流）。 */
        this.onGrabChange = null;
        /** 子进程报 READY 时回调。enable() 是异步的，available 要等这里。 */
        this.onReady = null;
    }

    get available() {
        return this._ready && !this._failed;
    }

    get grabbed() {
        return this._grabbed;
    }

    get unsupportedReason() {
        if (!GLib.file_test(this._bin, GLib.FileTest.IS_EXECUTABLE))
            return '缺少 ' + this._bin + '（先跑 scripts/build-inputguard.sh）';
        if (this._failed)
            return this._err ?? '拦截器启动失败';
        return null;
    }

    /** 启动子进程。失败不抛：调用方退回「只观察不拦截」的老行为。 */
    enable() {
        if (this._proc)
            return true;
        if (!GLib.file_test(this._bin, GLib.FileTest.IS_EXECUTABLE)) {
            this._failed = true;
            this._err = '找不到可执行文件 ' + this._bin;
            Log.warn('边缘拦截不可用:', this._err);
            return false;
        }

        try {
            this._proc = new Gio.Subprocess({
                argv: [this._bin],
                flags: Gio.SubprocessFlags.STDIN_PIPE |
                       Gio.SubprocessFlags.STDOUT_PIPE,
            });
            this._proc.init(null);
        } catch (e) {
            this._failed = true;
            this._err = e.message;
            this._proc = null;
            Log.warn('拦截器启动失败:', e.message);
            return false;
        }

        this._stdin = this._proc.get_stdin_pipe();
        this._out = new Gio.DataInputStream({
            base_stream: this._proc.get_stdout_pipe(),
        });
        this._readLoop();

        const pid = this._proc.get_identifier();
        Log.info('拦截器已启动 pid=' + pid + ' (' + this._bin + ')');
        return true;
    }

    disable() {
        this._destroyed = true;
        this._stopHeartbeat();
        if (this._moveFlushId) {
            GLib.source_remove(this._moveFlushId);
            this._moveFlushId = 0;
        }
        // 先请求释放，再关流：直接杀掉也能让内核解 grab，
        // 但走 QUIT 能顺带撤掉 uinput 设备，桌面不留幽灵鼠标。
        try {
            this._send('UNGRAB');
            this._send('QUIT');
        } catch {
            // 进程可能已退出
        }
        try {
            this._stdin?.close(null);
        } catch {
            // ignore
        }
        this._stdin = null;
        this._out = null;
        try {
            this._proc?.force_exit();
        } catch {
            // ignore
        }
        this._proc = null;
        this._grabbed = false;
        this._ready = false;
    }

    /**
     * 请求暂扣设备。
     * @param {number} x @param {number} y 当前指针位置
     * @param {number} margin 边缘带宽度
     * @param {Array<{x:number,y:number,w:number,h:number}>} monitors
     */
    /**
     * @param {string[]} [devs] 要扣的设备路径。只给一个是有意的：
     *   多个相对设备同时转发到同一个 uinput 会让光标速度翻倍，
     *   所以由调用方选「最近送过滚轮的那一个」。
     */
    grab(x, y, margin, monitors, arm = 0, devs = null) {
        if (!this.available || this._grabbed)
            return false;
        const spec = monitors
            .map(m => `${m.x},${m.y},${m.w},${m.h}`)
            .join(';');
        const devSpec = (devs && devs.length)
            ? ' devs=' + devs.join(',')
            : '';
        this._grabbed = true;   // 乐观置位：命令发出即视为已扣，避免高频重复请求
        this._notifyGrab(true);
        this._send(`GRAB x=${Math.round(x)} y=${Math.round(y)} ` +
            `margin=${Math.round(margin)} arm=${Math.round(arm)} ` +
            `monitors=${spec}${devSpec}`);
        this._startHeartbeat();
        return true;
    }

    /**
     * 把合成器视角的指针位置同步给拦截器。
     * 触摸屏 / ydotool 注入的移动不经过被扣的物理设备，拦截器自己的
     * REL 增量会漂，隔一阵用权威坐标校正一次。
     */
    syncPos(x, y) {
        if (!this.available || !this._grabbed)
            return;
        this._send(`POS x=${Math.round(x)} y=${Math.round(y)}`);
    }

    /** uinput 出来的指针速度补偿（部分桌面对虚拟设备的 DPI 处理不同）。 */
    setScale(scale) {
        this._send(`SET scale=${scale}`);
    }

    ungrab() {
        this._stopHeartbeat();
        if (!this._grabbed)
            return;
        this._grabbed = false;
        this._send('UNGRAB');
        this._notifyGrab(false);
    }

    _notifyGrab(grabbed) {
        try {
            this.onGrabChange?.(grabbed);
        } catch (e) {
            Log.warn('onGrabChange 回调失败:', e.message);
        }
    }

    // ---- 内部 ----

    _send(line) {
        if (!this._stdin)
            return;
        try {
            const bytes = new TextEncoder().encode(line + '\n');
            this._stdin.write_all(bytes, null);
            this._stdin.flush(null);
        } catch (e) {
            Log.warn('向拦截器写命令失败:', e.message);
        }
    }

    _startHeartbeat() {
        if (this._heartbeatId)
            return;
        // 子进程 3 秒收不到任何命令就自己 ungrab；1 秒一次心跳留足余量。
        this._heartbeatId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (!this._grabbed || !this.available) {
                this._heartbeatId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._send('PING');
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopHeartbeat() {
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = 0;
        }
    }

    _readLoop() {
        const out = this._out;
        if (!out)
            return;
        out.read_line_async(GLib.PRIORITY_DEFAULT, null, (src, res) => {
            if (this._destroyed || this._out !== src)
                return;
            let line = null;
            try {
                const [bytes] = src.read_line_finish(res);
                line = bytes ? new TextDecoder().decode(bytes) : null;
            } catch (e) {
                Log.warn('拦截器输出读取失败:', e.message);
                this._failed = true;
                this._failGrab();
                return;
            }
            if (line === null) {
                // EOF：子进程退出了（崩溃 / 被 kill），退回只观察模式
                Log.warn('拦截器已退出，边缘滚轮恢复为「只观察不拦截」');
                this._failed = true;
                this._failGrab();
                return;
            }
            try {
                this._handle(line.trim());
            } catch (e) {
                Log.error('拦截器事件处理失败:', e);
            }
            this._readLoop();
        });
    }

    _handle(line) {
        if (!line)
            return;
        const sp = line.indexOf(' ');
        const cmd = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? '' : line.slice(sp + 1);

        switch (cmd) {
        case 'READY':
            this._ready = true;
            Log.info('拦截器就绪');
            try {
                this.onReady?.();
            } catch (e) {
                Log.warn('onReady 回调失败:', e.message);
            }
            break;
        case 'PONG':
            break;
        case 'OK':
            break;
        case 'ERR':
            Log.warn('拦截器报错:', rest);
            if (rest.startsWith('uinput') || rest.startsWith('ui_dev'))
                this._failed = true;
            if (rest.startsWith('grab') || rest.startsWith('no-pointer')) {
                if (this._grabbed)
                    this._notifyGrab(false);
                this._grabbed = false;
                this._stopHeartbeat();
            }
            break;
        case 'WHEEL': {
            const [dir] = rest.split(' ');
            const value = parseInt(rest.split(' ')[1] ?? '1', 10);
            this._onWheel?.(dir, Number.isFinite(value) ? value : 1);
            break;
        }
        case 'HWHEEL': {
            const [dir] = rest.split(' ');
            const value = parseInt(rest.split(' ')[1] ?? '1', 10);
            this._onWheel?.(dir, Number.isFinite(value) ? value : 1);
            break;
        }
        case 'BTN': {
            const [codeHex, pressedStr] = rest.split(' ');
            this._onButton?.(parseInt(codeHex, 16), pressedStr === '1');
            break;
        }
        case 'MOVE':
            this._queueMotion();
            break;
        case 'UNGRAB':
            // 子进程自己放的（离开边缘带 / 看门狗 / 设备消失）
            if (this._grabbed)
                this._notifyGrab(false);
            this._grabbed = false;
            this._stopHeartbeat();
            Log.debug('拦截器自动释放:', rest);
            break;
        default:
            Log.debug('拦截器未知输出:', line);
        }
    }

    /**
     * 拦截期间物理设备被独占，inputSource 收不到运动事件，
     * 右键画框会因此断供。这里把子进程的 MOVE 提示合并到 ~30Hz
     * 再喂给手势引擎（坐标由它自己 global.get_pointer() 取）。
     */
    _failGrab() {
        if (this._grabbed)
            this._notifyGrab(false);
        this._grabbed = false;
        this._stopHeartbeat();
    }

    _queueMotion() {
        if (this._movePending || this._moveFlushId)
            return;
        this._movePending = true;
        this._moveFlushId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            this._moveFlushId = 0;
            if (!this._movePending) {
                return GLib.SOURCE_REMOVE;
            }
            this._movePending = false;
            this._onMotion?.();
            return GLib.SOURCE_REMOVE;
        });
    }
}
