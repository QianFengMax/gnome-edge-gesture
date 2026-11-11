import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * 文件日志。
 *
 * 出问题时用户能直接把日志发回来定位，平时不占空间：
 *  - 位置：<扩展目录>/logs/edgegesture.log
 *  - 级别：error < warn < info < debug，config.debug 打开后才有 debug
 *  - 轮转：单文件超 1 MiB 滚一个 .1，最多 3 份
 *  - 同时写 console，journalctl --user -f | grep edgegesture 也看得到
 */

export const Level = {ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3};

const LEVEL_NAME = ['ERROR', 'WARN', 'INFO', 'DEBUG'];
const MAX_BYTES = 1024 * 1024;
const MAX_BACKUPS = 3;

let _level = Level.INFO;
let _file = null;
let _dir = null;
let _openFailed = false;

export function init(level, dir) {
    _level = level;
    _dir = dir;
    _file = null;
    _openFailed = false;
    if (!dir)
        return;
    try {
        GLib.mkdir_with_parents(dir, 0o755);
        _file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'edgegesture.log']));
    } catch (e) {
        _openFailed = true;
        console.warn('[edgegesture] 日志目录不可用: ' + e.message);
    }
}

export function getLevel() {
    return _level;
}

export function logPath() {
    return _file?.get_path() ?? '(未启用)';
}

function write(level, args) {
    if (level > _level)
        return;

    const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H:%M:%S');
    const msg = args.map(a => {
        if (typeof a === 'string')
            return a;
        if (a instanceof Error)
            return a.message + ' @ ' + (a.stack ?? '');
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
    const line = '[' + stamp + '] [' + LEVEL_NAME[level] +
        '] ' + msg + '\n';

    const sink = level <= Level.ERROR ? console.error : console.log;
    sink('[edgegesture] ' + line.trimEnd());

    if (!_file || _openFailed)
        return;
    try {
        _rotateIfNeeded();
        const out = _file.append_to(Gio.FileCreateFlags.NONE, null);
        out.write_all(line, null);
        out.close(null);
    } catch {
        _openFailed = true;
    }
}

function _rotateIfNeeded() {
    if (!_file || !_dir)
        return;
    let size = 0;
    try {
        size = _file.query_info('standard::size',
            Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch {
        return;
    }
    if (size < MAX_BYTES)
        return;
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
        const from = Gio.File.new_for_path(_dir + '/edgegesture.log.' + i);
        const to = Gio.File.new_for_path(_dir + '/edgegesture.log.' + (i + 1));
        try {
            if (from.query_exists(null))
                from.move(to, Gio.FileCopyFlags.OVERWRITE, null, null);
        } catch {
            // ignore
        }
    }
    try {
        _file.move(Gio.File.new_for_path(_dir + '/edgegesture.log.1'),
            Gio.FileCopyFlags.OVERWRITE, null, null);
    } catch {
        try {
            _file.delete(null);
        } catch {
            // ignore
        }
    }
}

export const error = (...a) => write(Level.ERROR, a);
export const warn = (...a) => write(Level.WARN, a);
export const info = (...a) => write(Level.INFO, a);
export const debug = (...a) => write(Level.DEBUG, a);
