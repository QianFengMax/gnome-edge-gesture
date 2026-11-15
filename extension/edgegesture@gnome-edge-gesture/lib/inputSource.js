import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import * as Log from './logger.js';

/**
 * 直接读 /dev/input/event* 的输入源。
 *
 * 为什么不用 Clutter 的事件：
 *  - 真实会话里滚轮/按键直接转发给客户端窗口，shell 的 stage captured-event 收不到；
 *  - 指针落在 reactive actor 上时事件被该 actor 吞掉，路由不可预期；
 *  - Clutter 报告的按钮掩码在本机与文档不符（右键报 0x200），无法可靠区分左右键。
 *
 * evdev 是纯事件驱动：没有事件时线程阻塞在内核上，空闲零开销，不耗电。
 *
 * 设备选择：有 REL_WHEEL + BTN_RIGHT 的是鼠标类；有 KEY_ESC 的键盘只用来收 Esc。
 */

const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;

const REL_WHEEL = 0x08;
const REL_HWHEEL = 0x06;
const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const BTN_MIDDLE = 0x112;
const KEY_ESC = 1;

const EVENT_SIZE = 24; // 64 位 Linux: timeval(16) + type(2) + code(2) + value(4)
const INPUT_DIR = '/dev/input';

/** 我们自己注入的设备名前缀，跳过避免自反馈 */
const SKIP_NAMES = [/ydotoold/i, /edgegesture/i, /vinput/i];

function readSys(path) {
    try {
        const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return ok ? new TextDecoder().decode(bytes).trim() : '';
    } catch {
        return '';
    }
}

/** 解析 sysfs 的十六进制能力位图，返回是否含某位。 */
function hasBit(maskText, bit) {
    if (!maskText)
        return false;
    const words = maskText.split(/\s+/).filter(Boolean);
    // 低位字在最后
    const totalBits = words.length * 64;
    if (bit >= totalBits)
        return false;
    const wordIndex = words.length - 1 - Math.floor(bit / 64);
    const word = BigInt('0x' + words[Math.max(0, wordIndex)]);
    return ((word >> BigInt(bit % 64)) & 1n) === 1n;
}

function deviceName(devPath) {
    const base = devPath.split('/').pop();
    return readSys(`/sys/class/input/${base}/device/name`) || base;
}

function deviceCaps(devPath) {
    const base = devPath.split('/').pop();
    const root = `/sys/class/input/${base}/device/capabilities`;
    return {
        rel: readSys(`${root}/rel`),
        key: readSys(`${root}/key`),
        abs: readSys(`${root}/abs`),
    };
}

function isPointer(caps) {
    return hasBit(caps.rel, REL_WHEEL) && hasBit(caps.key, BTN_RIGHT);
}

function isKeyboard(caps) {
    return hasBit(caps.key, KEY_ESC) && !hasBit(caps.rel, REL_WHEEL);
}

/** 取消挂起异步读之后 close 流必然会抛的「操作进行中」类错误。 */
function isPendingError(e) {
    const msg = `${e?.message ?? e}`;
    return /pending|in progress|进行中|异常操作|cancelled|已取消/i.test(msg);
}

class Device {
    constructor(path, kind, name, size) {
        this.path = path;
        this.kind = kind;       // 'pointer' | 'keyboard'
        this.name = name;
        this.size = size;
        this.stream = null;     // DataInputStream
        this.base = null;       // 底层 GLocalFileInputStream（真正持有 fd）
        this.cancellable = new Gio.Cancellable();
        this.fd = -1;
        this.open = false;
        this.failures = 0;
        this.reading = false;   // 是否有在途的 read_bytes_async
    }

