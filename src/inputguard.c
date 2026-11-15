// edgegesture-input —— 指针设备「边缘暂扣」拦截器
//
// 目标：指针贴屏幕边缘滚轮时，扩展要调亮度/音量，而这次滚动不该同时
// 传给当前窗口。
//
// 为什么必须做在核层：
//   GNOME/Wayland 下滚轮事件由 mutter 直接派给指针下的客户端 surface，
//   shell 的 stage 收不到（扩展里试过 captured-event，真机无效）。
//   唯一可靠的办法是 EVIOCGRAB 独占设备，自己再把事件写回 uinput。
//
// 影响范围怎么压到最小：
//   不做常驻独占。只有扩展判定「指针进了边缘带」才发 GRAB，本进程
//   才去 grab；指针一离开边缘带（本进程自己按 REL 增量跟踪位置）
//   立即 ungrab，事件流回到物理设备，日常操作完全不经手。
//
// 进程与 shell 的关系：
//   由扩展用 Gio.Subprocess 拉起，stdin 收命令、stdout 吐事件与应答。
//   shell 关掉 stdin（或进程被 kill）→ fd 关闭 → 内核自动解除 grab，
//   鼠标立刻恢复，不会卡死输入。另外还有一条 3 秒心跳看门狗兜底。
//
// 协议（行式，UTF-8，英文关键字）：
//   shell → 本进程
//     GRAB x=<px> y=<py> margin=<n> monitors=<x,y,w,h;x,y,w,h...> [devs=/dev/input/eventN,...]
//     UNGRAB
//     POS x=<px> y=<py>       shell 报当前指针位置（合成器视角，权威值）
//     PING
//     QUIT
//  本进程 → shell
//     READY
//     OK GRAB / OK UNGRAB
//     ERR <reason>
//     WHEEL up|down <n>      边缘带内的滚轮（已被吞掉，不写 uinput）
//     HWHEEL left|right <n>
//     BTN 0x<code> <0|1>
//     UNGRAB auto|watchdog|quit   非 shell 主动释放时的通知
//
// 编译：scripts/build-inputguard.sh

#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/input.h>
#include <signal.h>
#include <linux/uinput.h>
#include <poll.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

#define MAX_SRC 16
#define MAX_MON 8
#define HB_TIMEOUT_MS 3000
#define TICK_MS 200
#define INPUT_DIR "/dev/input"
#define DEV_NAME "edgegesture virtual pointer"

struct mon {
    int x, y, w, h;
};

struct src {
    int fd;
    char path[PATH_MAX];
};

static int ui_fd = -1;
static int grabbed = 0;
static int pos_x = 0, pos_y = 0;
static int margin = 28;
static int arm = 0;
static struct mon mons[MAX_MON];
static int nmon = 0;
static struct src srcs[MAX_SRC];
static int nsrc = 0;
static long long last_cmd_ms = 0;
static int verbose = 0;
static double motion_scale = 1.0;   /* uinput 出来的指针速度补偿，默认 1:1 */
static double scale_acc_x = 0.0;
static double scale_acc_y = 0.0;
static int hires_acc = 0;
static int motion_pending = 0;

/* ---------------- 基础工具 ---------------- */

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* 输出给 shell：每行必须立即刷出去，否则扩展要等到缓冲区满才看到事件 */
static void say(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stdout, fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

static void vlog(const char *fmt, ...) {
    if (!verbose)
        return;
    va_list ap;
    va_start(ap, fmt);
    fputs("[inputguard] ", stderr);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}

static int read_text(const char *path, char *buf, size_t n) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return -1;
    ssize_t r = read(fd, buf, n - 1);
    close(fd);
    if (r < 0)
        return -1;
    buf[r] = 0;
    return 0;
}

/*
 * 解析 sysfs 的十六进制能力位图（形如 "1943" 或多字 "1f0000 0 0 0 0"）。
 * 低位字在最后，与内核打印顺序一致。
 */
