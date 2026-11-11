#!/usr/bin/env python3
"""OCR 命令行桥：PNG 进，纯文本出。

在本机 aarch64 (SM8550) 上做的两处实测优化：

1. 检测阶段：RapidOCR 默认 limit_type=min 会把短边放大到 736。
   700x120 的细长图被撑成 4288x736，检测从 48ms 涨到 1128ms。
   改 limit_type=max + 限制总像素后，细长图回到 ~300ms。

2. 识别阶段：RapidOCR 按原始宽高比缩到高 48，宽度不受限。
   一行 616x33 会变成 48x896，识别 699ms；限制到 480 宽只要 355ms。

实测（840x480 六行中文）：1190ms -> 约 480ms
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

_ENGINE = None

MAX_SHORT_SIDE = 736      # 检测短边上限
MAX_DET_PIXELS = 950_000  # 检测总像素上限
MAX_REC_WIDTH = 480       # 单行识别宽度上限（高固定 48）
REC_HEIGHT = 48


def get_engine():
    """懒加载引擎。

    关键：RapidOCR 的 __init__ 会忽略 config_path，总是读包内 config.yaml。
    要改参数只能通过带前缀的 kwargs（det_/rec_/cls_），由 UpdateParameters
    合并进配置。det_limit_type 必须显式设成 max —— 默认 min 会把短边放大到
    736，700x120 的细长图会被撑成 4288x736，检测从 311ms 涨到 1295ms。
    """
    global _ENGINE
    if _ENGINE is not None:
        return _ENGINE

    import os

    import rapidocr_onnxruntime as _R
    from rapidocr_onnxruntime import RapidOCR

    pkg = os.path.dirname(_R.__file__)
    det_model = os.path.join(pkg, 'models', 'ch_PP-OCRv3_det_infer.onnx')

    _ENGINE = RapidOCR(
        use_angle_cls=False,
        det_limit_type='max',
        det_limit_side_len=MAX_SHORT_SIDE,
        det_model_path=det_model,
    )
    return _ENGINE


def normalize_det_size(img):
    """缩到检测友好的尺寸；只缩不放。"""
    import cv2

    h, w = img.shape[:2]
    scale = 1.0
    short = min(h, w)
    if short > MAX_SHORT_SIDE:
        scale = min(scale, MAX_SHORT_SIDE / short)
    pixels = h * w
    if pixels > MAX_DET_PIXELS:
        scale = min(scale, (MAX_DET_PIXELS / pixels) ** 0.5)
    if scale >= 1.0:
        return img
    return cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                      interpolation=cv2.INTER_AREA)


def cap_rec_width(crops):
    """把每行裁图限制到 MAX_REC_WIDTH，避免长行拖慢整批。"""
    import cv2

    out = []
    for c in crops:
        h, w = c.shape[:2]
        if h == 0 or w == 0:
            continue
        target_w = int(REC_HEIGHT * (w / h))
        target_w = max(1, min(target_w, MAX_REC_WIDTH))
        out.append(cv2.resize(c, (target_w, REC_HEIGHT),
                              interpolation=cv2.INTER_AREA))
    return out


def normalize_results(rec_res: Any, boxes: Any, min_score: float) -> list[dict]:
    """把识别结果和检测框配对成 dict 列表。

    注意 text_recognizer 返回的是 [(text, score), ...]（二元组），
    不含坐标；坐标要按索引从检测框里取。这两个顺序是对齐的。
    """
    out = []
    if not rec_res:
        return out
    for i, item in enumerate(rec_res):
        try:
            text, score = item[0], item[1]
        except (IndexError, TypeError):
            continue
        if score is not None and float(score) < min_score:
            continue
        x = y = w = h = 0.0
        if boxes is not None and i < len(boxes):
            box = boxes[i]
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            x, y = min(xs), min(ys)
            w, h = max(xs) - x, max(ys) - y
        out.append({'text': str(text),
                    'score': float(score) if score is not None else None,
                    'x': x, 'y': y, 'w': w, 'h': h})
    return out


def merge_lines(items: list[dict]) -> str:
    if not items:
        return ''
    items = sorted(items, key=lambda i: (i['y'], i['x']))
    heights = sorted(i['h'] for i in items)
    tol = max(6.0, heights[len(heights) // 2] * 0.6)

    lines: list[list[dict]] = []
    for it in items:
        placed = False
        for line in lines:
            if abs(it['y'] - line[0]['y']) <= tol:
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


def recognize(img, min_score=0.3):
    """完整流水线，返回 (items, text, timing)。"""
    import time

    eng = get_engine()
    t0 = time.perf_counter()

    small = normalize_det_size(img)
    t1 = time.perf_counter()

    boxes, _ = eng.text_detector(small)
    t2 = time.perf_counter()

    items: list[dict] = []
    text = ''
    if boxes is not None and len(boxes) > 0:
        crops = cap_rec_width(eng.get_crop_img_list(small, boxes))
        if crops:
            rec_res, _ = eng.text_recognizer(crops)
            items = normalize_results(rec_res, boxes, min_score)
            text = merge_lines(items)
    t3 = time.perf_counter()

    timing = {
        'norm': round(1000 * (t1 - t0)),
        'det': round(1000 * (t2 - t1)),
        'rec': round(1000 * (t3 - t2)),
        'total': round(1000 * (t3 - t0)),
    }
    return items, text, timing


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--lang', default='chi_sim+eng')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--min-score', type=float, default=0.3)
    ap.add_argument('--timing', action='store_true')
    args = ap.parse_args()

    import cv2

    img = cv2.imread(args.image)
    if img is None:
        sys.stderr.write(f'无法读取图片: {args.image}\n')
        return 2

    items, text, timing = recognize(img, args.min_score)

    if args.timing:
        sys.stderr.write(' '.join(f'{k}={v}ms' for k, v in timing.items()) + '\n')

    if args.json:
        json.dump({'lang': args.lang, 'items': items, 'text': text},
                  sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
    else:
        sys.stdout.write(text + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
