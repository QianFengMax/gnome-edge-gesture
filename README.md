# Edge Gesture — GNOME 版 MouseInc 复刻

屏幕边缘滚轮调亮度/音量，右键画框贴图或 OCR。跑在 GNOME Shell 50（Wayland）上，用扩展实现，
不需要 root、不改系统设置、不装 X11 工具。

| 功能 | 触发方式 | 默认动作 |
|---|---|---|
| 边缘滚轮 | 指针贴屏幕左边缘滚轮 | 亮度 ±5%（走 logind，无需 root） |
| 边缘滚轮 | 指针贴屏幕右边缘滚轮 | 音量 ±5%（走 Gvc/PipeWire，弹原生 OSD） |
| 画框贴图 | 按住右键**逆时针**画一个框 | 截图钉在屏幕上：拖动移位、滚轮调透明、双击缩放、右键/Esc 关闭 |
| 画框 OCR | 按住右键**顺时针**画一个框 | 截图 -> 本地 RapidOCR -> 文本进剪贴板 + 浮层显示（Esc 关闭） |

## 目录

```
extension/edgegesture@aiwork.local/   扩展本体（直接 ln 到 ~/.local/share/gnome-shell/extensions/）
  extension.js          入口：装配各模块、处理矩形动作
  config.json           全部可调参数
  lib/edgeWheel.js      边缘滚轮
  lib/brightness.js     亮度（三级后端：Mutter -> logind -> sysfs）
  lib/volume.js         音量（Gvc）
  lib/gesture.js        右键手势状态机（轮询采样）
  lib/recognizer.js     矩形判定 + 模板匹配（纯函数，有单测）
  lib/overlay.js        轨迹 / 矩形预览绘制层
  lib/stick.js          贴图管理
  lib/screenshot.js     区域截图 / 剪贴板
  lib/ocr.js            OCR 子进程桥
  lib/templates.js      MouseInc 手势模板（脚本生成）
backend/ocr_cli.py      RapidOCR 命令行：图片进、文本出
tests/selftest@aiwork.local/   注入式自测扩展（只用于 headless 会话）
scripts/
  install.sh / uninstall.sh     装/卸到当前用户
  test_recognizer.mjs           识别算法单测（node 直接跑）
  test_in_nested_shell.sh       隔离 headless shell 端到端自测
  gen_templates.py              从 MouseInc 配置生成手势模板
  pe_probe.py                   MouseInc.exe 静态探针
ref/mouseinc/                  MouseInc 样本与文档（不进 git）
notes/                         逆向笔记
```

## 安装

```bash
cd ~/AIWORK/项目-projects/gnome-edge-gesture

# 1. OCR 后端（一次性，约 1 分钟）
python3 -m venv .venv
.venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
    onnxruntime rapidocr-onnxruntime pillow

# 2. 装扩展
./scripts/install.sh
```

Wayland 下新扩展必须注销重登才被扫描到（X11 可以 Alt+F2 -> r）。

## 配置

改 `extension/edgegesture@aiwork.local/config.json`，然后：

```bash
gnome-extensions disable edgegesture@aiwork.local
gnome-extensions enable edgegesture@aiwork.local
```

常用项：

```jsonc
{
  "edge": {
    "margin": 28,          // 边缘带宽度（像素）
    "left": "brightness",  // left/right/top/bottom 可设 brightness|volume|none
    "step": 0.05,          // 每格滚轮的步长
    "cooldownMs": 30       // 两次调整的最小间隔
  },
  "gesture": {
    "startDistance": 12,   // 超过这个位移才算开始画
    "timeoutMs": 1500,     // 按住不动多久放弃
    "rectCw": "ocr",       // 顺时针画框的动作：ocr | stick | clipboard | none
    "rectCcw": "stick",    // 逆时针画框的动作
    "templateActions": {}  // 可选：{"UP": "none", "M": "..."}
  },
  "stick": {"opacity": 240}
}
```

## 验证

```bash
# 算法单测（秒级）
node scripts/test_recognizer.mjs

# 端到端：拉起一个隔离的 headless gnome-shell，用虚拟指针真画框、真滚轮
dbus-run-session -- ./scripts/test_in_nested_shell.sh
```

端到端脚本会检查：逆时针->贴图、贴图上右键->关闭、顺时针->OCR 弹窗、OCR 真的识别出屏上文字、
左边缘->亮度上升、右边缘->音量下降。

## 实现要点（踩过的坑）

1. **不要销毁指针底下的 actor**。Clutter 会丢掉指针焦点，之后所有按下都不派发。
   贴图关闭是「dismiss grab -> hide -> 进复用池」。
2. **手势轨迹必须轮询 `global.get_pointer()`**。GNOME 50 上 motion 事件在部分路径不经过 shell 的
   `captured-event`；按下/抬起/滚轮是可靠的，坐标一律取自轮询。
3. **不能用 `Main.pushModal`**。它会抬高 `Main.modalCount`，把手势判定挡死。贴图用
   `global.stage.grab()`（只夺输入、不动 modalCount）。
4. **按下事件可能被别的 actor 吃掉**，所以手势引擎在轮询里做了自愈：检测到「右键按住 + 不在手势态」
   就自己补一次 armed。
5. **亮度三级后端**：`Main.brightnessManager`（Mutter，自动弹 OSD）→ logind
   `Session.SetBrightness`（本机 sysfs 不可写时的主力，需 seat 会话）→ sysfs 直写
   （需要 input/video 组或 udev 规则）。本机实测走 logind。
6. **剪贴板图像**用 `St.Clipboard.set_content(type, 'image/png', bytes)`，Wayland 下原生可用。