static int has_bit(const char *mask, int bit) {
    if (!mask || !*mask)
        return 0;
    char copy[512];
    snprintf(copy, sizeof copy, "%s", mask);
    char *words[32];
    int nw = 0;
    char *save = NULL;
    for (char *tok = strtok_r(copy, " \t\n", &save); tok && nw < 32;
         tok = strtok_r(NULL, " \t\n", &save))
        words[nw++] = tok;
    if (nw == 0)
        return 0;
    int total = nw * 64;
    if (bit >= total)
        return 0;
    int idx = nw - 1 - bit / 64;
    if (idx < 0)
        idx = 0;
    unsigned long long word = strtoull(words[idx], NULL, 16);
    return (int)((word >> (bit % 64)) & 1ULL);
}

static void dev_caps(const char *path, char *rel, size_t rn, char *key, size_t kn,
                     char *name, size_t nn) {
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    char b64[64];
    /* 手动截断：basename 只可能是 "eventNN"，但别让编译器猜 */
    size_t bl = strlen(base);
    if (bl >= sizeof b64)
        bl = sizeof b64 - 1;
    memcpy(b64, base, bl);
    b64[bl] = 0;
    base = b64;
    char p[PATH_MAX];
    rel[0] = key[0] = name[0] = 0;
    snprintf(p, sizeof p, "/sys/class/input/%s/device/capabilities/rel", base);
    read_text(p, rel, rn);
    snprintf(p, sizeof p, "/sys/class/input/%s/device/capabilities/key", base);
    read_text(p, key, kn);
    snprintf(p, sizeof p, "/sys/class/input/%s/device/name", base);
    read_text(p, name, nn);
    /* 去掉换行 */
    size_t l = strlen(rel);
    if (l && rel[l - 1] == '\n')
        rel[l - 1] = 0;
    l = strlen(key);
    if (l && key[l - 1] == '\n')
        key[l - 1] = 0;
    l = strlen(name);
    if (l && name[l - 1] == '\n')
        name[l - 1] = 0;
}

/* 与扩展 inputSource 的 SKIP_NAMES 保持一致：别把自己的注入设备再抓一遍 */
static int name_skipped(const char *name) {
    return strstr(name, "ydotoold") || strstr(name, "edgegesture") ||
           strstr(name, "vinput");
}

static int is_pointer_dev(const char *path, char *out_name, size_t nn) {
    char rel[256], key[512], name[256];
    dev_caps(path, rel, sizeof rel, key, sizeof key, name, sizeof name);
    if (out_name)
        snprintf(out_name, nn, "%s", name);
    if (name_skipped(name))
        return 0;
    return has_bit(rel, REL_WHEEL) && has_bit(key, BTN_RIGHT);
}

/* ---------------- uinput 注入端 ---------------- */

static int ui_create(void) {
    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        say("ERR uinput %s", strerror(errno));
        return -1;
    }

    ioctl(fd, UI_SET_EVBIT, EV_KEY);
    ioctl(fd, UI_SET_EVBIT, EV_REL);
    ioctl(fd, UI_SET_EVBIT, EV_SYN);

    const int keys[] = {BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA,
                        BTN_FORWARD, BTN_BACK, BTN_TASK};
    for (size_t i = 0; i < sizeof keys / sizeof *keys; i++)
        ioctl(fd, UI_SET_KEYBIT, keys[i]);

    const int rels[] = {REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES,
                        REL_HWHEEL_HI_RES, REL_DIAL};
    for (size_t i = 0; i < sizeof rels / sizeof *rels; i++)
        ioctl(fd, UI_SET_RELBIT, rels[i]);

    struct uinput_setup us;
    memset(&us, 0, sizeof us);
    us.id.bustype = BUS_VIRTUAL;
    us.id.vendor = 0x1ee7;
    us.id.product = 0x0001;
    us.id.version = 1;
    snprintf(us.name, sizeof us.name, "%s", DEV_NAME);

    if (ioctl(fd, UI_DEV_SETUP, &us) < 0) {
        say("ERR ui_dev_setup %s", strerror(errno));
        close(fd);
        return -1;
    }
    if (ioctl(fd, UI_DEV_CREATE) < 0) {
        say("ERR ui_dev_create %s", strerror(errno));
        close(fd);
        return -1;
    }
    /* 设备注册是异步的，太早写事件会被丢掉 */
    usleep(120000);
    return fd;
}

