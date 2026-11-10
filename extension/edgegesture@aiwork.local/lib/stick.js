import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Log from './logger.js';

/** PNG 字节 -> Clutter.Content（保持原始像素，等比显示）。 */
export function imageContentFromBytes(bytes) {
    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
    stream.close(null);

    const cogl = global.stage.context.get_backend().get_cogl_context();
    const content = St.ImageContent.new_with_preferred_size(
        pixbuf.width, pixbuf.height);
    content.set_bytes(cogl,
        pixbuf.read_pixel_bytes(),
        Cogl.PixelFormat.RGBA_8888,
        pixbuf.width, pixbuf.height, pixbuf.rowstride);
    return {content, width: pixbuf.width, height: pixbuf.height};
}

class StickWindow {
    constructor(opts = {}) {
        this.actor = new St.Widget({
            style_class: 'edgegesture-stick',
            reactive: true,
            visible: false,
            opacity: Math.clamp(opts.opacity ?? 240, 24, 255),
        });
        this._bin = new St.Bin({x_expand: true, y_expand: true});
        this.actor.add_child(this._bin);

        this.baseW = 0;
        this.baseH = 0;
        this.dragging = false;
        this.lastClick = 0;
        this.onPress = null;
        this.onScroll = null;
        this.grab = null;

        // 指针落在 reactive actor 上时，按钮事件只投给它，stage 收不到，
        // 所以按下/滚轮必须在这里接。
        this.actor.connect('button-press-event', (_a, event) => {
            this.onPress?.(this, event);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('scroll-event', (_a, event) => {
            this.onScroll?.(this, event);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('key-press-event', (_a, event) => {
            this.onPress?.(this, event, true);
            return Clutter.EVENT_STOP;
        });
    }

    setImage(bytes, rect) {
        const {content, width, height} = imageContentFromBytes(bytes);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const lw = width / scale;
        const lh = height / scale;
        const fit = Math.min(1,
            global.stage.width * 0.92 / lw,
            global.stage.height * 0.92 / lh);

        this._bin.set_child(new St.Widget({content, x_expand: true, y_expand: true}));
        this.baseW = Math.max(24, Math.round(lw * fit));
        this.baseH = Math.max(24, Math.round(lh * fit));
        this.actor.set_size(this.baseW, this.baseH);
        this.actor.set_position(
            Math.clamp(Math.round(rect.x), 0, Math.max(0, global.stage.width - this.baseW)),
            Math.clamp(Math.round(rect.y), 0, Math.max(0, global.stage.height - this.baseH)));
    }

    contains(x, y) {
        const a = this.actor;
        return !!a && a.visible &&
            x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height;
    }

    toggleZoom() {
        const zoomed = this.actor.width > this.baseW + 1;
        this.actor.set_size(
            Math.min(zoomed ? this.baseW : Math.round(this.baseW * 1.6),
                Math.round(global.stage.width * 0.96)),
            Math.min(zoomed ? this.baseH : Math.round(this.baseH * 1.6),
                Math.round(global.stage.height * 0.96)));
    }

    destroy() {
        this.actor?.destroy();
        this.actor = null;
        this._bin = null;
    }
}

const POOL_MAX = 8;

/**
 * 贴图管理。
 *
 * 交互统一在 stage 的 captured-event 里处理，坐标一律取 global.get_pointer()：
 * 合成事件路径下 event.get_coords() 可能给出上一次的位置，用实时指针才不会点错对象。
 * （actor 自己的 button-press-event 在某些注入路径上不触发，captured-event 稳定。）
 *
 * 关闭时不能直接 destroy 指针底下的 actor —— Clutter 会丢掉指针焦点，之后所有
 * 按键/点击都不再派发。做法是先 reactive=false + hide，actor 进复用池。
 */
export class StickManager {
    constructor(opts = {}) {
        this._sticks = [];
        this._pool = [];
        this._opts = opts;
        this._stageId = 0;
        this._active = null;
        this._dragOffset = null;
        this._debug = !!opts.debug;
    }

    get count() {
        return this._sticks.length;
    }

    enable() {
        this._stageId = global.stage.connect('captured-event', (_a, event) => {
            try {
                return this._handle(event);
            } catch (e) {
                Log.log('贴图事件异常', e.message);
                return Clutter.EVENT_PROPAGATE;
            }
        });
    }

    disable() {
        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
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
            opts.opacity ?? this._opts.opacity ?? 240, 24, 255);
        stick.actor.reactive = true;
        stick.actor.show();
        Main.uiGroup.set_child_above_sibling(stick.actor, null);
        try {
            stick.grab = global.stage.grab(stick.actor);
        } catch (e) {
            Log.log('贴图 grab 失败', e.message);
            stick.grab = null;
        }

        stick.lastClick = 0;
        stick.dragging = false;
        this._sticks.push(stick);
        this._active = stick;
        Log.log('贴图创建', stick.actor.x, stick.actor.y,
            stick.actor.width, stick.actor.height);
        return stick;
    }

    _acquire() {
        const stick = new StickWindow(this._opts);
        stick.onPress = (sw, event, isKey) => {
            if (isKey) {
                const sym = event.get_key_symbol();
                if (sym === Clutter.KEY_Escape)
                    this._close(sw);
                else if (sym === Clutter.KEY_space || sym === Clutter.KEY_Return)
                    sw.toggleZoom();
                return;
            }
            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this._close(sw);
                return;
            }
            if (button !== Clutter.BUTTON_PRIMARY)
                return;
            const now = event.get_time();
            if (now - sw.lastClick < 300)
                sw.toggleZoom();
            sw.lastClick = now;
            const [px, py] = global.get_pointer();
            this._dragOffset = [Math.round(px) - sw.actor.x, Math.round(py) - sw.actor.y];
            sw.dragging = true;
            Main.uiGroup.set_child_above_sibling(sw.actor, null);
        };
        stick.onScroll = (sw, event) => {
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP)
                sw.actor.opacity = Math.clamp(sw.actor.opacity + 12, 24, 255);
            else if (dir === Clutter.ScrollDirection.DOWN)
                sw.actor.opacity = Math.clamp(sw.actor.opacity - 12, 24, 255);
        };
        Main.uiGroup.add_child(stick.actor);
        return stick;
    }

    /** 指针是否落在某块可见贴图上。 */
    hitTest(x, y) {
        for (const s of this._sticks) {
            if (s.contains(x, y))
                return true;
        }
        return false;
    }

    closeAll() {
        for (const s of [...this._sticks])
            this._close(s);
    }

    _close(stick) {
        const i = this._sticks.indexOf(stick);
        if (i >= 0)
            this._sticks.splice(i, 1);
        if (this._active === stick)
            this._active = this._sticks[this._sticks.length - 1] ?? null;

        try {
            stick.grab?.dismiss();
        } catch {
            // 已释放
        }
        stick.grab = null;
        stick.dragging = false;
        // 延迟一拍再隐藏：grab dismiss 与 actor 隐藏落在同一帧时，Clutter 会把
        // 指针焦点丢到一个已不可见的对象上，接下来的按下事件全部不派发。
        const actor = stick.actor;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                actor.reactive = false;
                actor.hide();
            } catch {
                // ignore
            }
            return GLib.SOURCE_REMOVE;
        });
        Log.log('关闭贴图，剩', this._sticks.length);

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

    _handle(event) {
        if (this._sticks.length === 0)
            return Clutter.EVENT_PROPAGATE;

        const type = event.type();
        const [gx, gy] = global.get_pointer();
        const x = Math.round(gx);
        const y = Math.round(gy);

        if (type === Clutter.EventType.BUTTON_PRESS) {
            const hit = this._topAt(x, y);
            Log.log('press', x, y, 'btn=' + event.get_button(),
                'hit=' + !!hit, 'n=' + this._sticks.length,
                JSON.stringify(this._sticks.map(s => [s.actor?.x, s.actor?.y, s.actor?.visible])));
            if (!hit) {
                this._active = null;
                return Clutter.EVENT_PROPAGATE;
            }
            this._active = hit;
            Main.uiGroup.set_child_above_sibling(hit.actor, null);

            const button = event.get_button();
            if (button === Clutter.BUTTON_SECONDARY) {
                this._close(hit);
                return Clutter.EVENT_STOP;
            }
            if (button !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_STOP;

            const now = event.get_time();
            if (now - hit.lastClick < 300)
                hit.toggleZoom();
            hit.lastClick = now;
            hit.dragging = true;
            this._dragOffset = [x - hit.actor.x, y - hit.actor.y];
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.MOTION) {
            const stick = this._sticks.find(s => s.dragging);
            if (!stick)
                return Clutter.EVENT_PROPAGATE;
            stick.actor.set_position(
                Math.round(x - this._dragOffset[0]),
                Math.round(y - this._dragOffset[1]));
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const stick = this._sticks.find(s => s.dragging);
            if (!stick)
                return Clutter.EVENT_PROPAGATE;
            stick.dragging = false;
            this._dragOffset = null;
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.SCROLL) {
            const hit = this._topAt(x, y);
            if (!hit)
                return Clutter.EVENT_PROPAGATE;
            const dir = event.get_scroll_direction();
            if (dir === Clutter.ScrollDirection.UP)
                hit.actor.opacity = Math.clamp(hit.actor.opacity + 12, 24, 255);
            else if (dir === Clutter.ScrollDirection.DOWN)
                hit.actor.opacity = Math.clamp(hit.actor.opacity - 12, 24, 255);
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.KEY_PRESS) {
            const sym = event.get_key_symbol();
            if (sym === Clutter.KEY_Escape && this._active) {
                this._close(this._active);
                return Clutter.EVENT_STOP;
            }
            if ((sym === Clutter.KEY_space || sym === Clutter.KEY_Return) && this._active) {
                this._active.toggleZoom();
                return Clutter.EVENT_STOP;
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }
}