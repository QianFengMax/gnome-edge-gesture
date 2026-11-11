#!/bin/bash
# 热重载扩展：改完 impl.js / lib/*.js / config.json 后跑这个，不用注销。
#
# 原理：extension.js 只是代理，每次 enable 都用带新 query 的 URI
# 重新 import impl.js，所以 ESM 缓存不会挡住改动。
# 例外：改 extension.js 本身（代理层）仍需注销一次。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UUID="edgegesture@gnome-edge-gesture"
EXT="$ROOT/extension/$UUID"
LOG="$EXT/logs/edgegesture.log"

if ! gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
    echo "扩展未安装，先跑 ./scripts/install.sh"
    exit 1
fi

gnome-extensions disable "$UUID" >/dev/null 2>&1
sleep 1
gnome-extensions enable "$UUID" >/dev/null 2>&1
sleep 2

echo "已重载（无需注销）"
printf "运行版本: "
grep "═══ 启用" "$LOG" 2>/dev/null | tail -1 | sed "s/.*启用 edgegesture //; s/ [^ ]*$//"
STATE="$(gnome-extensions info "$UUID" 2>/dev/null | grep -oE "ACTIVE|ERROR|OUT_OF_DATE|INACTIVE" | head -1)"
echo "状态: ${STATE:-未知}"
printf "指针设备: "
grep "指针设备数" "$LOG" 2>/dev/null | tail -1 | sed "s/.*指针设备数: //"
echo "日志: tail -f $LOG"