static void ui_emit(const struct input_event *ev) {
    if (ui_fd < 0)
        return;
    if (write(ui_fd, ev, sizeof *ev) < 0)
        vlog("write uinput: %s", strerror(errno));
}

/* ---------------- 边缘带判定 ---------------- */

static int in_edge_within(int x, int y, int r) {
    for (int i = 0; i < nmon; i++) {
        const struct mon *m = &mons[i];
        if (x < m->x || x >= m->x + m->w || y < m->y || y >= m->y + m->h)
            continue;
        if (x - m->x <= r) return 1;
        if (m->x + m->w - x <= r) return 1;
        if (y - m->y <= r) return 1;
        if (m->y + m->h - y <= r) return 1;
        return 0;
    }
    return 0;
}

/* 位置钳到监视器并集的边界，和合成器对指针的钳制保持一致 */
static int in_edge_band(int x, int y) {
    return in_edge_within(x, y, margin);
}

static int in_arm_zone(int x, int y) {
    return in_edge_within(x, y, arm > 0 ? arm : margin);
}

static void clamp_pos(void) {
    if (nmon == 0)
        return;
    int x0 = mons[0].x, y0 = mons[0].y, x1 = mons[0].x + mons[0].w,
        y1 = mons[0].y + mons[0].h;
    for (int i = 1; i < nmon; i++) {
        if (mons[i].x < x0) x0 = mons[i].x;
        if (mons[i].y < y0) y0 = mons[i].y;
        if (mons[i].x + mons[i].w > x1) x1 = mons[i].x + mons[i].w;
        if (mons[i].y + mons[i].h > y1) y1 = mons[i].y + mons[i].h;
    }
    if (pos_x < x0) pos_x = x0;
    if (pos_y < y0) pos_y = y0;
    if (pos_x > x1 - 1) pos_x = x1 - 1;
    if (pos_y > y1 - 1) pos_y = y1 - 1;
}

/* ---------------- grab / ungrab ---------------- */

static void release_all(const char *reason) {
    for (int i = 0; i < nsrc; i++) {
        if (srcs[i].fd < 0)
            continue;
        ioctl(srcs[i].fd, EVIOCGRAB, 0);
        close(srcs[i].fd);
        srcs[i].fd = -1;
    }
    nsrc = 0;
    int was = grabbed;
    grabbed = 0;
    if (was && reason)
        say("UNGRAB %s", reason);
}

static int add_source(const char *path) {
    if (nsrc >= MAX_SRC)
        return -1;
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        vlog("open %s: %s", path, strerror(errno));
        return -1;
    }
    srcs[nsrc].fd = fd;
    snprintf(srcs[nsrc].path, sizeof srcs[nsrc].path, "%s", path);
    nsrc++;
    return 0;
}

static void grab_all(void) {
    for (int i = 0; i < nsrc; i++) {
        if (ioctl(srcs[i].fd, EVIOCGRAB, 1) < 0) {
            say("ERR grab %s %s", srcs[i].path, strerror(errno));
            release_all(NULL);
            return;
        }
        vlog("grabbed %s", srcs[i].path);
    }
    grabbed = 1;
}

static void scan_devices(void) {
    DIR *d = opendir(INPUT_DIR);
    if (!d)
        return;
    struct dirent *de;
    while ((de = readdir(d))) {
        if (strncmp(de->d_name, "event", 5) != 0)
            continue;
        char path[PATH_MAX];
        snprintf(path, sizeof path, "%s/%s", INPUT_DIR, de->d_name);
        char name[256];
        if (is_pointer_dev(path, name, sizeof name)) {
            add_source(path);
            vlog("candidate %s (%s)", path, name);
        }
    }
    closedir(d);
}

/* ---------------- 事件处理 ---------------- */

