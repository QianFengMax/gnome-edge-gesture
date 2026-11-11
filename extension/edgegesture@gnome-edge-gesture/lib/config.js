import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEFAULTS = {
    edge: {
        enabled: true,
        margin: 28,
        left: 'brightness',
        right: 'volume',
        top: 'none',
        bottom: 'none',
        step: 0.05,
        cooldownMs: 40,
    },
    gesture: {
        enabled: true,
        button: 3,
        startDistance: 12,
        timeoutMs: 3000,
        traceColor: '#E47542',
        traceWidth: 3,
        failColor: '#CAD0D3',
        restoreClick: false,
        rectCw: 'ocr',
        rectCcw: 'none',
        templateActions: {},
    },
    ocr: {
        pythonBin: '',
        script: '',
        lineMerge: true,
        copyToClipboard: true,
    },
};

function deepMerge(base, extra) {
    const out = Array.isArray(base) ? base.slice() : {...base};
    if (!extra || typeof extra !== 'object')
        return out;
    for (const [k, v] of Object.entries(extra)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
            out[k] = deepMerge(out[k], v);
        else
            out[k] = v;
    }
    return out;
}

/** 读取 <extdir>/config.json；缺失则用内置默认值。 */
export function loadConfig(extensionDir) {
    const path = GLib.build_filenamev([extensionDir, 'config.json']);
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return {config: deepMerge(DEFAULTS, {}), path, exists: false};

    try {
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return {config: deepMerge(DEFAULTS, {}), path, exists: false};
        const text = new TextDecoder().decode(bytes);
        return {config: deepMerge(DEFAULTS, JSON.parse(text)), path, exists: true};
    } catch (e) {
        logError(e, 'edgegesture: config.json 解析失败，使用默认值');
        return {config: deepMerge(DEFAULTS, {}), path, exists: false};
    }
}

/**
 * 写回 config.json。设置页面用它保存改动。
 *
 * 用 replace_contents 而不是直接写：它会先写临时文件再原子重命名，
 * 避免扩展正好在读配置时读到半截内容。
 *
 * @returns {{ok: boolean, error?: string}}
 */
export function saveConfig(extensionDir, config) {
    const path = GLib.build_filenamev([extensionDir, 'config.json']);
    try {
        const file = Gio.File.new_for_path(path);
        const NL = String.fromCharCode(10);
        const text = JSON.stringify(config, null, 2) + NL;
        file.replace_contents(text, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return {ok: true};
    } catch (e) {
        return {ok: false, error: e.message};
    }
}

/**
 * 把可能是符号链接的路径解析成真实路径。
 * 扩展通常以符号链接装在
 * ~/.local/share/gnome-shell/extensions/<uuid> 下，直接向上取两级会算到
 * gnome-shell 自己的目录去。
 */
function realPath(p) {
    // 先确认是符号链接：对普通路径查 standard::symlink-target 会刷 GLib 警告
    if (!GLib.file_test(p, GLib.FileTest.IS_SYMLINK))
        return p;
    try {
        const target = Gio.File.new_for_path(p)
            .query_info('standard::symlink-target',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            .get_symlink_target();
        if (!target)
            return p;
        return target.startsWith('/')
            ? target
            : GLib.canonicalize_filename(target, GLib.path_get_dirname(p));
    } catch {
        return p;   // 不是符号链接
    }
}

/**
 * 从扩展目录推导项目根，配置里的 bin/ .venv/ backend/ 都相对它。
 *
 * 常规布局是 <项目>/extension/<uuid>/，所以是上两级；
 * 为了容忍其他布局，再向上找一下带 ocr-rs/ 或 bin/ 的目录。
 * 可用 EDGEGESTURE_HOME 环境变量直接指定。
 */
export function projectRoot(extensionDir) {
    const override = GLib.getenv('EDGEGESTURE_HOME');
    if (override)
        return override;

    const real = realPath(extensionDir);
    let root = GLib.path_get_dirname(GLib.path_get_dirname(real));

    for (let i = 0; i < 4; i++) {
        for (const marker of ['ocr-rs', 'backend', 'bin']) {
            if (GLib.file_test(GLib.build_filenamev([root, marker]),
                    GLib.FileTest.EXISTS))
                return root;
        }
        const up = GLib.path_get_dirname(root);
        if (up === root)
            break;
        root = up;
    }
    return GLib.path_get_dirname(GLib.path_get_dirname(real));
}

export {DEFAULTS};

/** 写日志用的环境摘要。 */
export function envSummary() {
    return {
        shell: (typeof Main !== 'undefined' && Main.sessionMode?.currentMode) || 'unknown',
        sessionType: GLib.getenv('XDG_SESSION_TYPE') ?? '?',
        desktop: GLib.getenv('XDG_CURRENT_DESKTOP') ?? '?',
    };
}
