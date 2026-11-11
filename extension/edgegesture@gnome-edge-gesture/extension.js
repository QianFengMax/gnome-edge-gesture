import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * 重载代理。
 *
 * GNOME Shell 用 await import(extensionJs.get_uri()) 加载扩展，ESM 按 URI 缓存，
 * 所以 disable/enable 只会重跑 enable()，改代码后必须注销才能生效。
 *
 * 这里每次 enable 都用带新 query 的 URI 动态加载 impl.js：GJS 支持这种写法
 * （实测生成独立模块实例、读到最新文件内容，且父模块的静态子导入一并刷新）。
 * 于是「改代码 -> disable -> enable」即可生效，不用重启 shell。
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

    /** 用带新 query 的 URI 加载实现并启用；query 变了才会绕过 ESM 缓存。 */
    async _loadImpl() {
        const uri = this.dir.get_uri() + '/impl.js?t=' + GLib.get_monotonic_time();
        let mod;
        try {
            mod = await import(uri);
        } catch (e) {
            // 加载失败必须显式抛出去：否则 shell 只把状态记为 INACTIVE，
            // 界面上什么都没有，排查全靠猜。
            console.error('[edgegesture] 加载 impl.js 失败: ' + e.message);
            throw new Error('加载 impl.js 失败: ' + e.message);
        }
        if (typeof mod.Impl !== 'function')
            throw new Error('impl.js 没有导出 Impl');

        this._mod = mod;
        this._impl = new mod.Impl(this);
        await this._impl.enable();
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
