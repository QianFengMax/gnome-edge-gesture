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
| 指针贴屏幕**左边缘**滚轮 | 调节屏幕亮度（无需 root），窗口不会跟着滚 |
| 指针贴屏幕**右边缘**滚轮 | 调节音量（弹原生 OSD），窗口不会跟着滚 |
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

# 1. 编译边缘拦截器（让边缘滚轮不再传给窗口，只需 gcc）
./scripts/build-inputguard.sh

# 2. 装扩展
./scripts/install.sh

# 3. OCR 后端（二选一）
#    a) Rust 版：快 2~3 倍，推荐
./scripts/build-ocr-rs.sh
#    b) Python 版：无需编译
python3 -m venv .venv
.venv/bin/pip install rapidocr-onnxruntime
```

不编译拦截器也能用，只是边缘滚轮会同时滚一下窗口（退回「只观察不拦截」）。

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
    "cooldownMs": 20,
    "swallow": true,       // 边缘滚轮是否在核层吞掉（不让窗口跟着滚）
    "armPad": 40           // 提前扣设备的余量（px），见下文「拦截机制」
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

> 只有改 `extension.js` 本身或 `metadata.json` 才需要注销一次。`impl.js` 和
> `lib/*.js` 都能被 reload.sh 刷新——代理每次 enable 会把当前代码快照到
> `~/.cache/edgegesture/<指纹>/` 再从那里 import，换目录才绕得开 GJS 的
> ESM 缓存（只给 impl.js 加 `?t=` 查询串时，`./lib/x.js` 的相对解析会丢掉
> query，lib 改动永远命中旧实例）。
>
> 亮度后端顺序是 logind → mutter → sysfs：有些 ARM 设备的背光节点在 sysfs
> 里是只读的，`Main.brightnessManager.globalScale` 写不动背光（日志和 OSD 都
> 正常，屏幕不变），所以能探到 logind 就优先用 logind。

## 配置云端 OCR（百度）

打开设置页：**设置 → 扩展 → Edge Gesture → ⚙**
（或命令行 `gnome-extensions prefs edgegesture@gnome-edge-gesture`）

在「OCR 识别」页 →「云端识别」分组：

1. 打开 **启用云端识别**
2. **服务商** 选 `百度 OCR（免费 1000 次/月）`
3. **API Key** / **Secret Key** 填百度智能云控制台里该应用的对应值
   （默认遮成圆点；点行右侧的小眼睛临时看明文，不点就一直隐藏）
4. **语言** 选中文

控制台的三个字段里 **AppID 不用填**，扩展只用 API Key + Secret Key。
改完点右下角**应用**（或直接关窗，也会自动落盘）——窗口底部有状态提示，
「有未保存的改动」变「已应用到 config.json · 时间」就说明写进去了。
扩展监视 `config.json`，保存后会自动重载，不需要注销。

同一页底部「验证」分组点**测试**，会显示 `耗时 · 链路`。
成功应命中 `remote`；失败会回退到本地 Rust/Python，并把原因写进日志。

对应 `config.json` 的写法：

```jsonc
"ocr": {
  "chain": ["remote", "rust", "python"],
  "remote": {
    "provider": "baidu",
    "apiKey": "控制台的 API Key",
    "secretKey": "控制台的 Secret Key",
    "url": "",
    "language": "chs",
    "timeoutMs": 3000
  }
}
```

`chain` 顺序即优先级：云端失败/超时自动退到本地，不会让你白框一次。
云端正常 300~800ms；用高精度版接口时把 `timeoutMs` 调到 5000。

常见报错：

| 报错 | 原因 |
|---|---|
| `百度 token 失败: unknown client id` | API Key 填错或复制时带了空格 |
| `百度 OCR 6: No permission to access data` | 应用没开通「通用文字识别」 |
| `百度 OCR 17: Open api daily request limit reached` | 免费日额度用完 |
| `百度 OCR 110/111: Access token invalid or expired` | Secret Key 填错 |

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
  lib/zones.js          边缘带几何判定（纯函数，有单测）
  lib/inputGuard.js     拦截器桥（子进程 + 行协议）
  lib/edgeGrab.js       何时扣押指针设备的决策层
  lib/recognizer.js     矩形判定（纯函数，有单测）
  lib/overlay.js        轨迹绘制
  lib/screenshot.js     区域截图 / 剪贴板
  lib/ocr.js            OCR 子进程桥（Rust 优先，Python 兜底）
  lib/logger.js         分级日志（1MiB 轮转）

src/inputguard.c       边缘拦截器（EVIOCGRAB + uinput 重新注入）
ocr-rs/                 Rust OCR（PP-OCRv3，手写 DB 后处理）
backend/ocr_cli.py      Python OCR 后端
scripts/
  install.sh            装扩展
  reload.sh             热重载（不注销）
  build-ocr-rs.sh       构建 Rust OCR
  build-inputguard.sh   构建边缘拦截器
  test_zones.mjs        边缘几何单测
  test_inputguard.py    拦截器端到端（真 uinput 注入）
  scroll-probe.py       人工验证窗口（数窗口收到几次滚动）
tests/selftest@.../     隔离 headless shell 的端到端自测
```

## 性能

OCR 内部推理耗时（本机 aarch64 实测）：

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

### 1.5 边缘滚轮要在核层吞掉，不能只观察

第 1 条说的「滚轮不经 stage」同样意味着**扩展没有能力在合成器层拦下滚轮**。
只读 evdev 做不到「不传给窗口」，因为 mutter 自己也有一份 fd。

做法是 `EVIOCGRAB` 独占设备 + 把事件写回一个自建 uinput 设备，
见 `src/inputguard.c`。几个必须踩对的点：

- **不能常驻独占**。只有指针进了「边缘带 + 余量」才 grab，离开立刻放开。
- **两级半径**。`armPad`（默认 40px）决定何时扣，`margin`（默认 28px）
  决定何时吞。提前扣 ≠ 提前改行为：指针在余量里滚，窗口照常滚。
- **只扣一个设备**。本机有实体鼠标和 `keyd virtual pointer` 两个指针，
  两个都扣、都往同一个 uinput 写，运动会重复 → 光标两倍速。所以只扣
  「2 秒内活动过的那一个」。
- **`REL_WHEEL_HI_RES` 要累加**。触摸板/高精度滚轮一次发送几十个单位，
  不换算成「格」会让音量瞬间拉满。
- **子进程一定要能自保**。3 秒收不到心跳就自己 ungrab；扩展关掉 stdin
  时立刻释放。否则扩展一崩，鼠标就被锁死在扩展手里。

### 1.6 拦截器接管时，evdev 读循环不能「取消再重启」

suspend 里 `cancellable.cancel()` + resume 里换新的 cancellable 重启读循环，
看着很自然，实际会踩时序：旧的那次 read 要到新循环启动后才带着「已取消」
错误回来，此时 `is_cancelled()` 已是 false、`_suspended` 也已复位，错误被
当成真故障去 `dev.close()`，把刚被复用的 fd 关掉 —— 症状是日志里的
「错误的文件描述符」，设备从此不再响应。

正确做法是**只置标志，不取消**：读回调结束时不续读，resume 时若没有在途
读取才重新发起。配一个 `dev.reading` 保证任何时刻只有一个读者。

### 2. evdev 的 fd 绝对不能重复打开

`Gio.File.read()` 有内部缓存，`close()` 之后 fd 仍可能被 libgio 持有。
连续 disable/enable 会累积同一设备的多个 fd，而 **evdev 按 fd 分发事件（不是广播）**，
多个读取者互相抢，表现为「功能时灵时不灵、方向错乱」。

修法：用 `GLib.open()` + `GioUnix.InputStream{close_fd:true}` 绕开缓存，
`Gio.Cancellable` 取消挂起读取，实例级 `_alive` 守卫防旧 reader 残留。

### 2.5 设置页的改动用防抖写盘，必须有「应用」按钮兜底

输入框是逐字符触发的，直接写盘会让扩展不停重载，所以 `_onChange` 里攒
500ms 再存。但「填完最后一个字符就点关闭」是常态，定时器还没到，改动就没了
——现象是「填了 key 却还走本地」，很难联想到是这个原因。

两道保险：底部固定「应用」按钮（挂在 `PreferencesWindow` 内部的
`ToolbarView` 上，永远贴在窗口最下方，不会随页面滚走），以及
`close-request` 里兜底 flush。

挑 ToolbarView 要挑对：窗口里有两个，外层装标题栏和全部内容，内层第一个
child 是 `Adw.ViewStack`（页面切换器）。挂到内层才是页面区域的最下面。

### 2.6 密钥输入框要自己接「小眼睛」

`Adw.PasswordEntryRow` 在 libadwaita 1.10 里并没有 peek 图标（只有
`show-apply-button`），所以想要「默认密文 + 点眼睛看明文」得自己搭：

- 用普通 `Adw.EntryRow`，真正的输入框是它内部的 `Gtk.Text`，靠
  `get_delegate()` 拿；给 EntryRow 本身设 visibility 不起作用。
- `set_invisible_char('•')` 的参数**必须传字符串**，传码点会报
  `Expected type string for argument 'ch'`（语义上是 gunichar，但 GJS
  绑定不认数字）。
- 顺手 `set_input_purpose(PASSWORD)`，否则输入法会在候选栏里把密钥明文显示出来。
- 眼睛图标不要写死名字：不同主题的图标集不一样，用
  `Gtk.IconTheme.has_icon()` 探测候选名，优先 `view-reveal-symbolic` /
  `view-conceal-symbolic`，退回 `eye-*` 系列。写死一个名字在别人的机器上
  会渲染成空白方块。

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

- **边缘拦截依赖 uinput**：需要 `/dev/uinput` 可写（在 `input` 组即可）。
  没有权限时自动退回「只观察不拦截」，功能照常，只差窗口会跟着滚一下。
- **只扣一个指针设备**：本机同时存在实体鼠标与 `keyd virtual pointer` 两个
  指针设备，两个都扣会把运动事件往同一个 uinput 转发两次、光标变两倍速，
  所以只扣最近活动的那个。极端情况下（两个设备同时朝不同方向滚动）另一个
  的滚轮不会被吞。
- X11 会话未测试。
- 贴图（逆时针画框）功能早期实现过，因体验问题移除，保留 `rectCcw` 配置位。

## 开发

```bash
# 算法单测（秒级）
node scripts/test_recognizer.mjs
node scripts/test_zones.mjs
node scripts/test_wheel.mjs

# 拦截器端到端（真 uinput 注入，不需要动真鼠标；不在 input 组会 SKIP）
python3 scripts/test_inputguard.py

# 人工验证「窗口还收不收得到边缘滚动」
python3 scripts/scroll-probe.py

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
