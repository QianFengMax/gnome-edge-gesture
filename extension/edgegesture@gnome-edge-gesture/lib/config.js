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
 * 从扩展目录推导项目根。
 * 扩展装在 <项目>/extension/<uuid>/，所以项目根是上两级。
 * 配置里的 bin/、.venv/、backend/ 都是相对项目根写的。
 */
export function projectRoot(extensionDir) {
    const parent = GLib.path_get_dirname(extensionDir);      // <项目>/extension
    return GLib.path_get_dirname(parent);                    // <项目>
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
