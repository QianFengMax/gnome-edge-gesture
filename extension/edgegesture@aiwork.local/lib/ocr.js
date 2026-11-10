import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Log from './logger.js';

/**
 * OCR 桥：把 PNG 落到临时文件，调后端 Python（RapidOCR）拿文本。
 * 用异步子进程，不阻塞合成器；同一时刻只跑一个任务。
 */
export class OcrRunner {
    constructor(cfg) {
        this._cfg = cfg;
        this._busy = false;
    }

    get available() {
        return !!(this._cfg.pythonBin && this._cfg.script &&
            GLib.file_test(this._cfg.pythonBin, GLib.FileTest.IS_EXECUTABLE) &&
            GLib.file_test(this._cfg.script, GLib.FileTest.EXISTS));
    }

    /**
     * @param {string} imagePath PNG 绝对路径
     * @param {string} lang 'chi_sim+eng' 之类，后端自行解释
     * @returns {Promise<string>}
     */
    run(imagePath, lang = 'chi_sim+eng') {
        if (!this.available)
            return Promise.reject(new Error('OCR 后端未就绪'));
        if (this._busy)
            return Promise.reject(new Error('OCR 忙'));

        this._busy = true;
        const argv = [this._cfg.pythonBin, this._cfg.script, imagePath, '--lang', lang];

        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let proc;
            try {
                proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                this._busy = false;
                reject(e);
                return;
            }
            proc.communicate_utf8_async(null, null, (p, res) => {
                this._busy = false;
                try {
                    const [, out, err] = p.communicate_utf8_finish(res);
                    stdout = out ?? '';
                    stderr = err ?? '';
                } catch (e) {
                    reject(e);
                    return;
                }
                if (!p.get_successful()) {
                    Log.log('OCR 失败', stderr.slice(0, 300));
                    reject(new Error(stderr.trim() || 'OCR 进程失败'));
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}
