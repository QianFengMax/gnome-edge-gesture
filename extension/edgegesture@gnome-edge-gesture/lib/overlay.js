import Clutter from 'gi://Clutter';
import St from 'gi://St';
import cairo from 'gi://cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * 手势轨迹 + 矩形预览的绘制层。
 *
 * 常驻复用：只在手势期间 visible，绘制内容每次 clear 后重画。
 * 不要 destroy 再 new —— 轮询回调里访问已销毁的 actor 会抛异常，
 * 而这个异常发生在 GLib timeout 里，会让整个采样 source 直接停掉。
 */
export class TraceOverlay {
    constructor() {
        this._area = new St.DrawingArea({
            reactive: false,
            can_focus: false,
            visible: false,
        });
        this._area.set_size(global.stage.width, global.stage.height);
        this._area.connect('repaint', area => this._draw(area));
        Main.uiGroup.add_child(this._area);

        this._points = [];
        this._rect = null;
        this._color = [0.894, 0.459, 0.259, 1.0];
        this._width = 3;
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._resize());
        this._destroyed = false;
    }

    get available() {
        return !this._destroyed && !!this._area;
    }

    setStyle({color, width} = {}) {
        if (!this.available)
            return;
        if (color)
            this._color = parseColor(color);
        if (width)
            this._width = width;
    }

    show() {
        if (!this.available)
            return;
        this._resize();
        this._area.show();
        // Clutter 的 raise_top 在 St 上不保证存在，用父容器的置顶接口
        this._area.get_parent()?.set_child_above_sibling(this._area, null);
    }

    hide() {
        if (!this.available)
            return;
        this._points = [];
        this._rect = null;
        this._area.hide();
        this._area.queue_repaint();
    }

    update(points, rect = null) {
        if (!this.available)
            return;
        this._points = points;
        this._rect = rect;
        this._area.queue_repaint();
    }

    clear() {
        this.hide();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        if (this._monitorsId) {
            try {
                Main.layoutManager.disconnect(this._monitorsId);
            } catch {
                // ignore
            }
            this._monitorsId = 0;
        }
        this._points = [];
        this._rect = null;
        try {
            this._area?.destroy();
        } catch {
            // ignore
        }
        this._area = null;
        this._overlayParent = null;
    }

    _resize() {
        if (!this.available)
            return;
        this._area.set_size(global.stage.width, global.stage.height);
        this._area.queue_repaint();
    }

    _draw(area) {
        const cr = area.get_context();
        try {
            cr.save();
            cr.setOperator(cairo.Operator.CLEAR);
            cr.paint();
            cr.restore();

            const [r, g, b] = this._color;

            if (this._rect) {
                const {x, y, w, h} = this._rect;
                cr.setSourceRGBA(r, g, b, 0.12);
                cr.rectangle(x, y, w, h);
                cr.fill();
                cr.setSourceRGBA(r, g, b, 0.9);
                cr.setLineWidth(2);
                cr.rectangle(x, y, w, h);
                cr.stroke();
            }

            if (this._points.length > 1) {
                cr.setLineWidth(this._width);
                cr.setLineCap(cairo.LineCap.ROUND);
                cr.setLineJoin(cairo.LineJoin.ROUND);
                cr.setSourceRGBA(r, g, b, 1);
                cr.moveTo(this._points[0][0], this._points[0][1]);
                for (let i = 1; i < this._points.length; i++)
                    cr.lineTo(this._points[i][0], this._points[i][1]);
                cr.stroke();

                const n = this._points.length;
                const [x1, y1] = this._points[n - 2];
                const [x2, y2] = this._points[n - 1];
                const ang = Math.atan2(y2 - y1, x2 - x1);
                const len = 14;
                cr.moveTo(x2, y2);
                cr.lineTo(x2 - len * Math.cos(ang - 0.5), y2 - len * Math.sin(ang - 0.5));
                cr.lineTo(x2 - len * Math.cos(ang + 0.5), y2 - len * Math.sin(ang + 0.5));
                cr.closePath();
                cr.fill();
            }
        } finally {
            cr.$dispose();
        }
    }
}

export function parseColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!m)
        return [0.894, 0.459, 0.259, 1.0];
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255, 1.0];
}