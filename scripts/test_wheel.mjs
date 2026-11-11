// 滚轮方向数学单测：node scripts/test_wheel.mjs
// computeDelta 是纯函数，单独抽出来测，不需要 shell 环境。
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, '../extension/edgegesture@gnome-edge-gesture/lib/edgeWheel.js');
const src = readFileSync(file, 'utf8');

const m = src.match(/export function computeDelta[\s\S]*?\n}/);
if (!m) {
    console.error('FAIL 找不到 computeDelta');
    process.exit(1);
}
const computeDelta = new Function('return ' + m[0].replace('export ', ''))();

let fail = 0;
const near = (a, b) => Math.abs(a - b) < 1e-9;
const ok = (cond, msg) => {
    console.log((cond ? 'PASS ' : 'FAIL ') + msg);
    if (!cond) fail++;
};

const STEP = 0.05;

// 核心回归：上下滚必须符号相反（之前双重取反，两边都变正）
ok(near(computeDelta('up', 1, STEP), 0.05), 'up 1格 -> +0.05');
ok(near(computeDelta('down', 1, STEP), -0.05), 'down 1格 -> -0.05');
ok(near(computeDelta('up', -1, STEP), 0.05), 'up 带负幅度仍按方向 -> +0.05');
ok(near(computeDelta('down', -1, STEP), -0.05), 'down 带负幅度仍按方向 -> -0.05');

// 幅度取绝对值后取整
ok(near(computeDelta('up', 0.2, STEP), 0.05), 'up 0.2格 -> 至少 +0.05');
ok(near(computeDelta('up', 0.4, STEP), 0.05), 'up 0.4格 -> +0.05');
ok(near(computeDelta('up', 1.6, STEP), 0.10), 'up 1.6格 -> +0.10');
ok(near(computeDelta('up', 10, STEP), 0.15), 'up 10格 夹到 3 -> +0.15');
ok(near(computeDelta('down', 10, STEP), -0.15), 'down 10格 夹到 3 -> -0.15');

// 零与噪声
ok(near(computeDelta('up', 0, STEP), 0), '0 幅度 -> 0');
ok(near(computeDelta('up', 1e-9, STEP), 0), '极小噪声 -> 0');

// 水平滚轮
ok(near(computeDelta('right', 1, STEP), 0.05), 'right -> +0.05');
ok(near(computeDelta('left', 1, STEP), -0.05), 'left -> -0.05');

// 步长可配
ok(near(computeDelta('up', 1, 0.1), 0.10), 'step 可配 0.1 -> +0.10');

console.log(fail === 0 ? '\n全部通过' : '\n' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
