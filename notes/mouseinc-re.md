# MouseInc 逆向笔记

样本：`ref/mouseinc/extract/A/MouseInc.exe`（2.13.4，1243648 字节，PE32 i386 原生 C++）
另有一份 2.11.7（`extract/B/`）用于对照。样本按 `.gitignore` 不入库。

## 静态结论

- 纯原生 Win32 + GDI+（导入表里有 `gdiplus.dll`），无 .NET / Electron / Qt。
- 五个节，熵都不高（.text 6.79），**没有加壳**，可以直接反汇编。
- 宽字符串里能直接读到功能骨架：
  `GestureMatch Init` / `Load gesture %S size %d` / `GestureMgr Init` / `tNewGestureWindow` /
  `WheelEdge Init` / `GestureWindow` / `WmiSetBrightness` / `Select * from WmiMonitorBrightnessMethods` /
  `ocr error %S` / `parse ocr error` / `sparse ocr error`。
- 亮度用 WMI（`WmiMonitorBrightnessMethods`），音量用 `SendInput` 发 `Volume Up/Down/Mute` 虚拟键。
- 手势模板不是硬编码：随包 `MouseInc.json` 的 `Gestures` 数组里就是 36 条归一化折线
  （0..100 方框，y 向下），形如 `{"Sign":"C","Data":[50,0, 30,4, ...]}`。扩展的
  `lib/templates.js` 直接由 `scripts/gen_templates.py` 从这份数据机械转换，不含任何原程序代码。

## 行为配置（MouseInc.json 直接可读）

```jsonc
"MouseGesture": {
  "StartDistance": 10,   // 触发距离
  "Timeout": 1000,       // 手势超时
  "DrawTrace": true, "TraceWidth": 3, "DrawColor": "#E47542"
},
"WheelEdge": {
  "Left":  {"UpActions": [["SendKeys","VolumeUp"]], ...},
  "Right": {"UpActions": [["SetBrightness","Up"]], ...}
}
```

注意官方默认是「左边缘音量、右边缘亮度」，本项目按需求反过来（左亮度、右音量），
在 `config.json` 里可随时调回。

贴图/OCR 的语义来自 `docs/action.md`：`["Screenshot","Stick"]` 贴图、
`["Screenshot","OCR"]` 截图后 OCR 并把结果放剪贴板（官方实现走有道 OCR 接口，
本项目改为本地 RapidOCR，离线、无隐私外发）。

## 没做的事

- 没有对 `.text` 段做反编译：这套功能的行为契约已经从配置 + 手册 + 字符串里拿全了，
  继续逆汇编对复刻没有增量信息。真要抠细节（比如模板匹配的具体距离函数），
  可以从 `GestureMatch Init` 附近的交叉引用入手。
- 手势的「字母/符号」模板只在 `templateActions` 非空时才参与匹配，默认不启用。
