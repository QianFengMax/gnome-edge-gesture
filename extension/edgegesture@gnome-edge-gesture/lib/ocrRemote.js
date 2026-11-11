import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Log from './logger.js';

/**
 * 云端 OCR 适配层。
 *
 * 为什么要有它：本地跑的是 PP-OCRv3 mobile 小模型，复杂排版/小字/花体上
 * 准确率有限。云端接口用的是更大的模型，效果更好。
 *
 * 注意：MouseInc 用的那几个免费接口都已停用（2026-11 实测）：
 *   https://ocr.shuax.com                 连不上
 *   http://aidemo.youdao.com/ocrapi1      errorCode 303，演示站整站 404
 * 所以这里改成可配置的 provider，填自己的 key 即可用。
 *
 * 所有请求都经 curl 子进程发出，靠 --max-time 实现超时；超时/报错由
 * 调用方（OcrRunner）回退到本地，不让用户白框一次。
 */
export class RemoteOcr {
    constructor(cfg = {}) {
        this._cfg = cfg;
    }

    /** provider 有配置即视为启用。 */
    get enabled() {
        const p = this._cfg.provider;
        if (!p || p === 'none')
            return false;
        // 需要 key 的 provider，key 为空时视为未启用
        if (['ocrspace', 'baidu', 'youdao'].includes(p) && !this._cfg.apiKey)
            return false;
        if (['umi', 'custom'].includes(p) && !this._cfg.url)
            return false;
        return true;
    }

    get name() {
        return this._cfg.provider ?? 'none';
    }

    async run(imagePath, timeoutMs) {
        const t = timeoutMs ?? this._cfg.timeoutMs ?? 3000;
        switch (this._cfg.provider) {
        case 'ocrspace': return this._ocrSpace(imagePath, t);
        case 'baidu':    return this._baidu(imagePath, t);
        case 'youdao':   return this._youdao(imagePath, t);
        case 'umi':      return this._umi(imagePath, t);
        case 'custom':   return this._custom(imagePath, t);
        default:
            throw new Error('未知 OCR 提供方: ' + this._cfg.provider);
        }
    }

    // ---- 各自实现 ----

    /** OCR.space：https://ocr.space/ocrapi，免费个人 key 25000 次/月。
     *  公开演示 key "helloworld" 是共享的，会限流，只适合试跑。 */
    async _ocrSpace(image, t) {
        const out = await this._curl([
            '-sS', '-X', 'POST', 'https://api.ocr.space/parse/image',
            '-H', 'apikey: ' + this._cfg.apiKey,
            '--max-time', String(Math.ceil(t / 1000)),
            '-F', 'language=' + (this._cfg.language ?? 'chs'),
            '-F', 'isOverlayRequired=false',
            '-F', 'file=@' + image,
        ], t);
        const j = JSON.parse(out);
        if (j.IsErroredOnProcessing)
            throw new Error('OCR.space: ' + (j.ErrorMessage?.[0] ?? '处理失败'));
        // 限流会以 error 字段返回
        if (j.error)
            throw new Error('OCR.space: ' + String(j.error).slice(0, 120));
        return (j.ParsedResults ?? [])
            .map(r => (r.ParsedText ?? '').replace(/\r/g, '').trimEnd())
            .join('\n')
            .split('\n')
            // 演示 key 会塞一行说明，滤掉；真实 key 不会有
            .filter(l => l && !l.includes('demo key') && !l.startsWith('[Note:'))
            .join('\n');
    }

    /** 百度通用文字识别：需 API Key + Secret Key，先换 access_token。
     *  免费额度 1000 次/月，中文准确率最好。 */
    async _baidu(image, t) {
        const token = await this._baiduToken(t);
        const b64 = await this._base64(image);
        const out = await this._curl([
            '-sS', '-X', 'POST',
            'https://aip.baidubce.com/rest/2.0/ocr/v1/general_basic',
            '--max-time', String(Math.ceil(t / 1000)),
            '-H', 'Content-Type: application/x-www-form-urlencoded',
            '--data-urlencode', 'access_token=' + token,
            '--data-urlencode', 'image=' + b64,
        ], t);
        const j = JSON.parse(out);
        if (j.error_code)
            throw new Error('百度 OCR ' + j.error_code + ': ' + j.error_msg);
        return (j.words_result ?? []).map(w => w.words).join('\n');
    }

    async _baiduToken(timeoutMs) {
        const out = await this._curl([
            '-sS', '-X', 'POST',
            'https://aip.baidubce.com/oauth/2.0/token',
            '--max-time', String(Math.ceil(timeoutMs / 1000)),
            '--data-urlencode', 'grant_type=client_credentials',
            '--data-urlencode', 'client_id=' + this._cfg.apiKey,
            '--data-urlencode', 'client_secret=' + (this._cfg.secretKey ?? ''),
        ], timeoutMs);
        const j = JSON.parse(out);
        if (!j.access_token)
            throw new Error('百度 token 失败: ' + (j.error_description ?? '未知'));
        return j.access_token;
    }

