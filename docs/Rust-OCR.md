# Rust OCR 实现

## 为什么做

Python 版每次调用要付约 460ms 的进程启动 + import 开销，而实际推理只要
200~600ms。Rust 版进程启动 21ms、模型加载 45ms，这笔固定成本直接省掉。

## 效果（本机 aarch64 SM8550 实测）

| 场景 | Python | Rust | 提速 |
|---|---|---|---|
| 单行 700x120 | 636ms | 252ms | 2.5x |
| 6 行 840x460 | 973ms | 468ms | 2.1x |
| 5 行 600x400 | 679ms | 445ms | 1.5x |

输出与原 Python 版逐字一致（6 行样例里 Rust 还多识别对一个空格）。

## 结构

\`\`\`
ocr-rs/
  src/main.rs     入口、行合并
  src/env.rs      ONNX Runtime 环境（每进程只能有一个）
  src/det.rs      检测 + DB 后处理
  src/rec.rs      识别 + CTC 贪心解码
  src/resize.rs   缩放与归一化
  src/charset.rs  字典（从模型元数据读）
\`\`\`

## 两个关键实现细节

### 1. DB 后处理没有现成 Rust 库，手写的

\`\`\`
概率图 -> 阈值二值化(0.3) -> 4邻域连通域(迭代 flood fill，不递归)
      -> 外接框 -> unclip 扩张(ratio=1.6) -> 置信度过滤(0.5)
\`\`\`

坐标陷阱：postprocess 必须返回模型坐标系的框，由 detect 统一乘缩放比还原。
第一次在 postprocess 里除了 scale，detect 里又乘一次，框缩成 0.4x0.1 被全部过滤。

### 2. 字典内嵌在模型里

ch_PP-OCRv3_rec 的 ONNX 元数据有 character 字段（6625 类）。
用 session.metadata()?.custom("character") 读取，按换行切分，
前面插 blank 占位（CTC 索引 0 是空白）。

## 构建

\`\`\`bash
./scripts/build-ocr-rs.sh
\`\`\`

依赖系统 libonnxruntime（apt install libonnxruntime-dev）。
模型复用 .venv 里 rapidocr 的 onnx 文件，不用额外下载。

## 切换后端

config.json：

\`\`\`json
"ocr": {
  "backend": "rust",
  "binary": ".../bin/edgegesture-ocr"
}
\`\`\`

Rust 二进制缺失或执行失败时自动降级到 Python。

## 踩过的坑

- ort 的 API 在 rc 版本频繁变动：Session::builder() 需要 &Environment，
  Value 改成了 Tensor::from_array。
- ONNX Runtime 每进程只允许一个 Environment，det 和 rec 必须共享，
  否则报 only one environment is allowed per process。
- 必须预热一次推理，否则首次调用把模型加载时间算进用户感知。
