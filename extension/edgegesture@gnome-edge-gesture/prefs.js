import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadConfig, saveConfig, projectRoot} from './lib/config.js';
import {OcrRunner} from './lib/ocr.js';

/** 服务商：显示名 -> 配置里的值 */
const PROVIDERS = [
    ['不使用云端', 'none'],
    ['OCR.space（免费 25000 次/月）', 'ocrspace'],
    ['百度 OCR（免费 1000 次/月）', 'baidu'],
    ['有道智云（注册送额度）', 'youdao'],
    ['Umi-OCR（自建，无限额）', 'umi'],
    ['自定义接口', 'custom'],
];

/** 需要哪些字段 */
const NEEDS = {
    ocrspace: {key: true},
    baidu: {key: true, secret: true},
    youdao: {key: true, secret: true},
    umi: {url: true},
    custom: {url: true},
};

const LANGS = [['自动', 'auto'], ['中文', 'chs'], ['英文', 'eng']];

/**
 * 挑一个当前图标主题真的有的图标名。
 *
 * 不同发行版/自装主题的图标集不一样，写死一个名字在别人的机器上
 * 可能渲染成空白方块。这里按优先级取第一个存在的。
 *
 * @param {string[]} names 候选名，从最想要的开始
 * @returns {string} 可用的名字；全都没有时返回第一个（至少语义对）
 */
function pickIcon(names) {
    try {
        const display = Gdk.Display.get_default();
        if (display) {
            const theme = Gtk.IconTheme.get_for_display(display);
            for (const n of names) {
                if (theme.has_icon(n))
                    return n;
            }
        }
    } catch {
        // 拿不到 display（极早期调用）就用第一个，别让设置页开不了
    }
    return names[0];
}

