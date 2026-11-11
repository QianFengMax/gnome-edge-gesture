#!/bin/bash
# 在一次性 headless gnome-shell 里加载扩展并跑注入式自测。
#
# 隔离手段：独立 DBus（dbus-run-session 提供）、独立 XDG_DATA_HOME / CONFIG / CACHE、
# 独立 GSettings keyfile 后端、独立 XDG_RUNTIME_DIR。不触碰真实会话的扩展与设置。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/.tmp/nested"
EXT_UUID="edgegesture@gnome-edge-gesture"
TEST_UUID="edgegesture-selftest@gnome-edge-gesture"

rm -rf "$WORK"
mkdir -p "$WORK/data/gnome-shell/extensions" "$WORK/config" "$WORK/cache"
chmod 700 "$WORK/run" 2>/dev/null || true
ln -sfn "$ROOT/extension/$EXT_UUID" "$WORK/data/gnome-shell/extensions/$EXT_UUID"
ln -sfn "$ROOT/tests/selftest@gnome-edge-gesture" "$WORK/data/gnome-shell/extensions/$TEST_UUID"

# 不覆盖 XDG_RUNTIME_DIR：Gvc/PipeWire 的音量通道要靠它找到 socket，
# wayland socket 名字已经唯一（wayland-edgegesture），不需要隔离目录。
export XDG_DATA_HOME="$WORK/data"
export XDG_CONFIG_HOME="$WORK/config"
export XDG_CACHE_HOME="$WORK/cache"
export GSETTINGS_BACKEND=keyfile

gsettings set org.gnome.shell enabled-extensions "['$EXT_UUID', '$TEST_UUID']" 2>/dev/null
gsettings set org.gnome.shell disable-extension-version-validation true 2>/dev/null

LOG="$WORK/shell.log"
SELFTEST_OUT="$WORK/selftest.txt"
rm -f "$SELFTEST_OUT"

gnome-shell --headless --virtual-monitor 1600x1000 \
    --wayland-display=wayland-edgegesture > "$LOG" 2>&1 &
SHELL_PID=$!

cleanup() {
  kill "$SHELL_PID" 2>/dev/null
  wait "$SHELL_PID" 2>/dev/null
}
trap cleanup EXIT

for _ in $(seq 1 80); do
  if gdbus introspect --session --dest org.gnome.Shell.Extensions \
      --object-path /org/gnome/Shell/Extensions >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

for _ in $(seq 1 60); do
  if [ -f "$SELFTEST_OUT" ] && grep -q "selftest 结束" "$SELFTEST_OUT" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "==== 自测输出 ===="
cat "$SELFTEST_OUT" 2>/dev/null || echo "(无输出)"
echo
echo "==== 扩展报错 ===="
grep -iE "JS ERROR|edgegesture.*Error|Error:.*edgegesture" "$LOG" | head -30
echo "==== edgegesture 日志 ===="
grep -i "edgegesture" "$LOG" | grep -v "selftest" | head -40