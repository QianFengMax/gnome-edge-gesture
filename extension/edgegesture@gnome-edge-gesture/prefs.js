import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
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

export default class EdgeGesturePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._dir = this.dir.get_path();
        this._syncing = false;
        this._saveId = 0;
        const {config} = loadConfig(this._dir);
        this._cfg = config;

        window.add(this._buildOcrPage());
        window.add(this._buildGeneralPage());
        window.set_default_size(620, 720);
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

        this._keyRow = new Adw.EntryRow({title: 'API Key'});
        this._keyRow.text = remote.apiKey ?? '';
        cloudGroup.add(this._keyRow);

        this._secretRow = new Adw.EntryRow({title: 'Secret Key'});
        this._secretRow.text = remote.secretKey ?? '';
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

    // ---------- 通用页 ----------

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({
            title: '通用',
            icon_name: 'emblem-system-symbolic',
        });
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
    }

    _save() {
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

        const r = saveConfig(this._dir, this._cfg);
        this._testRow.subtitle = r.ok
            ? '已保存：' + (chain.join(' → ') || '（空链路）')
            : '保存失败：' + r.error;
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
