#!/usr/bin/env python3
"""把 MouseInc 配置里的 Gestures 段转成扩展可直接 import 的 JS 模块。

输入: ref/mouseinc/extract/A/MouseInc.json
输出: extension/edgegesture@gnome-edge-gesture/lib/templates.js

只做数据形状转换（折线顶点 -> 归一化 0..100 坐标），不包含原程序任何代码。
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'ref/mouseinc/extract/A/MouseInc.json')
DST = os.path.join(ROOT, 'extension/edgegesture@gnome-edge-gesture/lib/templates.js')


def main():
    with open(SRC, encoding='utf-8-sig') as f:
        cfg = json.load(f)
    lines = []
    lines.append('// 由 scripts/gen_templates.py 从 MouseInc 配置的 Gestures 段机械转换而来。')
    lines.append('// 模板点列已归一化到 0..100 的单位方框（原点左上、y 向下）。')
    lines.append('')
    lines.append('export const RAW_TEMPLATES = [')
    for g in cfg['Gestures']:
        data = g['Data']
        pts = [(data[i], data[i + 1]) for i in range(0, len(data), 2)]
        name = json.dumps(g['Sign'], ensure_ascii=False)
        body = ', '.join('[%g, %g]' % p for p in pts)
        lines.append('    {name: %s, points: [%s]},' % (name, body))
    lines.append('];')
    lines.append('')
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    print('wrote', DST, 'templates:', len(cfg['Gestures']))


if __name__ == '__main__':
    main()
