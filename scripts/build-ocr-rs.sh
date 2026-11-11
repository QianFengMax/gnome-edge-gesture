#!/bin/bash
# 构建 Rust OCR 并安装到 bin/
# 依赖：Rust 工具链、系统 libonnxruntime；模型复用 .venv 里 rapidocr 的 onnx
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

echo
echo "已安装: $ROOT/bin/edgegesture-ocr"
ls -lh "$ROOT/bin/edgegesture-ocr"

