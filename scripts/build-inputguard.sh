#!/bin/bash
# 编译边缘滚轮拦截器（核层 EVIOCGRAB + uinput 重新注入）。
#
# 产物：<项目>/bin/edgegesture-input
# 依赖：只需要 gcc，没有第三方库。aarch64 / x86_64 都能编。
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src/inputguard.c"
OUT="${1:-$ROOT/bin/edgegesture-input}"

if [ ! -f "$SRC" ]; then
    echo "找不到源码：$SRC"
    exit 1
fi
if ! command -v gcc >/dev/null 2>&1 && ! command -v cc >/dev/null 2>&1; then
    echo "需要 gcc：sudo apt install build-essential"
    exit 1
fi
CC="$(command -v gcc || command -v cc)"

# -O2：这是个常驻的热路径，每个事件都要过一遍；-s 去掉符号，产物 ~30K
# nice：编译本身很轻（单文件），但按规矩降载
nice -n 19 "$CC" -O2 -s -Wall -Wextra -o "$OUT" "$SRC"
chmod 755 "$OUT"

echo "已编译：$OUT"
echo "  $("$OUT" --help 2>&1 | head -1)"
echo
echo "权限检查："
if [ -w /dev/uinput ]; then
    echo "  /dev/uinput 可写 ✓"
else
    echo "  /dev/uinput 不可写 ✗ —— 需要 input 组或 udev 规则"
    echo "    sudo usermod -aG input \$USER   # 重新登录生效"
fi
