import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {imageContentFromBytes} from './screenshot.js';
import * as Log from './logger.js';

/**
 * 贴图窗口。
 *
 * 与 MouseInc 的贴图行为对齐：浮在屏幕上、可拖、可调透明、可缩放、可关，
 * **但不独占输入** —— 之前用 global.stage.grab() 把整个屏幕锁住了，
 * 必须右键删掉才能点别的东西，这是最大的一处体验事故。
 *
 * 现在：actor 不 reactive，所有交互由 extension 在 evdev 层面分发，
 * 只有指针真的落在贴图矩形里才响应，其余事件原样放行给下面的窗口。
 */
class StickWindow {
    constructor(opts = {}) {
        this.actor = new St.Widget({
            style_class: 'edgegesture-stick',
            reactive: false,      // 不抢指针，见类注释
            visible: false,
            opacity: Math.clamp(opts.opacity ?? 255, 16, 255),
        });
        this.actor.set_pivot_point(0.5, 0.5);
        this._bin = new St.Bin({x_expand: true, y_expand: true});
        this.actor.add_child(this._bin);

        this.baseW = 0;
        this.baseH = 0;
        this.zoom = 1;
        this.dragging = false;
        this.lastClick = 0;
    }

    /**
     * @param {GLib.Bytes} bytes PNG
     * @param {{x:number,y:number,w:number,h:number}} rect 逻辑坐标
     */
    setImage(bytes, rect) {
        const {content, width, height} = imageContentFromBytes(bytes);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        // 关键修复：content 的尺寸是物理像素，St 按逻辑像素摆放。
        // 之前直接用 content（物理尺寸）当 actor 尺寸，2x 屏上贴图整整大了一倍、
        // 超出部分也不裁切。
        this.baseW = Math.max(16, Math.round(width / scale));
        this.baseH = Math.max(16, Math.round(height / scale));
        this.zoom = 1;

        this._bin.set_child(new St.Widget({
            content,
            x_expand: true,
            y_expand: true,
            // 内容按 actor 尺寸缩放，避免 2x 屏上溢出
            content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
        }));

        // 初始尺寸不超过屏幕 85%
        const fit = Math.min(1,
            global.stage.width * 0.85 / this.baseW,
            global.stage.height * 0.85 / this.baseH);
        this.zoom = fit;

        const w = Math.max(16, Math.round(this.baseW * this.zoom));
        const h = Math.max(16, Math.round(this.baseH * this.zoom));
        this.actor.set_size(w, h);
        this.actor.set_position(
            Math.clamp(Math.round(rect.x), 0, Math.max(0, global.stage.width - w)),
            Math.clamp(Math.round(rect.y), 0, Math.max(0, global.stage.height - h)));

        Log.debug('贴图尺寸 物理' + width + 'x' + height + ' scale=' + scale +
            ' 逻辑' + this.baseW + 'x' + this.baseH + ' 显示' + w + 'x' + h);
    }

    contains(x, y) {
        const a = this.actor;
        return !!a && a.visible &&
            x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
    }

    raise() {
        Main.uiGroup.set_child_above_sibling(this.actor, null);
    }

    getOpacity() {
        return this.actor.opacity / 255;
    }

    setOpacity(v) {
        this.actor.opacity = Math.clamp(Math.round(v * 255), 16, 255);
    }

    toggleZoom() {
        this.zoom = this.zoom > 1.01 ? 1 : 1.8;
        this.actor.set_size(
            Math.min(Math.round(this.baseW * this.zoom),
                Math.round(global.stage.width * 0.95)),
            Math.min(Math.round(this.baseH * this.zoom),
                Math.round(global.stage.height * 0.95)));
        Log.debug('贴图缩放 -> ' + this.zoom.toFixed(2));
    }

    show() {
        this.actor.show();
        this.raise();
    }

    hide() {
        this.dragging = false;
        this.actor.hide();
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
        this._bin = null;
    }
}

const POOL_MAX = 6;