export default class EdgeGesturePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._dir = this.dir.get_path();
        this._syncing = false;
        this._saveId = 0;
        this._dirty = false;
        const {config} = loadConfig(this._dir);
        this._cfg = config;

        window.add(this._buildOcrPage());
        window.add(this._buildGeneralPage());
        window.set_default_size(620, 720);

        this._window = window;
        this._buildApplyBar(window);

        /*
         * 关窗时把待写的改动落盘。
         *
         * _onChange 是 500ms 防抖（输入框逐字符触发，不攒一下会疯狂写盘），
         * 而「填完最后一个字符就点关闭」是常态：定时器还没到，改动就没了。
         * 症状是「填了 key 却还走本地」，很难联想到是这个原因。
         *
         * 有了底部「应用」按钮后这是第二道保险：用户点应用立刻落盘，
         * 直接关窗也照样存住。
         */
        window.connect('close-request', () => {
            this._flushSave();
            return false;
        });
    }

    /**
     * 底部固定操作条：状态文字 + 「应用」按钮。
     *
     * 为什么不放在页面里当普通行：页面能滚动，按钮滚出视野就找不到了，
     * 用户会不知道改动到底存没存。这里挂到 PreferencesWindow 内部的
     * ToolbarView 上，按钮永远贴在窗口最下方。
     *
     * 结构上要挑对那个 ToolbarView：窗口里有两个，外层装的是标题栏和
     * 整个内容，内层第一个 child 是 Adw.ViewStack（页面切换器）。挂到
     * 内层才是页面区域的最下方。
     */
    _buildApplyBar(window) {
        const tv = this._findInnerToolbarView(window);
        if (!tv) {
            // 拿不到就退化成「只有 close-request 兜底」，不要因此让设置页打不开
            console.warn('[edgegesture] 找不到 ToolbarView，应用按钮未添加');
            return;
        }

        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
        });
        bar.set_margin_top(8);
        bar.set_margin_bottom(8);
        bar.set_margin_start(12);
        bar.set_margin_end(12);

        this._barStatus = new Gtk.Label({
            label: '没有未保存的改动',
            xalign: 0,
            hexpand: true,
            ellipsize: 3,   // Pango.EllipsizeMode.END
        });
        this._barStatus.add_css_class('dim-label');
        bar.append(this._barStatus);

        this._applyBtn = new Gtk.Button({label: '应用'});
        this._applyBtn.add_css_class('suggested-action');
        this._applyBtn.set_sensitive(false);   // 没有改动时不可点，状态一眼可见
        this._applyBtn.connect('clicked', () => this._flushSave(true));
        bar.append(this._applyBtn);

        tv.add_bottom_bar(bar);
    }

    /** 在窗口子树里找「第一个 child 是 ViewStack」的那个 ToolbarView。 */
    _findInnerToolbarView(root) {
        const found = [];
        const walk = w => {
            if (w instanceof Adw.ToolbarView)
                found.push(w);
            let c = w.get_first_child();
            while (c) {
                walk(c);
                c = c.get_next_sibling();
            }
        };
        walk(root);

        for (const tv of found) {
            let c = tv.get_first_child();
            while (c) {
                if (c instanceof Adw.ViewStack)
                    return tv;
                c = c.get_next_sibling();
            }
        }
        return found.length ? found[found.length - 1] : null;
    }

    /** 立刻执行挂起的保存。没有待写改动时什么也不做。 */
    _flushSave(fromButton = false) {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._save(fromButton);
    }

    // ---------- OCR 页 ----------

    _buildOcrPage() {
        const page = new Adw.PreferencesPage({
            title: 'OCR 识别',
            icon_name: 'edit-find-symbolic',
        });

        const remote = this._cfg.ocr?.remote ?? {};
        const chain = this._cfg.ocr?.chain ?? ['remote', 'rust', 'python'];

        // ── 云端 ──
        const cloudGroup = new Adw.PreferencesGroup({
            title: '云端识别',
            description: '用云端大模型，复杂排版准确率更高，但需要联网与 API Key',
        });
        page.add(cloudGroup);

        this._cloudOn = new Adw.SwitchRow({
            title: '启用云端识别',
            subtitle: '关闭后只用本地',
            active: chain.includes('remote') && (remote.provider ?? 'none') !== 'none',
        });
        cloudGroup.add(this._cloudOn);

        this._providerRow = new Adw.ComboRow({
            title: '服务商',
            model: Gtk.StringList.new(PROVIDERS.map(p => p[0])),
        });
        const pIdx = Math.max(0,
            PROVIDERS.findIndex(p => p[1] === (remote.provider ?? 'none')));
        this._providerRow.selected = pIdx;
        cloudGroup.add(this._providerRow);

        /*
         * API Key / Secret Key 默认遮成圆点，点右侧眼睛才显示明文。
         *
         * 为什么要自己接这一套：Adw.PasswordEntryRow 在 libadwaita 1.10 里
         * 并没有 peek（小眼睛）图标，只有 show-apply-button。所以用普通
         * EntryRow，拿 get_delegate() 到内部的 Gtk.Text 改 visibility，
         * 再往行尾塞一个 ToggleButton 当眼睛。
         */
        this._keyRow = this._secretEntry('API Key', remote.apiKey ?? '');
        cloudGroup.add(this._keyRow);

        this._secretRow = this._secretEntry('Secret Key', remote.secretKey ?? '');
        cloudGroup.add(this._secretRow);

        this._urlRow = new Adw.EntryRow({title: '接口地址'});
        this._urlRow.text = remote.url ?? '';
        cloudGroup.add(this._urlRow);

        this._langRow = new Adw.ComboRow({
            title: '语言',
            model: Gtk.StringList.new(LANGS.map(l => l[0])),
        });
        this._langRow.selected = Math.max(0,
            LANGS.findIndex(l => l[1] === (remote.language ?? 'chs')));
        cloudGroup.add(this._langRow);

        this._timeoutRow = new Adw.SpinRow({
            title: '超时（毫秒）',
            subtitle: '超时后自动回退本地',
            adjustment: new Gtk.Adjustment({
                lower: 500, upper: 30000, step_increment: 500, page_increment: 1000,
                value: remote.timeoutMs ?? 3000,
            }),
        });
        cloudGroup.add(this._timeoutRow);

        // ── 本地 ──
        const localGroup = new Adw.PreferencesGroup({
            title: '本地识别',
            description: '不回传图片，无延迟；也可作为云端失败后的兜底',
        });
        page.add(localGroup);

        this._fallbackOn = new Adw.SwitchRow({
            title: '云端失败时回退本地',
            subtitle: '出错或超时不让你白框一次',
            active: chain.includes('rust') || chain.includes('python'),
        });
        localGroup.add(this._fallbackOn);

        this._rustRow = new Adw.SwitchRow({
            title: '本地 Rust 后端',
            subtitle: '约 250~470ms，需先跑 scripts/build-ocr-rs.sh',
            active: chain.includes('rust'),
        });
        localGroup.add(this._rustRow);

        this._pyRow = new Adw.SwitchRow({
            title: '本地 Python 后备',
            subtitle: '较慢，作为最后兜底',
            active: chain.includes('python'),
        });
        localGroup.add(this._pyRow);

        // ── 测试 ──
        const testGroup = new Adw.PreferencesGroup({title: '验证'});
        page.add(testGroup);

        this._testRow = new Adw.ActionRow({
            title: '测试当前配置',
            subtitle: '用一张内置样图跑一遍识别链路',
        });
        const btn = new Gtk.Button({
            label: '测试',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        btn.connect('clicked', () => this._runTest(btn));
        this._testRow.add_suffix(btn);
        this._testRow.activatable_widget = btn;
        testGroup.add(this._testRow);

        // ── 事件 ──
        this._cloudOn.connect('notify::active', () => this._onChange());
        this._providerRow.connect('notify::selected', () => this._onChange());
        this._keyRow.connect('changed', () => this._onChange());
        this._secretRow.connect('changed', () => this._onChange());
        this._urlRow.connect('changed', () => this._onChange());
        this._langRow.connect('notify::selected', () => this._onChange());
        this._timeoutRow.connect('notify::value', () => this._onChange());
        this._fallbackOn.connect('notify::active', () => this._onChange());
        this._rustRow.connect('notify::active', () => this._onChange());
        this._pyRow.connect('notify::active', () => this._onChange());

        this._syncVisibility();
        return page;
    }

    /**
     * 造一个「默认密文、可点眼睛看明文」的输入行。
     *
     * @param {string} title 行标题
     * @param {string} value 初始值
     * @returns {Adw.EntryRow} 带着 _revealBtn / _setRevealed 的行
     *
     * 实现要点：
     *  - Adw.EntryRow 是 Gtk.ListBoxRow 包装，真正的输入框是它内部的
     *    Gtk.Text，用 get_delegate() 拿。给 EntryRow 本身设 visibility 没用。
     *  - invisible_char 用 U+2022（•）。默认是 *，与 GNOME 习惯不符。
     *  - 眼睛按钮用 ToggleButton 而不是 Button：想让它有「按下」的选中态，
     *    并且能被键盘切（Tab 到、空格按）。
     *  - 图标只在构建时设一次，切换时改的是 pressed 与文件名，不重建控件。
     */
    _secretEntry(title, value) {
        const row = new Adw.EntryRow({title});
        row.text = value ?? '';

        const text = row.get_delegate();
        if (text) {
            text.set_visibility(false);
            // 这个参数语义上是 gunichar，但 GJS 绑定要求传字符串：
            // 传 '•'.codePointAt(0) 会报 "Expected type string for argument 'ch'"
            text.set_invisible_char('•');
            // 告诉输入法这是密码，别在预测栏里把明文显示出来
            if (Gtk.InputPurpose)
                text.set_input_purpose(Gtk.InputPurpose.PASSWORD);
        }

        /*
         * 图标名优先用 GTK 的标准 reveal/conceal（含义就是显示/隐藏，
         * 各图标主题都保证有），老主题没有时退回 eye-* 系列。
         * 直接写死 eye-* 在部分主题下会渲染成空白方块。
         */
        const hiddenIcon = pickIcon(['view-reveal-symbolic',
            'eye-not-looking-symbolic', 'dialog-password-symbolic']);
        const shownIcon = pickIcon(['view-conceal-symbolic',
            'eye-open-negative-filled-symbolic', 'dialog-password-symbolic']);

        const eye = new Gtk.ToggleButton({
            icon_name: hiddenIcon,
            valign: Gtk.Align.CENTER,
            tooltip_text: '显示',
        });
        eye.add_css_class('flat');
        // 不要让眼睛按钮抢走行的「激活」语义
        eye.set_can_focus(true);
        eye.connect('toggled', () => {
            const on = eye.get_active();
            const t = row.get_delegate();
            if (t)
                t.set_visibility(on);
            eye.set_icon_name(on ? shownIcon : hiddenIcon);
            eye.set_tooltip_text(on ? '隐藏' : '显示');
        });
        row.add_suffix(eye);

        // 测试与外部代码用得到
        row._revealBtn = eye;
        return row;
    }

    // ---------- 通用页 ----------

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: '通用',
            icon_name: 'emblem-system-symbolic',
        });
        const edgeGroup = new Adw.PreferencesGroup({
            title: '边缘滚轮',
            description: '指针贴屏幕边缘滚轮时调亮度/音量',
        });
        page.add(edgeGroup);

        this._swallowRow = new Adw.SwitchRow({
            title: '拦截边缘滚动',
            subtitle: '打开后窗口不再跟着滚；需要 /dev/uinput 可写',
            active: this._cfg.edge?.swallow ?? true,
        });
        this._swallowRow.connect('notify::active', () => this._onChange());
        edgeGroup.add(this._swallowRow);

        this._armRow = new Adw.SpinRow({
            title: '提前拦截余量（像素）',
            subtitle: '越大越不容易漏拦，太大会误拦靠近边缘的正常滚动',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 200, step_increment: 5, page_increment: 20,
                value: this._cfg.edge?.armPad ?? 40,
            }),
        });
        this._armRow.connect('notify::value', () => this._onChange());
        edgeGroup.add(this._armRow);

        const g = new Adw.PreferencesGroup({title: '行为'});
        page.add(g);

        this._copyRow = new Adw.SwitchRow({
            title: '识别结果复制到剪贴板',
            active: this._cfg.ocr?.copyText ?? true,
        });
        this._copyRow.connect('notify::active', () => this._onChange());
        g.add(this._copyRow);

        this._debugRow = new Adw.SwitchRow({
            title: '调试日志',
            subtitle: '日志在扩展目录的 logs/edgegesture.log',
            active: this._cfg.debug ?? false,
        });
        this._debugRow.connect('notify::active', () => this._onChange());
        g.add(this._debugRow);

        const note = new Adw.PreferencesGroup();
        note.add(new Adw.ActionRow({
            title: '改动即时生效',
            subtitle: '保存后扩展会自动重载配置，无需注销',
        }));
        page.add(note);
        return page;
    }

    // ---------- 逻辑 ----------

    /** provider 决定哪些字段有意义，其余隐藏，避免填错地方。 */
    _syncVisibility() {
        const provider = PROVIDERS[this._providerRow.selected]?.[1] ?? 'none';
        const on = this._cloudOn.active && provider !== 'none';
        const need = NEEDS[provider] ?? {};

        this._providerRow.visible = true;
        this._keyRow.visible = on && !!need.key;
        this._secretRow.visible = on && !!need.secret;
        this._urlRow.visible = on && !!need.url;
        this._langRow.visible = on;
        this._timeoutRow.visible = on;

        if (this._armRow)
            this._armRow.visible = this._swallowRow?.active ?? true;

        // 云端关掉时，本地后端至少留一个，否则整条链路为空
        this._rustRow.visible = this._fallbackOn.active;
        this._pyRow.visible = this._fallbackOn.active;
        if (!this._fallbackOn.active) {
            this._rustRow.active = false;
            this._pyRow.active = false;
        } else if (!this._rustRow.active && !this._pyRow.active) {
            this._rustRow.active = true;
        }
    }

    /** 任何控件变化都走这里；先刷新可见性，再延迟写盘。 */
    _onChange() {
        if (this._syncing)
            return;
        this._syncing = true;
        this._syncVisibility();
        this._syncing = false;

        // 输入框是逐字符触发的，直接写盘会让扩展不停重载；攒一下再存
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
        this._testRow.subtitle = '待保存…';
        this._setDirty(true);
    }

    /** 底部操作条的状态：有未保存改动时「应用」可点。 */
    _setDirty(dirty) {
        this._dirty = dirty;
        if (this._applyBtn)
            this._applyBtn.set_sensitive(dirty);
        if (this._barStatus) {
            this._barStatus.set_text(dirty
                ? '有未保存的改动'
                : '没有未保存的改动');
        }
    }

    _save(fromButton = false) {
        const provider = PROVIDERS[this._providerRow.selected]?.[1] ?? 'none';

        // 链路顺序即优先级：云端在前，本地在后
        const chain = [];
        if (this._cloudOn.active && provider !== 'none')
            chain.push('remote');
        if (this._fallbackOn.active) {
            if (this._rustRow.active) chain.push('rust');
            if (this._pyRow.active) chain.push('python');
        }

        this._cfg.ocr = this._cfg.ocr ?? {};
        this._cfg.ocr.chain = chain;
        this._cfg.ocr.remote = {
            provider,
            apiKey: this._keyRow.text.trim(),
            secretKey: this._secretRow.text.trim(),
            url: this._urlRow.text.trim(),
            language: LANGS[this._langRow.selected]?.[1] ?? 'chs',
            timeoutMs: Math.round(this._timeoutRow.value),
        };
        this._cfg.ocr.copyText = this._copyRow?.active ?? true;
        this._cfg.debug = this._debugRow?.active ?? false;

        this._cfg.edge = this._cfg.edge ?? {};
        this._cfg.edge.swallow = this._swallowRow?.active ?? true;
        this._cfg.edge.armPad = Math.round(this._armRow?.value ?? 40);

        const r = saveConfig(this._dir, this._cfg);
        this._testRow.subtitle = r.ok
            ? '已保存：' + (chain.join(' → ') || '（空链路）')
            : '保存失败：' + r.error;

        if (r.ok) {
            this._setDirty(false);
            if (fromButton && this._barStatus) {
                const now = GLib.DateTime.new_now_local().format('%H:%M:%S');
                this._barStatus.set_text('已应用到 config.json · ' + now);
            }
        } else if (this._barStatus) {
            this._barStatus.set_text('保存失败：' + r.error);
        }
    }

    async _runTest(btn) {
        btn.sensitive = false;
        this._testRow.subtitle = '识别中…';

        const root = projectRoot(this._dir);
        const img = GLib.build_filenamev([root, 'assets', 'ocr-test.png']);
        if (!GLib.file_test(img, GLib.FileTest.EXISTS)) {
            this._testRow.subtitle = '缺少测试图 assets/ocr-test.png';
            btn.sensitive = true;
            return;
        }

        const runner = new OcrRunner(this._cfg.ocr, root);
        const chain = runner.chain.join(' → ') || '（空）';
        try {
            const t0 = GLib.get_monotonic_time();
            const text = await runner.run(img);
            const ms = Math.round((GLib.get_monotonic_time() - t0) / 1000);
            this._testRow.subtitle = ms + 'ms · ' + chain.replace(/\n/g, ' ');
            this._showResult(text, ms, chain);
        } catch (e) {
            this._testRow.subtitle = '失败：' + e.message.slice(0, 80);
            this._showResult('（失败）\n' + e.message, 0, chain);
        } finally {
            btn.sensitive = true;
        }
    }

    _showResult(text, ms, chain) {
        const win = new Adw.Window({
            transient_for: this.get_active_window?.() ?? null,
            modal: true,
            title: '识别测试',
        });
        win.set_default_size(520, 300);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16,
        });

        box.append(new Gtk.Label({
            label: '链路: ' + chain + (ms ? '　耗时: ' + ms + 'ms' : ''),
            xalign: 0,
            css_classes: ['dim-label'],
        }));
        box.append(new Gtk.Separator());

        const view = new Gtk.TextView({editable: false, wrap_mode: Gtk.WrapMode.WORD_CHAR});
        view.buffer.text = text;
        const sw = new Gtk.ScrolledWindow({vexpand: true});
        sw.set_child(view);
        box.append(sw);

        const close = new Gtk.Button({label: '关闭', halign: Gtk.Align.END});
        close.connect('clicked', () => win.close());
        box.append(close);

        win.set_content(box);
        win.present();
    }
}