    close() {
        // 顺序很关键：流上还有挂起的 read_bytes_async 时，直接 close()
        // 会因「操作进行中」而失败，错误被吞掉，fd 就永远不释放。
        // 连续 disable/enable 会不断累积同一设备的 fd，而 evdev 是按 fd
        // 分发事件的，多个读取者互相抢，表现为「事件时有时无、方向全乱」。
        try {
            this.cancellable.cancel();
        } catch (e) {
            Log.warn('cancel 失败 ' + this.name + ': ' + e.message);
        }
        this.open = false;
        try {
            this.stream?.close(null);
        } catch (e) {
            // 「流有异常操作 / 操作进行中」是取消挂起 read 的正常产物，
            // 每次 reload 都刷三条只会埋掉真正的错误。
            if (!isPendingError(e))
                Log.warn('关闭 DataInputStream 失败 ' + this.name + ': ' + e.message);
        }
        try {
            this.base?.close(null);
        } catch (e) {
            if (!isPendingError(e))
                Log.warn('关闭 base stream 失败 ' + this.name + ': ' + e.message);
        }
        this.reading = false;
        this.stream = null;
        this.base = null;
        if (this.fd >= 0) {
            try {
                GLib.close(this.fd);
            } catch {
                // 已由 close_fd 关闭
            }
            this.fd = -1;
        }
        this.cancellable = new Gio.Cancellable();
    }
}

// 每次 enable 都新建一个 InputSource；旧实例必须彻底停止，
// 否则它的 read 回调仍持有 fd 并参与事件分发（evdev 按 fd 抢事件）。
let _liveInstance = null;

export class InputSource {
    constructor(handlers = {}) {
        this._handlers = handlers;
        this._alive = true;
        // 拦截器握有设备时置 true：本模块的 fd 会读到 EAGAIN，
        // 与其空转，不如明确停读，等拦截结束再续。
        this._suspended = false;
        this._devices = new Map();
        this._monitor = null;   // 必须留引用：没人引用的 GFileMonitor 会被 GC 掉
        this._monitorId = 0;
        this._rescanId = 0;
        this._pollId = 0;
        this._enabled = false;
        this._sizeMismatch = 0;
    }

    get devices() {
        return [...this._devices.values()].map(d => ({
            path: d.path, kind: d.kind, name: d.name, open: d.open,
        }));
    }

    /** 拦截器接管期间挂起本模块的所有读取。 */
    /**
     * 拦截器接管期间暂停读取。
     *
     * 这里只置标志、**不取消挂起的 read**。原因是一个很坑的时序：
     *   suspend 取消 cancellable → resume 换了新的 cancellable 并重启读循环
     *   → 旧的那次 read 才带着「已取消」错误回调回来。这时
     *   dev.cancellable.is_cancelled() 是 false（已是新对象）、_suspended 也
     *   已复位，于是错误被当成真正的读故障去 dev.close()，把刚被新循环
     *   复用的 fd 关掉 —— 症状是「错误的文件描述符」，而且设备从此不再响应。
     *
     * 现在是「读到 SYN 后看标志决定要不要继续读」：挂起时那次 read 自然
     * 结束就停下，恢复时若没有在途读取才重新发起，永远不会有两个读者。
     */
    suspend() {
        if (this._suspended)
            return;
        this._suspended = true;
        Log.debug('evdev 读取挂起（拦截器接管）');
    }

    /** 拦截结束后恢复读取。 */
    resume() {
        if (!this._suspended)
            return;
        this._suspended = false;
        for (const dev of this._devices.values()) {
            // 还有在途读取就交给它的回调接管，别并发开第二个读者
            if (!dev.open || dev.reading)
                continue;
            this._readLoop(dev);
        }
        Log.debug('evdev 读取恢复');
    }

    get suspended() {
        return this._suspended;
    }

    get pointerCount() {
        return [...this._devices.values()].filter(d => d.kind === 'pointer' && d.open).length;
    }

