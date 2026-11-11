/** 手势几何：重采样、归一化、模板匹配、矩形方向判定。 */

export function pathLength(points) {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i - 1][0];
        const dy = points[i][1] - points[i - 1][1];
        len += Math.hypot(dx, dy);
    }
    return len;
}

/** 按弧长等距重采样成 n 个点。 */
export function resample(points, n = 32) {
    if (points.length < 2)
        return points.slice();

    const total = pathLength(points);
    if (total < 1e-6)
        return [points[0].slice()];

    const step = total / (n - 1);
    const out = [points[0].slice()];
    let d = 0;
    let i = 1;
    let prev = points[0];

    while (i < points.length) {
        const cur = points[i];
        const seg = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
        if (d + seg >= step && seg > 1e-9) {
            const t = (step - d) / seg;
            const p = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
            out.push(p);
            prev = p;
            d = 0;
        } else {
            d += seg;
            prev = cur;
            i++;
        }
        if (out.length === n)
            break;
    }
    while (out.length < n)
        out.push(points[points.length - 1].slice());
    return out;
}

/** 平移到原点、等比缩放到 size 方框。 */
export function normalize(points, size = 100) {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(...xs) - minX;
    const h = Math.max(...ys) - minY;
    const s = Math.max(w, h) || 1;
    return points.map(p => [(p[0] - minX) / s * size, (p[1] - minY) / s * size]);
}


function signedArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        a += x1 * y2 - x2 * y1;
    }
    return a / 2;
}

function distToSegment(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9)
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 路径上任意点到某点的最近距离。 */
function minDistTo(points, target) {
    let best = Infinity;
    for (const p of points)
        best = Math.min(best, Math.hypot(p[0] - target[0], p[1] - target[1]));
    return best;
}

/**
 * 判定“画框”（闭合四边形）。
 *
 * 判据（不依赖角点检测，抗抖动）：
 *  1) 首尾距离 <= closeRatio * 对角线（闭合）
 *  2) 包围盒两边都 >= minSize
 *  3) 多边形面积 >= fillRatio * 包围盒面积（形似四边形，排除来回划线）
 *  4) 包围盒四个角都被轨迹经过（排除圆、三角、"U 形"回环）
 *
 * 屏幕坐标 y 向下，有向面积 > 0 即视觉顺时针。
 *
 * @returns {{clockwise: boolean, bbox: {x:number,y:number,w:number,h:number}, area: number}|null}
 */
export function detectRectangle(points, opts = {}) {
    const {
        minSize = 80,
        closeRatio = 0.35,
        fillRatio = 0.55,
        cornerRatio = 0.16,
    } = opts;
    if (points.length < 8)
        return null;

    // 轻微去抖：相邻点距离过近就跳过，减少手抖噪声
    const pts = [];
    for (const p of points) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1.5)
            pts.push(p);
    }
    if (pts.length < 8)
        return null;

    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const w = maxX - minX;
    const h = maxY - minY;
    if (w < minSize || h < minSize)
        return null;

    const diag = Math.hypot(w, h);
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) > closeRatio * diag)
        return null;

    const area = Math.abs(signedArea(pts));
    if (area < fillRatio * w * h)
        return null;

    // 四个角是否都被走线覆盖（含起点回扣）
    const corners = [
        [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
    ];
    const tol = Math.max(10, diag * cornerRatio);
    for (const corner of corners) {
        if (minDistTo(pts, corner) > tol)
            return null;
    }

    return {
        clockwise: signedArea(pts) > 0,
        bbox: {x: minX, y: minY, w, h},
        area,
    };
}

/** 折线到自身的长度，用于调试输出。 */
