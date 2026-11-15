#!/usr/bin/env python3
"""拦截器端到端自测：真起进程、真 grab、真 uinput 注入，验「带内吞掉 / 带外放行」。

跑法：nice -n 19 python3 scripts/test_inputguard.py

原理：
  用一个自建的 uinput「虚拟鼠标」当被测设备（而不是去抢真实鼠标 ——
  测试期间不能用真鼠标就太危险了）。
  1. 起 inputguard，devs= 指向那个虚拟鼠标；
  2. 让指针进入/离开边缘带，观察它是否 WHEEL / 是否转发；
  3. 通过读它注入出来的另一个虚拟指针来确认「放行」。

不需要真实鼠标，也不需要动当前会话的输入。
"""
import os
import queue
import struct
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin", "edgegesture-input")
UINPUT = "/dev/uinput"

EV_SYN, EV_KEY, EV_REL = 0, 1, 2
REL_X, REL_Y, REL_WHEEL = 0, 1, 8
BTN_LEFT, BTN_RIGHT = 0x110, 0x111
SYN_REPORT = 0

UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_DEV_SETUP = 0x405C5503


def ev(type_, code, value):
    # struct input_event: timeval(16) + type(u16) + code(u16) + value(i32)
    return struct.pack("qqHHi", 0, 0, type_, code, value)


class VirtualMouse:
    """自建一个虚拟鼠标，供测试注入事件。"""

    def __init__(self, name):
        self.name = name
        self.fd = os.open(UINPUT, os.O_WRONLY | os.O_NONBLOCK)
        for bit in (EV_KEY, EV_REL, EV_SYN):
            self._ioctl(UI_SET_EVBIT, bit)
        for code in (BTN_LEFT, BTN_RIGHT):
            self._ioctl(UI_SET_KEYBIT, code)
        for code in (REL_X, REL_Y, REL_WHEEL):
            self._ioctl(UI_SET_RELBIT, code)
        # struct uinput_setup { input_id id(8); char name[80]; __u32 ff_effects_max }
        setup = struct.pack("HHHH", 0x03, 0x1EE7, 0x0002, 1)
        setup += name.encode().ljust(80, b"\x00")
        setup += struct.pack("I", 0)
        self._ioctl(UI_DEV_SETUP, setup)
        self._ioctl(UI_DEV_CREATE)
        time.sleep(0.15)
        self.path = self._find_event()

    def _ioctl(self, req, arg=None):
        """UI_DEV_CREATE / UI_DEV_DESTROY 是无参 ioctl，传 0 会被判 EINVAL。"""
        import fcntl
        if arg is None:
            fcntl.ioctl(self.fd, req)
        elif isinstance(arg, bytes):
            fcntl.ioctl(self.fd, req, arg)
        else:
            fcntl.ioctl(self.fd, req, arg)

    def _find_event(self):
        """按名字在 /sys 里找到对应的 eventN。"""
        for _ in range(40):
            for ent in sorted(os.listdir("/dev/input")):
                if not ent.startswith("event"):
                    continue
                p = "/sys/class/input/%s/device/name" % ent
                try:
                    with open(p) as f:
                        if f.read().strip() == self.name:
                            return "/dev/input/" + ent
                except OSError:
                    continue
            time.sleep(0.05)
        raise RuntimeError("找不到自建虚拟设备 %s 的 event 节点" % self.name)

    def move(self, dx, dy):
        self._write(ev(EV_REL, REL_X, dx) + ev(EV_REL, REL_Y, dy) +
                    ev(EV_SYN, SYN_REPORT, 0))

    def wheel(self, n):
        self._write(ev(EV_REL, REL_WHEEL, n) + ev(EV_SYN, SYN_REPORT, 0))

    def _write(self, data):
        os.write(self.fd, data)
        time.sleep(0.02)

    def close(self):
        try:
            self._ioctl(UI_DEV_DESTROY)
        finally:
            os.close(self.fd)


