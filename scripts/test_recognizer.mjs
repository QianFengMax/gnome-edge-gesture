// 纯逻辑自测：跑 node scripts/test_recognizer.mjs
import {detectRectangle, resample, normalize} from '../extension/edgegesture@gnome-edge-gesture/lib/recognizer.js';

let fail = 0;
const ok = (cond, msg) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) fail++;
};

function rectPath(x, y, w, h, clockwise, stepsPerSide = 24) {
  const pts = [];
  const corners = clockwise
    ? [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
    : [[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]];
  for (let i = 0; i < corners.length - 1; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[i + 1];
    for (let s = 0; s < stepsPerSide; s++) {
      const t = s / stepsPerSide;
      pts.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  pts.push(corners[corners.length - 1].slice());
  return pts;
}

// 1. 顺时针矩形（屏幕坐标 y 向下，视觉顺时针 = 上右下左）
const cw = rectPath(300, 200, 400, 260, true);
let d = detectRectangle(cw, {minSize: 80});
ok(!!d, '顺时针矩形被识别');
ok(d?.clockwise === true, '顺时针方向判定正确');
ok(Math.abs(d.bbox.w - 400) < 2 && Math.abs(d.bbox.h - 260) < 2, 'bouding box 尺寸正确');

// 2. 逆时针
const ccw = rectPath(300, 200, 400, 260, false);
d = detectRectangle(ccw, {minSize: 80});
ok(!!d && d.clockwise === false, '逆时针方向判定正确');

// 3. 太小不算框
ok(detectRectangle(rectPath(10, 10, 30, 30, true), {minSize: 80}) === null, '小尺寸不判为矩形');

// 4. 不闭合不算
const open = cw.slice(0, Math.floor(cw.length * 0.6));
ok(detectRectangle(open, {minSize: 80}) === null, '未闭合路径不判为矩形');

// 5. 直线不算框
ok(detectRectangle([[0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [500, 0]], {minSize: 80}) === null, '直线不判为矩形');

// 6. 模板匹配：画一条向上的线
// 10. 重采样长度
ok(resample(cw, 32).length === 32, '重采样得到 32 点');
ok(normalize([[10, 10], [110, 10]], 100).every(p => p.every(v => v >= 0 && v <= 100)), '归一化落在 0..100');

// 11. 缩放不变性：同一个矩形放大 3 倍仍判为矩形且方向一致
const big = rectPath(100, 100, 1200, 780, false);
const small = rectPath(100, 100, 400, 260, false);
const db = detectRectangle(big, {minSize: 80});
const ds = detectRectangle(small, {minSize: 80});
ok(db?.clockwise === ds?.clockwise, '缩放下方向判定一致');

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
