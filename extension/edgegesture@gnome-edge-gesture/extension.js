import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * 重载代理。
 *
 * GNOME Shell 用 await import(extensionJs.get_uri()) 加载扩展，ESM 按 URI 缓存，
 * 所以 disable/enable 只会重跑 enable()，改代码后必须注销才能生效。
 *
 * 做法：每次 enable 先把「当前的 js 代码」快照到缓存目录
 * （~/.cache/edgegesture/impl-<内容指纹>/），再 import 那份 impl.js。
 *
 * 为什么不是「给 impl.js 加 ?t= 查询串」：ESM 的模块缓存按解析后的 URL 算，
 * 相对导入 `./lib/x.js` 会丢掉父模块的 query（规范行为，GJS 也遵守），
 * 于是只有 impl.js 刷新，lib/*.js 一直命中旧实例 —— 改 lib 里的逻辑
 * 永远不生效，症状是「reload 说成功了，行为一点没变」。
 * 换目录则所有模块 URL 都是新的，相对导入自然跟着刷新。
 *
 * 代码没变时指纹不变，复用的是同一份快照模块，不会每次 enable 都重建。
 *
 * 另外监视 config.json：设置页面写完配置后自动重载，用户无需做任何事。
 */
export default class EdgeGestureExtension extends Extension {
    async enable() {
        this._reloadId = 0;
        this._monitor = null;
        this._monitorId = 0;

        await this._loadImpl();
        this._watchConfig();
    }

    disable() {
        this._unwatchConfig();
        try {
            this._impl?.disable();
        } catch (e) {
            console.error('[edgegesture] disable 出错: ' + e.message);
        }
        this._impl = null;
        this._mod = null;
    }

    /** 加载当前代码的实现并启用。 */
    async _loadImpl() {
        const {uri, dir} = this._snapshotUri();
        let mod;
        try {
            mod = await import(uri);
        } catch (e) {
            // 快照加载失败不能让整个扩展躺平：退回源码目录直读，
            // 虽然 lib 可能是旧缓存，至少主流程还在。
            console.error('[edgegesture] 快照加载失败，回退源码目录: ' + e.message);
            try {
                mod = await import(
                    this.dir.get_uri() + '/impl.js?t=' + GLib.get_monotonic_time());
            } catch (e2) {
                // 回退也失败才往外抛：否则 shell 只把状态记为 INACTIVE，
                // 界面上什么都没有，排查全靠猜。
                console.error('[edgegesture] 加载 impl.js 失败: ' + e2.message);
                throw new Error('加载 impl.js 失败: ' + e2.message);
            }
        }
        if (typeof mod.Impl !== 'function')
            throw new Error('impl.js 没有导出 Impl');

        this._mod = mod;
        // 第二参数是扩展的真实目录：快照目录里没有 config.json / logs，
        // 配置、日志、OCR 资源仍要走源码目录。
        this._impl = new mod.Impl(this, this.dir.get_path());
        await this._impl.enable();
    }