static void do_event(const struct input_event *ev) {
    if (ev->type == EV_REL) {
        if (ev->code == REL_X || ev->code == REL_Y) {
            if (ev->code == REL_X)
                pos_x += ev->value;
            else
                pos_y += ev->value;
            motion_pending = 1;

            struct input_event m = *ev;
            if (motion_scale != 1.0) {
                double *acc = ev->code == REL_X ? &scale_acc_x : &scale_acc_y;
                *acc += ev->value * (motion_scale - 1.0);
                m.value = ev->value + (int)*acc;
                *acc -= (int)*acc;
            }
            ui_emit(&m);
            clamp_pos();
            if (grabbed && !in_arm_zone(pos_x, pos_y))
                release_all("auto");
            return;
        }

        if (ev->code == REL_WHEEL || ev->code == REL_HWHEEL ||
            ev->code == REL_WHEEL_HI_RES || ev->code == REL_HWHEEL_HI_RES) {
            /*
             * 只有指针真落在边缘带里才吞。arm 内、margin 外的滚轮照常
             * 注入 —— 提前 grab 不等于提前改行为。
             */
            if (!in_edge_band(pos_x, pos_y)) {
                ui_emit(ev);
                return;
            }
            if (ev->code == REL_WHEEL) {
                say("WHEEL %s %d", ev->value > 0 ? "up" : "down",
                    ev->value > 0 ? ev->value : -ev->value);
            } else if (ev->code == REL_HWHEEL) {
                say("HWHEEL %s %d", ev->value > 0 ? "right" : "left",
                    ev->value > 0 ? ev->value : -ev->value);
            } else if (ev->code == REL_WHEEL_HI_RES) {
                hires_acc += ev->value;
                while (hires_acc >= 120) {
                    say("WHEEL up 1");
                    hires_acc -= 120;
                }
                while (hires_acc <= -120) {
                    say("WHEEL down 1");
                    hires_acc += 120;
                }
            } else {
                hires_acc += ev->value;
                while (hires_acc >= 120) {
                    say("HWHEEL right 1");
                    hires_acc -= 120;
                }
                while (hires_acc <= -120) {
                    say("HWHEEL left 1");
                    hires_acc += 120;
                }
            }
            return;
        }

        ui_emit(ev);
        return;
    }

    if (ev->type == EV_SYN) {
        ui_emit(ev);
        if (motion_pending) {
            motion_pending = 0;
            say("MOVE");
        }
        return;
    }

    if (ev->type == EV_KEY) {
        if (ev->code == BTN_LEFT || ev->code == BTN_RIGHT || ev->code == BTN_MIDDLE)
            say("BTN 0x%x %d", ev->code, ev->value ? 1 : 0);
        ui_emit(ev);
        return;
    }

    /* EV_MSC(MSC_TIMESTAMP)、EV_LED、EV_SW 等本设备没声明，
       原样写进 uinput 只会得到 EINVAL，直接丢掉。 */
}

static void read_source(struct src *s) {
    struct input_event buf[64];
    for (;;) {
        ssize_t r = read(s->fd, buf, sizeof buf);
        if (r <= 0) {
            if (r == 0) {   /* 设备消失 */
                vlog("eof %s", s->path);
                release_all("auto");
            }
            break;
        }
        size_t n = (size_t)r / sizeof(struct input_event);
        for (size_t i = 0; i < n && grabbed; i++)
            do_event(&buf[i]);
        if (r < (ssize_t)sizeof buf)
            break;
    }
}

/* ---------------- 命令解析 ---------------- */

static void parse_monitors(const char *spec) {
    nmon = 0;
    char copy[1024];
    snprintf(copy, sizeof copy, "%s", spec);
    char *save1 = NULL;
    for (char *seg = strtok_r(copy, ";", &save1); seg && nmon < MAX_MON;
         seg = strtok_r(NULL, ";", &save1)) {
        int x, y, w, h;
        if (sscanf(seg, "%d,%d,%d,%d", &x, &y, &w, &h) == 4) {
            mons[nmon].x = x;
            mons[nmon].y = y;
            mons[nmon].w = w;
            mons[nmon].h = h;
            nmon++;
        }
    }
    if (nmon == 0) {   /* 没给几何就退化成「随便哪个点都算在带内」的反面 */
        mons[0].x = 0;
        mons[0].y = 0;
        mons[0].w = 0;
        mons[0].h = 0;
        nmon = 1;
    }
}