    enable() {
        if (this._enabled)
            return;
        // 任何旧实例立即失效（防止上一个 enable 的 reader 继续活着）
        if (_liveInstance && _liveInstance !== this)
            _liveInstance.disable();
        _liveInstance = this;
        this._alive = true;
        this._enabled = true;
        this._scan();
        // 插拔后重扫（去抖）
        //
        // monitor 对象必须存在 this 上：GJS 里 `dir.monitor_directory(..).connect(..)`
        // 的返回值没人引用，下一轮 GC 就把监视器回收了，'changed' 从此不再触发。
        // 真机症状：扩展在鼠标之前启动（或中途换鼠标），新设备永远不被监听，
        // 边缘滚轮和右键画框全哑，只能手动 reload 一次才恢复。
        let monitorOk = false;
        try {
            const dir = Gio.File.new_for_path(INPUT_DIR);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._scheduleRescan());
            monitorOk = true;
        } catch (e) {
            Log.warn('无法监视 /dev/input（插拔需手动重载扩展）:', e.message);
        }
        // 兜底轮询：只比对「/dev/input 里多了或少了哪个 event」，不读 sysfs、
        // 不重判已知设备（rescan(true)），所以一次唤醒就是一次目录枚举。
        // inotify 正常时 300s 一次——纯安全网，对耗电的影响低于测量噪音；
        // 只有在监视建不起来时才退化成 30s 一次。
        const pollSec = monitorOk ? 300 : 30;
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, pollSec, () => {
            if (!this._enabled) {
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this.rescan(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        this._enabled = false;
        this._alive = false;
        if (_liveInstance === this)
            _liveInstance = null;
        this._cancelRescan();
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._monitor && this._monitorId) {
            try {
                this._monitor.disconnect(this._monitorId);
            } catch {
                // monitor 已失效，忽略
            }
        }
        this._monitorId = 0;
        this._monitor = null;
        for (const dev of this._devices.values())
            dev.close();
        this._devices.clear();
    }

    /**
     * @param {boolean} [light] 轻扫：只比对设备路径集合，不重判已知但不关心的设备。
     *   已打开的设备本来就在下面被跳过；轻扫额外跳过 ignored（触摸屏、电源键
     *   那十来个），省掉它们每个 4 次 sysfs 读 —— 兜底轮询用它，一次唤醒只有
     *   一次 getdents。
     */
    rescan(light = false) {
        if (!this._enabled)
            return;
        const seen = new Set(this._listEventDevices());

        // 先关掉已经消失或失效的设备，避免 fd 泄漏。
        // evdev 按 fd 分发事件，同一设备留两个 fd 会互相抢事件，
        // 表现为「事件时有时无、方向错乱」，这是之前功能全失效的根因。
        for (const [path, dev] of [...this._devices]) {
            const gone = !seen.has(path);
            const dead = !dev.open && dev.failures > 5;
            if (gone || dead) {
                dev.close();
                this._devices.delete(path);
            }
        }

        // 再打开还没打开的设备（必须保证同一路径只开一个 fd）
        for (const path of seen) {
            const existing = this._devices.get(path);
            if (existing?.open)
                continue;
            if (light && existing?.kind === 'ignored')
                continue;
            if (existing)
                existing.close();
            this._openDevice(path);
        }
    }

    _scheduleRescan() {
        this._cancelRescan();
        this._rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._rescanId = 0;
            this.rescan();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelRescan() {
        if (this._rescanId) {
            GLib.source_remove(this._rescanId);
            this._rescanId = 0;
        }
    }

    _scan() {
        this.rescan();
        const pointers = [...this._devices.values()].filter(d => d.kind === 'pointer' && d.open);
        if (pointers.length === 0)
            Log.warn('没有可读的鼠标设备，边缘滚轮/右键手势不可用。检查是否在 input 组：groups');
        else
            Log.info('指针设备:', pointers.map(d => d.name).join(', '));
    }

    _listEventDevices() {
        const out = [];
        try {
            const dir = Gio.File.new_for_path(INPUT_DIR);
            const en = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const n = info.get_name();
                if (/^event\d+$/.test(n))
                    out.push(`${INPUT_DIR}/${n}`);
            }
        } catch (e) {
            Log.error('无法枚举 /dev/input:', e.message);
        }
        return out.sort((a, b) =>
            parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
    }

    _openDevice(path) {
        const name = deviceName(path);
        if (SKIP_NAMES.some(re => re.test(name)))
            return;

        const caps = deviceCaps(path);
        let kind = null;
        if (isPointer(caps))
            kind = 'pointer';
        else if (isKeyboard(caps))
            kind = 'keyboard';
        if (!kind) {
            // 记住不关心的设备，避免每次重扫都查 sysfs
            this._devices.set(path, new Device(path, 'ignored', name, EVENT_SIZE));
            return;
        }

        const old = this._devices.get(path);
        if (old?.open) {
            // 已经有打开中的 fd，直接复用，绝不重复打开
            return;
        }
        if (old)
            old.close();

        const dev = new Device(path, kind, name, EVENT_SIZE);
        try {
            // 用裸 fd + UnixInputStream：Gio.File.read() 会做内部缓存，
            // close() 后 fd 仍可能被 libgio 持有；连续 disable/enable 会
            // 累积同一设备的多个 fd，而 evdev 按 fd 分发事件，
            // 多读取者互相抢 -> 事件丢失、方向错乱。
            const fd = GLib.open(path, 0, 0);
            if (fd < 0)
                throw new Error('GLib.open 返回 ' + fd);
            dev.fd = fd;
            dev.base = new GioUnix.InputStream({fd, close_fd: true});
            dev.stream = new Gio.DataInputStream({base_stream: dev.base});
            dev.open = true;
        } catch (e) {
            dev.failures++;
            Log.warn(`打开 ${path} (${name}) 失败: ${e.message}` + 
                '（需要 input 组权限：sudo usermod -aG input $USER 后重新登录）');
            this._devices.set(path, dev);
            return;
        }
        this._devices.set(path, dev);
        Log.info(`监听 ${kind}: ${name} (${path})`);
        this._readLoop(dev);
    }

    _readLoop(dev) {
        if (!dev.open || !this._enabled || !this._alive || this._suspended)
            return;
        if (dev.reading)
            return;   // 已有在途读取，绝不能开第二个读者抢同一个 fd
        dev.reading = true;

        dev.stream.read_bytes_async(dev.size, GLib.PRIORITY_DEFAULT, dev.cancellable, (src, res) => {
            dev.reading = false;

            if (!this._alive || !this._enabled || dev.cancellable.is_cancelled()) {
                // 实例已失效：不再续读，避免旧 fd 继续抢事件
                return;
            }
            let bytes;
            try {
                bytes = src.read_bytes_finish(res);
            } catch (e) {
                if (dev.cancellable.is_cancelled() || !this._alive || this._suspended)
                    return;
                Log.warn(`读 ${dev.name} 失败，稍后重连: ${e.message}`);
                dev.close();
                dev.failures++;
                if (this._enabled)
                    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                        if (this._enabled) {
                            dev.close();
                            this._devices.delete(dev.path);
                            this.rescan();
                        }
                        return GLib.SOURCE_REMOVE;
                    });
                return;
            }

            if (bytes.get_size() === 0) {
                dev.close();
                return;
            }
            if (bytes.get_size() >= dev.size)
                this._parse(dev, bytes);
            // 挂起期间读到这里就停，等 resume() 重新发起
            if (!this._suspended)
                this._readLoop(dev);
        });
    }

