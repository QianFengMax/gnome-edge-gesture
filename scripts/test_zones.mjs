// 边缘几何单测：node scripts/test_zones.mjs
// zones.js 是纯函数，不需要 shell 环境。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '../extension/edgegesture@gnome-edge-gesture/lib/zones.js');
const src = readFileSync(file, 'utf8')
    .replace(/^export function /gm, 'function ');

const mod = new Function(src + '\nreturn {zoneAt, inBand, wantsGrab};')();
const {zoneAt, inBand, wantsGrab} = mod;

let fail = 0;
const ok = (cond, msg) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + msg);
    if (!cond) fail++;
};

const M = [{x: 0, y: 0, w: 1920, h: 1080}];
const MARGIN = 28;

// 四条边
ok(zoneAt(M, 5, 500, MARGIN) === 'left', '左边缘 -> left');
ok(zoneAt(M, 1915, 500, MARGIN) === 'right', '右边缘 -> right');
ok(zoneAt(M, 500, 5, MARGIN) === 'top', '上边缘 -> top');
ok(zoneAt(M, 500, 1075, MARGIN) === 'bottom', '下边缘 -> bottom');
ok(zoneAt(M, 960, 540, MARGIN) === null, '屏幕中间 -> null');
ok(zoneAt(M, 120, 500, MARGIN) === null, '离边缘 120px -> null');
ok(zoneAt(M, 28, 540, MARGIN) === 'left', '恰好 28px -> left（含边界）');
ok(zoneAt(M, 29, 540, MARGIN) === null, '29px -> null');

// 四角取最近的边
ok(zoneAt(M, 3, 3, MARGIN) === 'left', '左上角归最近边 left');
ok(zoneAt(M, 30, 3, MARGIN) === 'top', '左上方距上边更近 -> top');
ok(zoneAt(M, 1917, 1077, MARGIN) === 'right', '右下角归 right');

// 显示器外
ok(zoneAt(M, -5, 500, MARGIN) === null, '屏幕外 -> null');
ok(zoneAt([], 0, 0, MARGIN) === null, '空显示器列表 -> null');
ok(zoneAt(null, 0, 0, MARGIN) === null, 'null 显示器列表 -> null');

// 多显示器：第二个屏的左上角坐标系偏移
const M2 = [{x: 0, y: 0, w: 1920, h: 1080}, {x: 1920, y: 0, w: 1080, h: 1920}];
ok(zoneAt(M2, 1925, 500, MARGIN) === 'left', '第二屏左边缘（x=1925）-> left');
ok(zoneAt(M2, 2995, 500, MARGIN) === 'right', '第二屏右边缘 -> right');
ok(zoneAt(M2, 2450, 500, MARGIN) === null, '第二屏中间 -> null');

// wantsGrab：只在配了动作的边上建议扣设备
const cfg = {edge: {margin: 28, left: 'brightness', right: 'volume', top: 'none', bottom: 'none'}};
ok(wantsGrab(cfg, M, 5, 500, 0) === true, '左边缘有动作 -> 扣');
ok(wantsGrab(cfg, M, 500, 5, 0) === false, '上边缘没动作 -> 不扣');
ok(wantsGrab(cfg, M, 60, 500, 40) === true, '左边缘 + armPad 40（60px 处）-> 扣');
ok(wantsGrab(cfg, M, 69, 500, 40) === false, '69px 超出 28+40 -> 不扣');
ok(wantsGrab(cfg, M, 60, 500, 0) === false, 'armPad=0 时 60px 不扣');

// inBand
ok(inBand(M, 5, 500, MARGIN) === true, 'inBand 左边缘');
ok(inBand(M, 960, 540, MARGIN) === false, 'inBand 屏幕中间');

console.log(fail === 0 ? '\n全部通过' : '\n' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