    /** 有道智云 ocrapi：需 appKey + appSecret，签名方式见官方文档。
     *  演示站 aidemo.youdao.com 已停用，这里走的是正式接口。 */
    async _youdao(image, t) {
        const appKey = this._cfg.apiKey;
        const salt = GLib.uuid_string_random();
        const curtime = String(Math.floor(GLib.get_real_time() / 1e6));
        const b64 = await this._base64(image);
        // 有道签名：sha256(appKey + input + salt + curtime + appSecret)
        const sign = await this._sha256(appKey + b64 + salt + curtime +
            (this._cfg.secretKey ?? ''));

        const out = await this._curl([
            '-sS', '-X', 'POST', 'https://openapi.youdao.com/ocrapi',
            '--max-time', String(Math.ceil(t / 1000)),
            '--data-urlencode', 'img=' + b64,
            '--data-urlencode', 'langType=' + (this._cfg.language ?? 'auto'),
            '--data-urlencode', 'detectType=10012',
            '--data-urlencode', 'imageType=1',
            '--data-urlencode', 'appKey=' + appKey,
            '--data-urlencode', 'salt=' + salt,
            '--data-urlencode', 'curtime=' + curtime,
            '--data-urlencode', 'sign=' + sign,
            '--data-urlencode', 'signType=v3',
        ], t);
        const j = JSON.parse(out);
        if (String(j.errorCode ?? '0') !== '0')
            throw new Error('有道 OCR ' + j.errorCode);
        const lines = [];
        for (const region of (j.Result?.regions ?? []))
            for (const line of (region.lines ?? []))
                lines.push((line.text ?? '').trim());
        return lines.filter(Boolean).join('\n');
    }

    /** 自建 Umi-OCR：完全免费无额度，本地或局域网跑，准确率比小模型好。
     *  默认地址 http://127.0.0.1:1224/api/ocr */
    async _umi(image, t) {
        const b64 = await this._base64(image);
        const body = JSON.stringify({base64: b64});
        const out = await this._curl([
            '-sS', '-X', 'POST', this._cfg.url,
            '--max-time', String(Math.ceil(t / 1000)),
            '-H', 'Content-Type: application/json',
            '-d', body,
        ], t);
        const j = JSON.parse(out);
        if (j.code !== 100)
            throw new Error('Umi-OCR code=' + j.code);
        return (j.data ?? []).map(d => d.text ?? '').join('\n');
    }

    /** 自定义接口：把图片 POST 过去，响应正文即识别结果。 */
    async _custom(image, t) {
        const b64 = await this._base64(image);
        const out = await this._curl([
            '-sS', '-X', 'POST', this._cfg.url,
            '--max-time', String(Math.ceil(t / 1000)),
            '-H', 'Content-Type: application/json',
            '-d', JSON.stringify({image: b64}),
        ], t);
        return out.trim();
    }

    // ---- 工具 ----

    _base64(image) {
        return new Promise((resolve, reject) => {
            this._spawn(['base64', '-w0', image], null)
                .then(o => resolve(o.trim()))
                .catch(reject);
        });
    }

    _sha256(text) {
        return new Promise((resolve, reject) => {
            const p = Gio.Subprocess.new(['sha256sum'],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
            p.communicate_utf8_async(text, null, (proc, res) => {
                try {
                    const [, out] = proc.communicate_utf8_finish(res);
                    resolve((out ?? '').split(' ')[0]);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _curl(args, timeoutMs) {
        return this._spawn(['curl', ...args], timeoutMs);
    }

    /** 跑子进程；超时则强杀并抛错，交给上层回退本地。 */
    _spawn(argv, timeoutMs) {
        return new Promise((resolve, reject) => {
            let proc;
            try {
                proc = Gio.Subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                reject(e);
                return;
            }

            let timer = 0;
            let done = false;
            const finish = (fn, arg) => {
                if (done)
                    return;
                done = true;
                if (timer) {
                    GLib.source_remove(timer);
                    timer = 0;
                }
                fn(arg);
            };

            if (timeoutMs > 0) {
                timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs + 500, () => {
                    timer = 0;
                    try {
                        proc.force_exit();
                    } catch { /* 已退出 */ }
                    finish(reject, new Error('云端 OCR 超时 ' + timeoutMs + 'ms'));
                    return GLib.SOURCE_REMOVE;
                });
            }

            proc.communicate_utf8_async(null, null, (p, res) => {
                let out = '', err = '';
                try {
                    [, out, err] = p.communicate_utf8_finish(res);
                } catch (e) {
                    finish(reject, e);
                    return;
                }
                if (!p.get_successful()) {
                    finish(reject, new Error((err || 'curl 失败').trim().slice(0, 200)));
                    return;
                }
                finish(resolve, out ?? '');
            });
        });
    }
}
