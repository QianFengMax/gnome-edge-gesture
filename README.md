# GNOME Edge Gesture

给 GNOME Shell 加上「屏幕边缘滚轮」和「右键画框 OCR」——把 MouseInc 那套手感搬到 Linux/Wayland。

<p align="left">
  <img alt="GNOME Shell" src="https://img.shields.io/badge/GNOME%20Shell-49%20%7C%2050-blue">
  <img alt="Wayland" src="https://img.shields.io/badge/session-Wayland-green">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-lightgrey">
  <img alt="AI Generated" src="https://img.shields.io/badge/code-AI%20generated-orange">
</p>

> **本项目全部代码由 AI 生成**，经真机反复调试而成。详见 [AI 生成说明](#ai-生成说明)。

## 功能

| 操作 | 效果 |
|---|---|
| 指针贴屏幕**左边缘**滚轮 | 调节屏幕亮度（无需 root） |
| 指针贴屏幕**右边缘**滚轮 | 调节音量（弹原生 OSD） |
| 按住右键**顺时针**画一个框 | 框选区域 → 本地 OCR → 文本进剪贴板 |

## 为什么需要它

MouseInc 是 Windows 上的鼠标增强工具，屏幕边缘滚轮调亮度/音量是它最顺手的功能之一。
GNOME 没有等价物，Wayland 下又限制了全局输入钩子，所以用扩展 + evdev 直接实现。

## 环境要求

- GNOME Shell 49 / 50，Wayland 会话（X11 未测试）
- 用户在 `input` 组（读取 `/dev/input/event*` 必需）
- 亮度调节依赖背光设备或 logind（自动探测，无需 root）

```bash
# 把自己加进 input 组（需要重新登录生效）
sudo usermod -aG input $USER
```

## 安装

```bash
git clone https://github.com/QianFengMax/gnome-edge-gesture.git
cd gnome-edge-gesture

# 1. 装扩展
./scripts/install.sh

# 2. OCR 后端（二选一）
#    a) Rust 版：快 2~3 倍，推荐
./scripts/build-ocr-rs.sh
#    b) Python 版：无需编译
python3 -m venv .venv
.venv/bin/pip install rapidocr-onnxruntime
```

**Wayland 下新装扩展必须注销重登**才会被 shell 扫描到（X11 可以 `Alt+F2` → `r`）。

## 使用与调参

配置在 `extension/edgegesture@gnome-edge-gesture/config.json`：

```jsonc
{
  "edge": {
    "margin": 28,          // 边缘感应带宽度（像素）
    "left": "brightness",  // left/right/top/bottom: brightness | volume | none
    "right": "volume",
    "step": 0.05,          // 每格滚轮步长
    "cooldownMs": 20
  },
  "gesture": {
    "startDistance": 12,   // 超过这个位移才开始画框
    "timeoutMs": 3000,     // 按住不动多久放弃
    "rectCw": "ocr",       // 顺时针画框的动作
    "rectCcw": "none"
  },
  "ocr": {
    "backend": "rust",     // rust | python
    "binary": "bin/edgegesture-ocr",
    "copyText": true
  }
}
```

改完热重载，**不用注销**：

```bash
./scripts/reload.sh
```

> 例外：改 `extension.js`（代理层）或 `metadata.json` 仍需注销一次。

## 项目结构

```
extension/edgegesture@gnome-edge-gesture/
  extension.js          重载代理（30 行，只负责动态加载 impl.js）
  impl.js               真正的入口
  lib/inputSource.js    evdev 事件源（设备枚举、重连、解析）
  lib/edgeWheel.js      边缘滚轮
  lib/brightness.js     亮度（三级后端）
  lib/volume.js         音量（Gvc）
  lib/gesture.js        右键手势状态机
  lib/recognizer.js     矩形判定（纯函数，有单测）
  lib/overlay.js        轨迹绘制
  lib/screenshot.js     区域截图 / 剪贴板
  lib/ocr.js            OCR 子进程桥（Rust 优先，Python 兜底）
  lib/logger.js         分级日志（1MiB 轮转）

ocr-rs/                 Rust OCR（PP-OCRv3，手写 DB 后处理）
backend/ocr_cli.py      Python OCR 后端
scripts/
  install.sh            装扩展
  reload.sh             热重载（不注销）
  build-ocr-rs.sh       构建 Rust OCR
tests/selftest@.../     隔离 headless shell 的端到端自测
```

## 性能

OCR 内部推理耗时（本机 aarch64 SM8550 实测）：

| 场景 | Python | Rust |
|---|---|---|
| 单行 700×120 | 636ms | **252ms** |
| 6 行 840×460 | 973ms | **468ms** |
| 5 行 600×400 | 679ms | **445ms** |

Rust 的优势主要在进程启动（66ms vs 460ms），推理本身只快 1.5~2 倍。

## 实现要点（都是踩过的坑）

### 1. 必须直读 evdev，不能依赖 Clutter 事件

真实会话里滚轮事件直接转发给指针下的客户端窗口，**根本不经过 shell 的 stage**。
嵌套测试能过是因为那里没有客户端窗口。同理，Clutter 报的按钮掩码在本机是
`0x200`（文档说右键应该是 `0x400`），无法可靠区分左右键。

### 2. evdev 的 fd 绝对不能重复打开

`Gio.File.read()` 有内部缓存，`close()` 之后 fd 仍可能被 libgio 持有。
连续 disable/enable 会累积同一设备的多个 fd，而 **evdev 按 fd 分发事件（不是广播）**，
多个读取者互相抢，表现为「功能时灵时不灵、方向错乱」。

修法：用 `GLib.open()` + `GioUnix.InputStream{close_fd:true}` 绕开缓存，
`Gio.Cancellable` 取消挂起读取，实例级 `_alive` 守卫防旧 reader 残留。

### 3. 不要销毁指针底下的 actor

Clutter 会丢掉指针焦点，之后所有按下都不派发。贴图类功能应该 hide + 复用池。

### 4. 不要用 `Main.pushModal`

它抬高 `Main.modalCount`，会把后续手势判定全挡掉。

### 5. OCR 检测阶段不能放大

RapidOCR 默认 `limit_type=min` 把短边放大到 736，700×120 的细长图会被撑成 4288×736，
检测从 311ms 涨到 1295ms。注意 RapidOCR 的 `__init__` **忽略 `config_path`**，
只认包内 config.yaml，必须用 `det_limit_type=` 这类带前缀的 kwargs。

### 6. ONNX Runtime 每进程只允许一个 Environment

Rust 里 det 和 rec 必须共享，否则报 `only one environment is allowed per process`。

## 已知限制

- **边缘滚轮只监听不拦截**：窗口仍会收到这次滚动（边缘 28px 内通常是边框/桌面）。
  彻底拦截需要 uinput 重新注入，代价大得多。
- X11 会话未测试。
- 贴图（逆时针画框）功能早期实现过，因体验问题移除，保留 `rectCcw` 配置位。

## 开发

```bash
# 算法单测（秒级）
node scripts/test_recognizer.mjs

# 端到端：拉起隔离的 headless gnome-shell，用虚拟指针真画框真滚轮
dbus-run-session -- ./scripts/test_in_nested_shell.sh
```

端到端会检查：边缘判定、截图尺寸、OCR 识别正确性、grab/modalCount 未被污染。

调试日志：

```bash
tail -f extension/edgegesture@gnome-edge-gesture/logs/edgegesture.log
```

## AI 生成说明

**本项目的全部代码由 AI 生成。**

- 需求、调试方向、真机验证由人类完成
- 代码编写、问题定位、重构由 AI 完成
- 项目起源于复刻 [MouseInc](https://docs.shuax.com/MouseInc/) 的交互，但**未使用其任何源代码**
  （MouseInc 是闭源 Windows 软件）。手势模板数据来自其公开配置文件，属机械转换。

遇到问题请提 Issue，但请注意 AI 生成的代码可能在某些边缘场景存在未覆盖的情况。

## 许可

MIT