static void cmd_grab(char *args) {
    char devs[1024] = "";
    char monspec[1024] = "";
    pos_x = pos_y = 0;
    margin = 28;
    arm = 0;
    hires_acc = 0;
    nmon = 0;

    char *save = NULL;
    for (char *tok = strtok_r(args, " ", &save); tok; tok = strtok_r(NULL, " ", &save)) {
        char *eq = strchr(tok, '=');
        if (!eq)
            continue;
        *eq = 0;
        const char *k = tok, *v = eq + 1;
        if (!strcmp(k, "x")) pos_x = atoi(v);
        else if (!strcmp(k, "y")) pos_y = atoi(v);
        else if (!strcmp(k, "margin")) margin = atoi(v);
        else if (!strcmp(k, "arm")) arm = atoi(v);
        else if (!strcmp(k, "devs")) snprintf(devs, sizeof devs, "%s", v);
        else if (!strcmp(k, "monitors")) snprintf(monspec, sizeof monspec, "%s", v);
    }

    parse_monitors(monspec);
    release_all(NULL);

    if (devs[0]) {
        char copy[1024];
        snprintf(copy, sizeof copy, "%s", devs);
        char *save2 = NULL;
        for (char *p = strtok_r(copy, ",", &save2); p; p = strtok_r(NULL, ",", &save2))
            if (p[0])
                add_source(p);
    } else {
        scan_devices();
    }

    if (nsrc == 0) {
        say("ERR no-pointer");
        return;
    }

    clamp_pos();
    grab_all();
    if (!grabbed)
        return;

    /* 回执统一发在状态判定之后：release_all 自己会发 UNGRAB auto，
       顺序必须是 UNGRAB 在前、OK 在后，否则扩展会先看到 OK 又看到
       UNGRAB，把它当成「刚扣就被放」而相信错了状态。 */
    if (!in_arm_zone(pos_x, pos_y)) {
        release_all("auto");
        say("OK GRAB");
        return;
    }

    say("OK GRAB");
}

static void cmd_line(char *line) {
    while (*line == ' ' || *line == '\t')
        line++;
    size_t l = strlen(line);
    while (l && (line[l - 1] == '\n' || line[l - 1] == '\r' || line[l - 1] == ' '))
        line[--l] = 0;
    if (!*line)
        return;

    last_cmd_ms = now_ms();

    if (!strncmp(line, "POS ", 4)) {
        char *save = NULL;
        for (char *tok = strtok_r(line + 4, " ", &save); tok;
             tok = strtok_r(NULL, " ", &save)) {
            char *eq = strchr(tok, '=');
            if (!eq)
                continue;
            *eq = 0;
            if (!strcmp(tok, "x")) pos_x = atoi(eq + 1);
            else if (!strcmp(tok, "y")) pos_y = atoi(eq + 1);
        }
        clamp_pos();
        if (grabbed && !in_arm_zone(pos_x, pos_y))
            release_all("auto");
        say("OK POS");
        return;
    }
    if (!strcmp(line, "PING")) {
        say("PONG");
        return;
    }
    if (!strcmp(line, "UNGRAB")) {
        release_all(NULL);
        say("OK UNGRAB");
        return;
    }
    if (!strcmp(line, "QUIT")) {
        release_all("quit");
        say("OK QUIT");
        exit(0);
    }
    if (!strncmp(line, "SET ", 4)) {
        char *save = NULL;
        for (char *tok = strtok_r(line + 4, " ", &save); tok;
             tok = strtok_r(NULL, " ", &save)) {
            char *eq = strchr(tok, '=');
            if (!eq)
                continue;
            *eq = 0;
            if (!strcmp(tok, "scale")) {
                double v = atof(eq + 1);
                if (v > 0.1 && v < 10.0)
                    motion_scale = v;
            }
        }
        say("OK SET");
        return;
    }
    if (!strncmp(line, "VERBOSE ", 8)) {
        verbose = atoi(line + 8);
        say("OK VERBOSE");
        return;
    }
    if (!strncmp(line, "GRAB", 4) && (line[4] == 0 || line[4] == ' ')) {
        cmd_grab(line + 4);
        return;
    }
    say("ERR unknown-command");
}