class Guard:
    """拦截器进程 + 后台读线程。

    必须用线程喂队列，不能用 select + readline：Python 的 text I/O 会
    预读整块，readline 取完第一行后剩余行还留在 Python 缓冲区里，而
    select 只看 fd —— 它会说「没数据可读」，测试就白等超时。这个坑
    曾让「UNGRAB auto 之后紧跟 OK GRAB」被读丢。
    """

    def __init__(self):
        self.p = subprocess.Popen([BIN], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        self.q = queue.Queue()
        self._stop = False
        self._t = threading.Thread(target=self._pump, daemon=True)
        self._t.start()

    def _pump(self):
        for line in self.p.stdout:
            if self._stop:
                return
            self.q.put(line.rstrip("\n"))
        self.q.put(None)   # EOF

    def read(self, timeout=1.0):
        try:
            return self.q.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self, timeout=0.4):
        out = []
        while True:
            line = self.read(timeout)
            if line is None:
                return out
            out.append(line)
            timeout = 0.12

    def send(self, s):
        self.p.stdin.write(s + "\n")
        self.p.stdin.flush()

    def expect(self, prefix, timeout=3.0):
        """读到以 prefix 开头的那行为止，中间的行收进 skipped 返回。

        协议是异步的：POS 回 OK POS、GRAB 回 OK GRAB，先发后读很容易把
        上一个命令的回执当成这个命令的答案。测试里显式找目标行。
        """
        skipped = []
        deadline = time.time() + timeout
        while True:
            left = deadline - time.time()
            if left <= 0:
                return None, skipped
            line = self.read(left)
            if line is None:
                return None, skipped
            if line.startswith(prefix):
                return line, skipped
            skipped.append(line)

    def close(self):
        try:
            self.send("QUIT")
            self.read(1.0)
        except Exception:
            pass
        self._stop = True
        try:
            self.p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.p.kill()
            self.p.wait(timeout=3)


def main():
    if not os.access(UINPUT, os.W_OK):
        print("SKIP /dev/uinput 不可写，跳过端到端测试")
        return 0

    fail = 0

    def check(cond, label):
        nonlocal fail
        print(("PASS " if cond else "FAIL ") + label)
        if not cond:
            fail += 1

    src = VirtualMouse("edgegesture-test-mouse")
    g = Guard()
    try:
        banner = g.read(3.0)
        check(banner == "READY", "拦截器启动 READY（得到 %r）" % banner)
        if banner != "READY":
            return 1

        # ---- 1. 指针在屏幕中间：滚轮应原样放行 ----
        mon = "0,0,1600,1000"
        g.send("GRAB x=800 y=500 margin=28 arm=98 monitors=%s devs=%s"
               % (mon, src.path))
        r, skipped = g.expect("OK GRAB", 3.0)
        # 800,500 不在 arm 内 -> 立刻自动释放
        check(r == "OK GRAB", "屏幕中间 GRAB 有回执（得到 %r）" % r)
        if skipped:
            check(any(x.startswith("UNGRAB") for x in skipped),
                  "屏幕中间 -> 先 UNGRAB auto（得到 %r）" % skipped)
        # 上面的 skipped 已经证明释放了；这里再确认没有残留的 UNGRAB
        out = g.drain(0.3)
        check(not any(x.startswith("UNGRAB") for x in out),
              "屏幕中间释放干净（无重复 UNGRAB，得到 %r）" % out)

        # ---- 2. 指针贴左边缘：滚轮应被吞掉（报 WHEEL 且不注入）----
        g.send("POS x=10 y=500")
        g.expect("OK POS", 1.0)
        g.send("GRAB x=10 y=500 margin=28 arm=98 monitors=%s devs=%s"
               % (mon, src.path))
        r, _ = g.expect("OK GRAB", 3.0)
        check(r == "OK GRAB", "左边缘 GRAB 成功（得到 %r）" % r)

        src.wheel(1)
        line, evs = g.expect("WHEEL", 1.0)
        check(line is not None and line.startswith("WHEEL up"),
              "边缘带内滚轮 -> WHEEL up（得到 %r / 之前 %r）" % (line, evs))

        # ---- 3. 移出边缘带：应自动释放 ----
        src.move(400, 0)     # 10 + 400 = 410，远离左边缘
        evs = g.drain(0.6)
        check(any(e.startswith("UNGRAB auto") for e in evs),
              "离开边缘带 -> UNGRAB auto（得到 %r）" % evs)

        # ---- 4. 释放后再滚：应直接注入，不该再报 WHEEL ----
        src.wheel(1)
        evs = g.drain(0.5)
        check(not any(e.startswith("WHEEL") for e in evs),
              "释放后的滚轮不再被吞（得到 %r）" % evs)

        # ---- 5. 心跳看门狗 ----
        g.send("POS x=10 y=500")
        g.expect("OK POS", 1.0)
        g.send("GRAB x=10 y=500 margin=28 arm=98 monitors=%s devs=%s"
               % (mon, src.path))
        r, _ = g.expect("OK GRAB", 3.0)
        check(r == "OK GRAB", "再次 GRAB（得到 %r）" % r)
        # 不再发 PING，等看门狗
        evs = g.drain(4.5)
        check(any(e.startswith("UNGRAB watchdog") for e in evs),
              "3 秒无心跳 -> UNGRAB watchdog（得到 %r）" % evs)

    finally:
        g.close()
        src.close()

    print()
    print("全部通过" if fail == 0 else "%d 项失败" % fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
