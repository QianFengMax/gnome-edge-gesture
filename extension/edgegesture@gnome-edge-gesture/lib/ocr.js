import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Log from './logger.js';

/**
 * OCR 桥。
 *
 * 优先 Rust 二进制（backend='rust'）：进程启动 21ms、模型加载 45ms，
 * 端到端比 Python 快 2~3 倍。Python 版留作后备，Rust 出错时自动降级。
 */
export class OcrRunner {
    /**
     * @param {object} cfg config.json 的 ocr 段
     * @param {string} baseDir 项目根目录，用来解析配置里的相对路径
     */
    constructor(cfg, baseDir = '') {
        this._cfg = cfg;
        this._base = baseDir;
        this._busy = false;
    }

    /** 相对路径按 baseDir 解析；绝对路径原样返回。 */
    _resolve(p) {
        if (!p) return '';
        if (p.startsWith('/')) return p;
        return this._base ? this._base + '/' + p : p;
    }

    get _rustAvailable() {
        const bin = this._resolve(this._cfg.binary);
        return !!(bin && GLib.file_test(bin, GLib.FileTest.IS_EXECUTABLE));
    }

    get _pythonAvailable() {
        const pythonBin = this._resolve(this._cfg.pythonBin);
        const script = this._resolve(this._cfg.script);
        return !!(pythonBin && script &&
            GLib.file_test(pythonBin, GLib.FileTest.IS_EXECUTABLE) &&
            GLib.file_test(script, GLib.FileTest.IS_REGULAR));
    }

    get backend() {
        if (this._cfg.backend === 'rust' && this._rustAvailable)
            return 'rust';
        if (this._pythonAvailable)
            return 'python';
        return 'none';
    }

    get available() {
        return this.backend !== 'none';
    }

    async run(imagePath) {
        if (!this.available)
            throw new Error('OCR 后端未就绪');
        if (this._busy)
            throw new Error('OCR 忙');

        this._busy = true;
        try {
            if (this.backend === 'rust') {
                try {
                    return await this._spawn([this._resolve(this._cfg.binary), imagePath]);
                } catch (e) {
                    Log.warn('Rust OCR 失败，降级 Python:', e.message);
                    if (!this._pythonAvailable)
                        throw e;
                }
            }
            return await this._spawn([
                this._resolve(this._cfg.pythonBin),
                this._resolve(this._cfg.script),
                imagePath,
                '--lang', this._cfg.lang ?? 'chi_sim+eng',
            ]);
        } finally {
            this._busy = false;
        }
    }

    _spawn(argv) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                reject(e);
                return;
            }
            proc.communicate_utf8_async(null, null, (p, res) => {
                let out = '';
                let err = '';
                try {
                    [, out, err] = p.communicate_utf8_finish(res);
                } catch (e) {
                    reject(e);
                    return;
                }
                if (!p.get_successful()) {
                    Log.error('OCR 进程失败:', (err ?? '').slice(0, 300));
                    reject(new Error((err ?? '').trim() || 'OCR 进程失败'));
                    return;
                }
                resolve((out ?? '').trim());
            });
        });
    }
}
