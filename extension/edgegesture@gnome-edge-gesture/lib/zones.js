/**
 * 屏幕边缘带的几何判定（纯函数，可单测）。
 *
 * 抽出来的原因：边缘滚轮和「提前扣设备」两块逻辑必须用同一套判定，
 * 否则会出现「扣了却不吞」或者「吞了却不算边缘」的错位。以前两处各写
 * 一份，改一边忘一边就会出这种问题。
 *
 * 四角归属最近的边，多显示器取包含该点的那个；点不在任何显示器上返回 null。
 *
 * @param {Array<{x:number,y:number,w:number,h:number}>} monitors
 * @param {number} x @param {number} y 指针坐标
 * @param {number} margin 边缘带宽度（px，可为负，表示只认真正贴边）
 * @returns {'left'|'right'|'top'|'bottom'|null}
 */
export function zoneAt(monitors, x, y, margin) {
    const m0 = margin ?? 28;
    for (const m of monitors ?? []) {
        if (x < m.x || x >= m.x + m.w || y < m.y || y >= m.y + m.h)
            continue;
        const cands = [
            [x - m.x, 'left'],
            [m.x + m.w - x, 'right'],
            [y - m.y, 'top'],
            [m.y + m.h - y, 'bottom'],
        ].filter(([d]) => d <= m0).sort((a, b) => a[0] - b[0]);
        return cands[0]?.[1] ?? null;
    }
    return null;
}

/** 点是否落在任意一条边的 margin 带宽内（不考虑该边有无动作）。 */
export function inBand(monitors, x, y, margin) {
    return zoneAt(monitors, x, y, margin) !== null;
}

/**
 * 是否值得为此提前扣留设备：落在「边缘带 + 余量」里，且那条边配了动作。
 * @param {object} cfg 配置
 * @param {Array} monitors
 */
export function wantsGrab(cfg, monitors, x, y, armPad) {
    const margin = (cfg?.edge?.margin ?? 28) + (armPad ?? 0);
    const zone = zoneAt(monitors, x, y, margin);
    if (!zone)
        return false;
    const action = cfg?.edge?.[zone];
    return !!action && action !== 'none';
}
