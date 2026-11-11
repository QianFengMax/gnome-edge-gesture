#!/bin/bash
# 构建 Rust OCR 并安装到 bin/（含所需模型）
#
# 依赖：Rust 工具链、系统 libonnxruntime（apt install libonnxruntime-dev）
# 模型：从 .venv 里 rapidocr 的目录复制到 bin/models/
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/ocr-rs"

if ! command -v cargo >/dev/null; then
    echo "缺少 cargo，先装 Rust 工具链" >&2
    exit 1
fi

echo "构建中（首次 2~5 分钟，之后增量几秒）..."
cargo build --release

mkdir -p "$ROOT/bin"
cp target/release/edgegesture-ocr "$ROOT/bin/edgegesture-ocr"
chmod +x "$ROOT/bin/edgegesture-ocr"

# 模型：二进制从自身旁边的 models/ 找，也支持 EDGEGESTURE_MODEL_DIR 覆盖
SRC_MODELS=$(find "$ROOT/.venv" -type d -name models -path "*rapidocr*" 2>/dev/null | head -1 || true)
if [ -n "$SRC_MODELS" ] && [ -d "$SRC_MODELS" ]; then
    mkdir -p "$ROOT/bin/models"
    cp "$SRC_MODELS/ch_PP-OCRv3_det_infer.onnx" "$ROOT/bin/models/" 2>/dev/null || true
    cp "$SRC_MODELS/ch_PP-OCRv3_rec_infer.onnx" "$ROOT/bin/models/" 2>/dev/null || true
    echo "已复制模型到 bin/models/"
    ls -lh "$ROOT/bin/models/"
else
    echo "警告: 找不到 rapidocr 模型，需先装 Python 后端：" >&2
    echo "  python3 -m venv .venv && .venv/bin/pip install rapidocr-onnxruntime" >&2
fi

echo
echo "已安装: $ROOT/bin/edgegesture-ocr"
ls -lh "$ROOT/bin/edgegesture-ocr"