/* 被 kill 时也要 ungrab：内核会在进程退出时自动解除，但显式放掉更
   干脆，顺手把 uinput 设备也撤掉，免得桌面上留一个幽灵鼠标。 */
static void on_term(int sig) {
    (void)sig;
    release_all(NULL);
    if (ui_fd >= 0) {
        ioctl(ui_fd, UI_DEV_DESTROY);
        close(ui_fd);
        ui_fd = -1;
    }
    _exit(0);
}

/* ---------------- main ---------------- */

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--verbose"))
            verbose = 1;
        else if (!strcmp(argv[i], "--help")) {
            fprintf(stderr,
                "usage: %s [--verbose]\n"
                "  stdin:  GRAB x=.. y=.. margin=.. monitors=x,y,w,h;.. [devs=..]\n"
                "          UNGRAB | PING | QUIT | VERBOSE 0|1\n"
                "  stdout: READY / OK .. / ERR .. / WHEEL .. / HWHEEL .. / BTN .. / UNGRAB ..\n"
                "  见 src/inputguard.c 头部注释。\n", argv[0]);
            return 0;
        }
    }

    ui_fd = ui_create();
    if (ui_fd < 0)
        return 2;

    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_term);
    signal(SIGINT, on_term);
    say("READY");
    last_cmd_ms = now_ms();

    char pending[8192];
    size_t plen = 0;

    for (;;) {
        struct pollfd pfds[1 + MAX_SRC];
        int n = 0;
        pfds[n].fd = STDIN_FILENO;
        pfds[n].events = POLLIN;
        n++;
        for (int i = 0; i < nsrc; i++) {
            pfds[n].fd = srcs[i].fd;
            pfds[n].events = POLLIN;
            n++;
        }

        int r = poll(pfds, (nfds_t)n, TICK_MS);
        if (r < 0) {
            if (errno == EINTR)
                continue;
            break;
        }

        if (r > 0) {
            if (pfds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
                ssize_t got = read(STDIN_FILENO, pending + plen, sizeof pending - 1 - plen);
                if (got <= 0) {
                    /* shell 走了：释放 grab 再退出，鼠标不能留在被扣状态 */
                    release_all("quit");
                    break;
                }
                plen += (size_t)got;
                pending[plen] = 0;
                char *start = pending;
                for (;;) {
                    char *nl = strchr(start, '\n');
                    if (!nl)
                        break;
                    *nl = 0;
                    cmd_line(start);
                    start = nl + 1;
                }
                plen = strlen(start);
                if (plen && start != pending)
                    memmove(pending, start, plen + 1);
                if (plen >= sizeof pending - 1)   /* 超长行直接丢，防止撑爆 */
                    plen = 0;
            }
        }

        /* 抓着的设备可能在 poll 期间被 release_all 关掉，逐个校验 fd */
        for (int i = 1; i < n; i++) {
            if (!(pfds[i].revents & (POLLIN | POLLERR | POLLHUP)))
                continue;
            /* poll 的槽位与 srcs 顺序一致，但 release_all 会清空数组，
               这里按 fd 反查，避免下标错位 */
            for (int j = 0; j < nsrc; j++) {
                if (srcs[j].fd == pfds[i].fd) {
                    read_source(&srcs[j]);
                    break;
                }
            }
        }

        if (grabbed && now_ms() - last_cmd_ms > HB_TIMEOUT_MS)
            release_all("watchdog");
    }

    release_all(NULL);
    if (ui_fd >= 0) {
        ioctl(ui_fd, UI_DEV_DESTROY);
        close(ui_fd);
    }
    return 0;
}
