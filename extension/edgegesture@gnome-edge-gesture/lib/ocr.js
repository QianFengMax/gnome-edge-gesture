import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Log from './logger.js';
import {RemoteOcr} from './ocrRemote.js';

/**
 * OCR 调度：按配置的链路依次尝试，前一级失败/超时就退到下一级。
 *
 * 默认链路 remote -> rust -> python：
 *   remote  云端接口，大模型，准确率高，但要联网且有延迟
 *   rust    本地 PP-OCRv3（原生二进制），约 250~470ms
 *   python  本地后备，慢（每次付 ~460ms 启动开销）但不需要编译
 *
 * 好处：云端挂了或超时不会让用户白框一次，本地兜底永远在。
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
        this._remote = new RemoteOcr(cfg.remote ?? {});
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

    /** 实际可用的链路（按配置顺序，滤掉不可用的）。 */
    get chain() {
        const want = this._cfg.chain ?? ['remote', 'rust', 'python'];
        const ok = {
            remote: this._remote.enabled,
            rust: this._rustAvailable,
            python: this._pythonAvailable,
        };
        return want.filter(s => ok[s]);
    }

    /** 主后端，仅用于日志展示。 */
    get backend() {
        return this.chain[0] ?? 'none';
    }

    get available() {
        return this.chain.length > 0;
    }

    async run(imagePath) {
        if (!this.available)
            throw new Error('OCR 后端未就绪');
        if (this._busy)
            throw new Error('OCR 忙');

        this._busy = true;
        const failures = [];
        try {
            for (const stage of this.chain) {
                const t0 = GLib.get_monotonic_time();
                try {
                    const text = await this._runStage(stage, imagePath);
                    if (text && text.trim()) {
                        const ms = Math.round((GLib.get_monotonic_time() - t0) / 1000);
                        Log.info('OCR 成功 [' + stage + '] ' + ms + 'ms, ' +
                            text.trim().length + ' 字');
                        return text.trim();
                    }
                    failures.push(stage + ': 空结果');
                    Log.warn('OCR [' + stage + '] 返回空，尝试下一级');
                } catch (e) {
                    failures.push(stage + ': ' + e.message);
                    Log.warn('OCR [' + stage + '] 失败: ' + e.message);
                }
            }
            throw new Error('OCR 全部失败 — ' + failures.join(' | '));
        } finally {
            this._busy = false;
        }
    }

    _runStage(stage, imagePath) {
        switch (stage) {
        case 'remote':
            return this._remote.run(imagePath);
        case 'rust':
            return this._spawn([this._resolve(this._cfg.binary), imagePath]);
        case 'python':
            return this._spawn([
                this._resolve(this._cfg.pythonBin),
                this._resolve(this._cfg.script),
                imagePath,
                '--lang', this._cfg.lang ?? 'chi_sim+eng',
            ]);
        default:
            return Promise.reject(new Error('未知 OCR 阶段: ' + stage));
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
