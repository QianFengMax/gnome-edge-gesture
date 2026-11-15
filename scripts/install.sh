#!/bin/bash
# 把扩展装到当前用户目录（符号链接，改代码后 disable/enable 即可生效）
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="edgegesture@gnome-edge-gesture"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST")"
if [ -L "$DEST" ] || [ -d "$DEST" ]; then
  echo "已存在：$DEST（重建链接）"
  rm -rf "$DEST"
fi
ln -sfn "$ROOT/extension/$UUID" "$DEST"
echo "链接：$DEST -> $ROOT/extension/$UUID"

if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
  gnome-extensions enable "$UUID" || true
else
  echo "shell 未扫描到扩展：请注销或按 Alt+F2 输入 r 重载（Wayland 下需注销）"
fi

echo
if [ -x "$ROOT/bin/edgegesture-input" ]; then
  echo "边缘拦截器：已编译 ✓（边缘滚轮不会传给窗口）"
else
  echo "边缘拦截器：未编译 ✗ —— 边缘滚轮会同时滚一下窗口"
  echo "  编译：./scripts/build-inputguard.sh"
fi

echo
echo "OCR 后端："
echo "  python: $ROOT/.venv/bin/python3"
echo "  script: $ROOT/backend/ocr_cli.py"
if [ ! -x "$ROOT/.venv/bin/python3" ]; then
  echo "  !! 未装后端，先跑：python3 -m venv .venv && .venv/bin/pip install onnxruntime rapidocr-onnxruntime pillow"
fi