    /** 代码快照的 uri；顺带返回源码目录（真实配置与日志位置）。 */
    _snapshotUri() {
        const src = this.dir.get_path();
        const hash = this._codeHash(src);
        const root = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'edgegesture', `${hash}`]);
        const target = GLib.build_filenamev([root, 'impl.js']);

        if (GLib.file_test(target, GLib.FileTest.EXISTS)) {
            return {
                uri: GLib.filename_to_uri(target, null),
                dir: src,
            };
        }

        try {
            GLib.mkdir_with_parents(GLib.build_filenamev([root, 'lib']), 0o755);
            for (const rel of this._jsFiles(src)) {
                const from = GLib.build_filenamev([src, rel]);
                const to = GLib.build_filenamev([root, rel]);
                const [ok, bytes] = GLib.file_get_contents(from);
                if (!ok)
                    throw new Error('读不到 ' + from);
                if (!GLib.file_set_contents(to, bytes))
                    throw new Error('写不进 ' + to);
            }
        } catch (e) {
            // 快照失败不致命：退回到原来的「直读源码」路径，
            // 至少 impl.js 本身还能热重载。
            console.error('[edgegesture] 代码快照失败，回退直读源码: ' + e.message);
            return {
                uri: this.dir.get_uri() + '/impl.js?t=' + GLib.get_monotonic_time(),
                dir: src,
            };
        }

        this._pruneSnapshots(root);
        return {
            uri: GLib.filename_to_uri(target, null),
            dir: src,
        };
    }

    /** impl.js + lib/*.js 的相对路径清单。 */
    _jsFiles(src) {
        const out = ['impl.js'];
        try {
            const en = Gio.File.new_for_path(GLib.build_filenamev([src, 'lib']))
                .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const n = info.get_name();
                if (n.endsWith('.js'))
                    out.push('lib/' + n);
            }
            en.close(null);
        } catch (e) {
            console.error('[edgegesture] 枚举 lib 失败: ' + e.message);
        }
        return out.sort();
    }

    /** 代码指纹：文件路径 + mtime + 大小。 */
    _codeHash(src) {
        const parts = [];
        for (const rel of this._jsFiles(src)) {
            try {
                const info = Gio.File.new_for_path(GLib.build_filenamev([src, rel]))
                    .query_info('time::modified,standard::size',
                        Gio.FileQueryInfoFlags.NONE, null);
                parts.push(`${rel}:${info.get_attribute_uint64('time::modified')}:${info.get_size()}`);
            } catch {
                parts.push(`${rel}:?`);
            }
        }
        return GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, parts.join('|'), -1).slice(0, 16);
    }

    /** 只留最近 3 份快照，别让缓存目录无限长。 */
    _pruneSnapshots(keep) {
        try {
            const parent = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.get_user_cache_dir(), 'edgegesture']));
            const en = parent.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            const dirs = [];
            let info;
            while ((info = en.next_file(null))) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                const child = parent.get_child(info.get_name());
                let mtime = 0;
                try {
                    mtime = child.query_info('time::modified',
                        Gio.FileQueryInfoFlags.NONE, null)
                        .get_attribute_uint64('time::modified');
                } catch {
                    // ignore
                }
                dirs.push({path: child.get_path(), mtime});
            }
            en.close(null);
            dirs.sort((a, b) => b.mtime - a.mtime);
            for (const d of dirs.slice(3)) {
                if (d.path === keep)
                    continue;
                this._removeRecursive(d.path);
            }
        } catch (e) {
            console.error('[edgegesture] 清理旧快照失败: ' + e.message);
        }
    }

    _removeRecursive(path) {
        try {
            const dir = Gio.File.new_for_path(path);
            const en = dir.enumerate_children('standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = en.next_file(null))) {
                const child = dir.get_child(info.get_name());
                if (info.get_file_type() === Gio.FileType.DIRECTORY)
                    this._removeRecursive(child.get_path());
                else
                    child.delete(null);
            }
            en.close(null);
            dir.delete(null);
        } catch {
            // 清不掉就算了，下次还会重试
        }
    }

    /**
     * 监视扩展目录里的 config.json。
     *
     * 监视目录而不是文件：saveConfig 用原子重命名覆盖，监视文件在替换后
     * 会失去目标，之后就收不到通知了。
     */
    _watchConfig() {
        this._unwatchConfig();
        try {
            this._monitor = Gio.File.new_for_path(this.dir.get_path())
                .monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitorId = this._monitor.connect('changed', (_m, file) => {
                if (file && file.get_basename() === 'config.json')
                    this._queueReload();
            });
        } catch (e) {
            console.error('[edgegesture] 监视配置失败: ' + e.message);
        }
    }

    _unwatchConfig() {
        if (this._reloadId) {
            GLib.source_remove(this._reloadId);
            this._reloadId = 0;
        }
        if (this._monitor) {
            if (this._monitorId) {
                this._monitor.disconnect(this._monitorId);
                this._monitorId = 0;
            }
            this._monitor.cancel();
            this._monitor = null;
        }
    }

    /** 合并短时间内的多次改动，避免设置页面每敲一个字符就重启一次 evdev。 */
    _queueReload() {
        if (this._reloadId)
            GLib.source_remove(this._reloadId);
        this._reloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._reloadId = 0;
            this._reload().catch(e =>
                console.error('[edgegesture] 配置重载失败: ' + e.message));
            return GLib.SOURCE_REMOVE;
        });
    }

    /** 用新配置重建实现，等价于内部 disable + enable。 */
    async _reload() {
        const old = this._impl;
        this._impl = null;
        this._mod = null;
        try {
            await old?.disable();
        } catch (e) {
            console.error('[edgegesture] 旧实例停止失败: ' + e.message);
        }
        await this._loadImpl();
        console.log('[edgegesture] 配置已重载');
    }
}
