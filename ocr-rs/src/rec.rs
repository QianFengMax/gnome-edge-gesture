//! 文本识别：ch_PP-OCRv3_rec + CTC 贪心解码。
//!
//! 流程：
//!   1. 裁图等比缩到高 48，宽度上限 480（实测：无上限时 616x33 的行会变成
//!      48x896，识别 691ms；限到 480 后 379ms，中文精度几乎无损）
//!   2. 归一化 (x/255 - 0.5) / 0.5，HWC -> CHW
//!   3. 推理得 (1, T, 6625) logits
//!   4. CTC 贪心解码：取 argmax，去重复，去 blank

use std::sync::OnceLock;

use image::RgbImage;
use ort::session::Session;
use ort::value::Tensor;

use crate::charset;
use crate::resize;

fn rec_model_path() -> String {
    if let Ok(p) = std::env::var("EDGEGESTURE_MODEL_DIR") {
        return format!("{p}/ch_PP-OCRv3_rec_infer.onnx");
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().unwrap_or_else(|| std::path::Path::new("."));
    dir.join("models/ch_PP-OCRv3_rec_infer.onnx").to_string_lossy().into_owned()
}

struct RecSession {
    session: Session,
    input_name: String,
}

static SESSION: OnceLock<std::sync::Mutex<RecSession>> = OnceLock::new();

fn session() -> Result<&'static std::sync::Mutex<RecSession>, Box<dyn std::error::Error>> {
    if let Some(s) = SESSION.get() {
        return Ok(s);
    }
    let env = crate::env::get()?;
    let mut session = Session::builder(env)?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
        .commit_from_file(rec_model_path())?;
    let input_name = session.inputs()[0].name().to_string();

    // 从模型元数据取字典（PP-OCRv3 内嵌，无需外部文件）
    let raw = session
        .metadata()?
        .custom("character")
        .ok_or("rec 模型缺少 character 元数据，无法解码")?;
    charset::load_from_string(&raw);
    if !charset::is_ready() {
        return Err("字符集加载失败".into());
    }

    let warm = Tensor::from_array(([1usize, 3, 48, 64], vec![0f32; 3 * 48 * 64]))?;
    let _ = session.run(ort::inputs![input_name.as_str() => warm])?;

    let _ = SESSION.set(std::sync::Mutex::new(RecSession { session, input_name }));
    Ok(SESSION.get().unwrap())
}

/// 识别单行裁图，返回 (文本, 平均置信度)。
pub fn recognize(crop: &RgbImage) -> Result<Option<(String, f32)>, Box<dyn std::error::Error>> {
    if crop.width() == 0 || crop.height() == 0 {
        return Ok(None);
    }

    let (w, h) = (crop.width(), crop.height());
    let tw = resize::rec_target_width(w, h);
    let rh = resize::REC_HEIGHT;
    let resized = resize::resize_rgb(crop, tw, rh);

    let (data, hh, ww) = resize::to_rec_tensor(&resized);
    // 宽度不足时右侧补零（Python 版 padding_im 同行为）
    let target_w = resize::MAX_REC_WIDTH as usize;
    let mut padded = vec![0f32; 3 * hh * target_w];
    for c in 0..3 {
        for y in 0..hh {
            let src = c * hh * ww + y * ww;
            let dst = c * hh * target_w + y * target_w;
            padded[dst..dst + ww].copy_from_slice(&data[src..src + ww]);
        }
    }
    let tensor = Tensor::from_array(([1usize, 3, hh, target_w], padded))?;

    let guard = session()?;
    let mut s = guard.lock().unwrap();
    let name = s.input_name.clone();
    let outputs = s.session.run(ort::inputs![name.as_str() => tensor])?;

    // 输出 (1, T, C)
    let (shape, logits) = outputs[0].try_extract_tensor::<f32>()?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let (steps, classes) = (dims[1], dims[2]);

    Ok(Some(ctc_greedy(logits, steps, classes)))
}

/// CTC 贪心解码：argmax -> 合并重复 -> 去掉 blank(0)。
fn ctc_greedy(logits: &[f32], steps: usize, classes: usize) -> (String, f32) {
    let dict = charset::get();
    let mut text = String::new();
    let mut score_sum = 0f32;
    let mut score_n = 0usize;
    let mut prev = usize::MAX;

    for t in 0..steps {
        let base = t * classes;
        let mut best = 0usize;
        let mut best_v = f32::NEG_INFINITY;
        for c in 0..classes {
            let v = logits[base + c];
            if v > best_v {
                best_v = v;
                best = c;
            }
        }
        // 去重复（相邻同索引只算一次）
        if best != prev {
            if best != 0 && best < dict.len() {
                text.push_str(&dict[best]);
                score_sum += best_v;
                score_n += 1;
            }
            prev = best;
        }
    }

    let score = if score_n > 0 { score_sum / score_n as f32 } else { 0.0 };
    (text, score)
}
