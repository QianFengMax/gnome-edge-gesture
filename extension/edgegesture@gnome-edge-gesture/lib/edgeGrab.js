import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';
import {zoneAt as zoneLookup, wantsGrab} from './zones.js';

/**
 * 边缘拦截的决策层：什么时候把指针设备「暂时扣下来」。
 *
 * 为什么不能只靠滚轮事件：滚轮一到，窗口已经滚了，再拦来不及。所以必须
 * 在指针**接近**边缘时提前扣设备，这样才能吞掉随之而来的那一下滚动。
 *
 * 两级半径（关键的取舍）：
 *   - 扣留半径 armPad：指针进入 margin + armPad 就扣。留出的余量是为了
 *     覆盖「滑到边缘后立刻滚」的手速。
 *   - 吞掉半径 margin：只有真落在边缘带里的滚轮才被吞，其余照样注入。
 *     提前扣 ≠ 提前改行为，所以指针在余量里滚窗口还是正常滚。
 *
 * 怎么保证不改坏平时的输入：
 *   1. 指针离开扣留范围，立刻 ungrab，事件流回到物理设备；
 *   2. 画框手势期间不扣（指针要满屏跑，否则一路 grab/ungrab 抖动）；
 *   3. 拦截器 3 秒收不到心跳自己 ungrab，扩展崩了也不会锁死鼠标。
 *
 * 功耗：空闲时只有一个 200ms 的本地位置检查（global.get_pointer 是合成器
 * 内存里的值，无系统调用），不读设备、不碰 IO。真正 grab 时才走 IO。
 */
export class EdgeGrab {
    /**
     * @param {object} o
     * @param {object} o.cfg         配置对象
     * @param {import('./inputGuard.js').InputGuard} o.guard
     * @param {() => ({monitors:Array, pointer:[number,number]})} o.geometry
     * @param {() => boolean} o.busy  画框等手势进行中时返回 true
     */
    constructor({cfg, guard, geometry, busy}) {
        this._cfg = cfg;
        this._guard = guard;
        this._geometry = geometry;
        this._busy = busy;
        this._tickId = 0;
        this._posId = 0;
        this._enabled = false;
        this._lastSyncAt = 0;
        /*
         * 最近送过事件的指针（/dev/input/eventN）。
         * 本机同时有「实体鼠标」和「keyd virtual pointer」两个指针设备，
         * 只扣其中一个就拿不到另一份滚轮；但两个都扣、都往同一个 uinput
         * 转发，运动事件会重复，光标速度翻倍。所以只扣「最近没被占用、
         * 且真的在动」的那一个。
         */
        this._activeDev = null;
        this._devAt = 0;
    }

    get enabled() {
        return this._enabled && this._guard?.available;
    }

    get grabbed() {
        return !!this._guard?.grabbed;
    }

    /** 指针所在边带；pad 是把带子加宽的余量。 */
    zoneAt(x, y, pad = 0) {
        return zoneLookup(this._geometry().monitors, x, y,
            (this._cfg.edge?.margin ?? 28) + pad);
    }

    _armPad() {
        return Math.max(0, Math.min(200, this._cfg.edge?.armPad ?? 40));
    }

    /** 指针是否落在「值得提前扣留」的范围内，且那条边有动作。 */
    _wantsGrab(x, y) {
        return wantsGrab(this._cfg, this._geometry().monitors, x, y, this._armPad());
    }

    enable() {
        if (this._enabled)
            return;
        if (this._cfg.edge?.swallow === false) {
            Log.info('边缘拦截已关闭（edge.swallow=false），滚轮只观察不拦截');
            return;
        }
        this._enabled = true;
        if (!this._guard?.available) {
            Log.info('边缘拦截未启用:', this._guard?.unsupportedReason ?? '拦截器不可用');
            return;
        }
        // 200ms：足够跟上「滑到边缘立刻滚」，又不值得为它省电
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            if (!this._enabled) {
                this._tickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
        Log.info('边缘拦截就绪：arm=' + (this._cfg.edge?.margin ?? 28) +
            '+' + this._armPad() + 'px');
    }

    disable() {
        this._enabled = false;
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._posId = 0;
        this._guard?.ungrab();
    }

    /**
     * inputSource 的运动事件：记住哪个设备在动。
     * 真正的扣押判定统一放在 tick 里，避免鼠标一动就发 ioctl。
     * @param {string} [devName] 设备名
     * @param {string} [devPath] 设备路径
     */
    notifyMotion(devPath) {
        if (devPath) {
            this._activeDev = devPath;
            this._devAt = GLib.get_monotonic_time() / 1000;
        }
    }

    /** 滚轮已经到了：至少把后面几格救回来（并由它确定是哪个设备）。 */
    notifyWheel(devPath) {
        if (devPath)
            this.notifyMotion(devPath);
        if (!this.enabled)
            return;
        const [x, y] = this._geometry().pointer;
        if (this.zoneAt(x, y))
            this._grab(x, y);
    }

    _tick() {
        if (!this.enabled)
            return;
        if (Main.overview?.visible || Main.screenShield?.active ||
            Main.screenshotUI?.visible) {
            this._guard.ungrab();
            return;
        }
        if (this._busy()) {
            this._guard.ungrab();
            return;
        }

        const [x, y] = this._geometry().pointer;
        if (this.grabbed) {
            // 拦截器自己会在离开 arm 范围时释放；这里定期把权威坐标同步过去，
            // 免得触摸屏 / ydotool 之类的外部移动让它的增量跟踪漂掉。
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastSyncAt > 1000) {
                this._lastSyncAt = now;
                this._guard.syncPos(x, y);
            }
            return;
        }
        if (this._wantsGrab(x, y))
            this._grab(x, y);
    }

    _grab(x, y) {
        const margin = this._cfg.edge?.margin ?? 28;
        // 交给拦截器的 arm 比我们的触发范围再宽 30px，形成迟滞：
        // 在边界上抖动不会反复 grab/ungrab。
        const arm = margin + this._armPad() + 30;

        /*
         * 设备选择：2 秒内活动过的那一个优先；否则让拦截器自己扫。
         * 只扣一个是因为「多个设备 → 同一个 uinput」会把运动转发两次，
         * 光标直接变两倍速 —— 这比漏拦更糟。
         */
        const fresh = this._activeDev &&
            (GLib.get_monotonic_time() / 1000 - this._devAt) < 2000;
        const devs = fresh ? [this._activeDev] : null;
        this._guard.grab(x, y, margin, this._geometry().monitors, arm, devs);
        Log.debug('暂扣指针设备以拦截边缘滚轮 arm=' + arm +
            ' dev=' + (devs ? devs[0] : 'auto'));
    }
}