/**
 * 贴图管理。
 *
 * 三条硬约束（都踩过）：
 *  1. 绝不 grab：会锁死全屏输入。
 *  2. 关闭时不 destroy 指针底下的 actor：Clutter 会丢指针焦点，
 *     之后一段时间事件不派发。改为 hide + 进复用池。
 *  3. 不依赖 Clutter 的按钮掩码（本机右键报 0x200，无法区分左右键），
 *     全部按键判定由 evdev 层完成，这里只按坐标做命中测试。
 */
export class StickManager {
    constructor(opts = {}) {
        this._sticks = [];
        this._pool = [];
        this._opts = opts;
        this._active = null;
        this._dragOffset = null;
        this._monitorsId = 0;
    }

    get count() {
        return this._sticks.length;
    }

    enable() {
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._reclampAll());
    }

    disable() {
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        for (const s of this._sticks)
            s.destroy();
        for (const s of this._pool)
            s.destroy();
        this._sticks = [];
        this._pool = [];
        this._active = null;
    }

    add(bytes, rect, opts = {}) {
        const stick = this._pool.pop() ?? this._acquire();
        stick.setImage(bytes, rect);
        stick.actor.opacity = Math.clamp(
            Math.round((opts.opacity ?? this._opts.opacity ?? 1) * 255), 16, 255);
        stick.show();
        stick.lastClick = 0;
        this._sticks.push(stick);
        this._active = stick;
        Log.info('贴图创建 ' + stick.actor.width + 'x' + stick.actor.height +
            ' @' + stick.actor.x + ',' + stick.actor.y);
        return stick;
    }

    _acquire() {
        const stick = new StickWindow(this._opts);
        Main.uiGroup.add_child(stick.actor);
        return stick;
    }

    _reclampAll() {
        for (const s of this._sticks) {
            s.actor.set_position(
                Math.clamp(s.actor.x, 0, Math.max(0, global.stage.width - s.actor.width)),
                Math.clamp(s.actor.y, 0, Math.max(0, global.stage.height - s.actor.height)));
        }
    }

    /** 指针命中测试（逻辑坐标）。 */
    hitTest(x, y) {
        return this._topAt(x, y) !== null;
    }

    /** 处理一次鼠标事件；返回 true 表示这次事件被贴图消费掉。 */
    handlePress(x, y, button) {
        const hit = this._topAt(x, y);
        if (!hit) {
            this._active = null;
            return false;
        }
        this._active = hit;
        hit.raise();

        if (button === 'right') {
            this.close(hit);
            return true;
        }
        if (button !== 'left')
            return true;

        const now = Date.now();
        if (now - hit.lastClick < 300)
            hit.toggleZoom();
        hit.lastClick = now;
        hit.dragging = true;
        this._dragOffset = [x - hit.actor.x, y - hit.actor.y];
        return true;
    }

    handleRelease() {
        const stick = this._sticks.find(s => s.dragging);
        if (!stick)
            return false;
        stick.dragging = false;
        this._dragOffset = null;
        return true;
    }

    handleMotion(x, y) {
        const stick = this._sticks.find(s => s.dragging);
        if (!stick)
            return false;
        stick.actor.set_position(
            Math.round(x - this._dragOffset[0]),
            Math.round(y - this._dragOffset[1]));
        return true;
    }

    handleWheel(x, y, dir) {
        const hit = this._topAt(x, y);
        if (!hit)
            return false;
        if (dir === 'up')
            hit.setOpacity(hit.getOpacity() + 0.05);
        else if (dir === 'down')
            hit.setOpacity(hit.getOpacity() - 0.05);
        return true;
    }

    closeActive() {
        if (!this._active)
            return false;
        this.close(this._active);
        return true;
    }

    closeAll() {
        for (const s of [...this._sticks])
            this.close(s);
    }

    close(stick) {
        const i = this._sticks.indexOf(stick);
        if (i >= 0)
            this._sticks.splice(i, 1);
        if (this._active === stick)
            this._active = this._sticks[this._sticks.length - 1] ?? null;

        stick.hide();
        Log.info('关闭贴图，剩 ' + this._sticks.length);

        if (this._pool.length < POOL_MAX)
            this._pool.push(stick);
        else
            stick.destroy();
    }

    _topAt(x, y) {
        for (let i = this._sticks.length - 1; i >= 0; i--) {
            if (this._sticks[i].contains(x, y))
                return this._sticks[i];
        }
        return null;
    }
}