    _parse(dev, bytes) {
        const data = bytes.get_data();
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const type = view.getUint16(16, true);
        const code = view.getUint16(18, true);
        const value = view.getInt32(20, true);

        // 结构体大小猜错时 type 会离谱，自愈一次
        if (type > 0x1f) {
            if (this._sizeMismatch++ < 3)
                Log.error(`input_event 解析异常 (type=${type})，事件结构可能不是 ${dev.size} 字节`);
            return;
        }

        if (type === EV_SYN)
            return;

        if (type === EV_REL) {
            if (dev.kind !== 'pointer')
                return;
            if (code === REL_WHEEL) {
                this._handlers.onWheel?.(value > 0 ? 'up' : 'down', value, dev.name, dev.path);
            } else if (code === REL_HWHEEL) {
                this._handlers.onWheel?.(value > 0 ? 'right' : 'left', value, dev.name, dev.path);
            } else {
                this._handlers.onMotion?.(code, value, dev.name, dev.path);
            }
            return;
        }

        if (type === EV_KEY) {
            const pressed = value !== 0;
            if (code === BTN_RIGHT || code === BTN_LEFT || code === BTN_MIDDLE) {
                if (dev.kind === 'pointer')
                    this._handlers.onButton?.(code, pressed, dev.name);
            } else if (code === KEY_ESC && dev.kind === 'keyboard') {
                if (pressed)
                    this._handlers.onEscape?.(dev.name);
            }
        }
    }
}

export const BUTTONS = {LEFT: BTN_LEFT, RIGHT: BTN_RIGHT, MIDDLE: BTN_MIDDLE};

/** 指针是否有 input 组权限（用于启动时提示）。 */
export function hasInputPermission() {
    const devices = new InputSource()._listEventDevices?.() ?? [];
    return devices.length > 0;
}
