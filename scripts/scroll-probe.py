#!/usr/bin/env python3
"""滚动接收器：验证「边缘滚轮不再传给当前窗口」。

用法：python3 scripts/scroll-probe.py

验证方法（就是一个普通窗口，不需要看代码）：
  1. 把指针贴在屏幕左/右边缘，滚一格
     → 这里的计数**不该变**（事件已被核层吞掉），同时亮度/音量该变
  2. 把指针放到窗口中间，滚一格
     → 计数**必须 +1**（确认正常滚动没被误吞）

只用于人工验证，不参与构建。用完 Ctrl+C 或关窗即可。
"""
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk  # noqa: E402


class Probe(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="dev.edgegesture.ScrollProbe")
        self.count = 0
        self.last_dy = 0.0

    def do_activate(self):
        win = Gtk.ApplicationWindow(application=self)
        win.set_default_size(560, 260)
        win.set_title("滚动接收器")

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
        for side in ("top", "bottom", "start", "end"):
            getattr(box, "set_margin_" + side)(26)
        win.set_child(box)

        self.big = Gtk.Label()
        box.append(self.big)

        self.detail = Gtk.Label()
        self.detail.set_wrap(True)
        box.append(self.detail)

        hint = Gtk.Label()
        hint.set_wrap(True)
        hint.set_text(
            "指针贴屏幕边缘滚一格 → 这个计数不该增加（事件被吞掉）\n"
            "指针在窗口中间滚 → 计数必须增加（不能误吞）")
        box.append(hint)

        ctl = Gtk.EventControllerScroll.new(
            Gtk.EventControllerScrollFlags.VERTICAL)
        ctl.connect("scroll", self._on_scroll)
        win.add_controller(ctl)

        self._refresh()
        win.present()

    def _on_scroll(self, _ctl, _dx, dy):
        self.count += 1
        self.last_dy = dy
        self._refresh()
        return True   # 自己吞掉，避免页面内容跟着滚、干扰观察

    def _refresh(self):
        self.big.set_markup("<span size='32000'>%d</span>" % self.count)
        self.detail.set_text(
            "窗口收到滚动：%d 次　最近一格方向：%s"
            % (self.count, "上" if self.last_dy > 0 else "下"))


if __name__ == "__main__":
    Probe().run(None)
