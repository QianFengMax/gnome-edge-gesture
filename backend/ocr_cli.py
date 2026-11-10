#!/usr/bin/env python3
"""OCR 命令行桥：PNG 进，纯文本出。

用法:
    ocr_cli.py IMAGE [--lang chi_sim+eng] [--json] [--min-score 0.3]

RapidOCR(onnxruntime) 为默认后端，单次 CPU 推理约 1s（本机 aarch64 实测）。
输出默认是「按行合并、按阅读顺序」的纯文本，方便直接进剪贴板。
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

_ENGINE = None


def get_engine():
    global _ENGINE
    if _ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR
        _ENGINE = RapidOCR()
    return _ENGINE


def normalize(results: Any, min_score: float) -> list[dict]:
    """RapidOCR 返回 [[box, text, score], ...]；统一成 dict 列表。"""
    out = []
    for item in results or []:
        try:
            box, text, score = item[0], item[1], item[2]
        except (IndexError, TypeError):
            continue
        if score is not None and float(score) < min_score:
            continue
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        out.append({
            'text': str(text),
            'score': float(score) if score is not None else None,
            'x': min(xs), 'y': min(ys),
            'w': max(xs) - min(xs), 'h': max(ys) - min(ys),
        })
    return out


def merge_lines(items: list[dict]) -> str:
    """按 y 聚行、行内按 x 排序，用空格拼接。"""
    if not items:
        return ''
    items = sorted(items, key=lambda i: (i['y'], i['x']))
    heights = sorted(i['h'] for i in items)
    tol = max(6.0, heights[len(heights) // 2] * 0.6)

    lines: list[list[dict]] = []
    for it in items:
        placed = False
        for line in lines:
            ref = line[0]
            if abs(it['y'] - ref['y']) <= tol:
                line.append(it)
                placed = True
                break
        if not placed:
            lines.append([it])

    rendered = []
    for line in lines:
        line.sort(key=lambda i: i['x'])
        rendered.append(' '.join(i['text'] for i in line))
    return '\n'.join(rendered)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--lang', default='chi_sim+eng')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--min-score', type=float, default=0.3)
    ap.add_argument('--raw-lines', action='store_true',
                    help='不做行合并，按识别顺序每行一条')
    args = ap.parse_args()

    engine = get_engine()
    results, _elapse = engine(args.image)
    items = normalize(results, args.min_score)

    if args.json:
        json.dump({
            'lang': args.lang,
            'items': items,
            'text': merge_lines(items),
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        return 0

    if args.raw_lines:
        sys.stdout.write('\n'.join(i['text'] for i in items))
    else:
        sys.stdout.write(merge_lines(items))
    sys.stdout.write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
