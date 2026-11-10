import GLib from 'gi://GLib';

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
 */
export default class EdgeGestureExtension extends Extension {
    async enable() {
        const stamp = GLib.get_monotonic_time();
        const uri = this.dir.get_uri() + '/impl.js?t=' + stamp;
        try {
            this._mod = await import(uri);
        } catch (e) {
            // 加载失败必须显式抛出去：否则 shell 只把状态记为 INACTIVE，
            // 界面上什么都没有，排查全靠猜。
            console.error('[edgegesture] 加载 impl.js 失败: ' + e.message);
            throw new Error('加载 impl.js 失败: ' + e.message);
        }
        if (typeof this._mod.Impl !== 'function')
            throw new Error('impl.js 没有导出 Impl');
        this._impl = new this._mod.Impl(this);
        await this._impl.enable();
    }

    disable() {
        try {
            this._impl?.disable();
        } catch (e) {
            console.error('[edgegesture] disable 出错: ' + e.message);
        }
        this._impl = null;
        this._mod = null;
    }
}
