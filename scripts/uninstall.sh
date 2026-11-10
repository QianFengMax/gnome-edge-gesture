#!/bin/bash
set -eu
UUID="edgegesture@aiwork.local"
gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "已移除 $UUID"
