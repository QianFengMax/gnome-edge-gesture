//! 文本检测：ch_PP-OCRv3_det + DB 后处理。
//!
//! DB (Differentiable Binarization) 后处理：
//!   概率图 -> 阈值二值化 -> 连通域 -> 外接框 -> unclip 扩张 -> 置信度过滤

use std::sync::OnceLock;

use image::RgbImage;
use ort::session::Session;
use ort::value::Tensor;

use crate::resize;

/// 一个文字框（原图坐标，轴对齐）。
#[derive(Debug, Clone)]
pub struct TextBox {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl TextBox {
    pub fn min_x(&self) -> f32 { self.x0 }
    pub fn min_y(&self) -> f32 { self.y0 }
    pub fn width(&self) -> f32 { self.x1 - self.x0 }
    pub fn height(&self) -> f32 { self.y1 - self.y0 }
}

/// 模型路径：优先环境变量，其次从可执行文件旁边的 models/ 找。
fn det_model_path() -> String {
    if let Ok(p) = std::env::var("EDGEGESTURE_MODEL_DIR") {
        return format!("{p}/ch_PP-OCRv3_det_infer.onnx");
    }
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().unwrap_or_else(|| std::path::Path::new("."));
    dir.join("models/ch_PP-OCRv3_det_infer.onnx").to_string_lossy().into_owned()
}

const THRESH: f32 = 0.3;
const BOX_THRESH: f32 = 0.5;
const UNCLIP_RATIO: f32 = 1.6;
const MAX_CANDIDATES: usize = 1000;
const MIN_SIZE: f32 = 3.0;

struct DetSession {
    session: Session,
    input_name: String,
}

static SESSION: OnceLock<std::sync::Mutex<DetSession>> = OnceLock::new();

fn session() -> Result<&'static std::sync::Mutex<DetSession>, Box<dyn std::error::Error>> {
    if let Some(s) = SESSION.get() {
        return Ok(s);
    }
    let env = crate::env::get()?;
    let mut session = Session::builder(env)?
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)?
        .commit_from_file(det_model_path())?;
    let input_name = session.inputs()[0].name().to_string();

    let warm = Tensor::from_array(([1usize, 3, 32, 32], vec![0f32; 3 * 32 * 32]))?;
    let _ = session.run(ort::inputs![input_name.as_str() => warm])?;

    let _ = SESSION.set(std::sync::Mutex::new(DetSession { session, input_name }));
    Ok(SESSION.get().unwrap())
}

/// 检测文字框，返回原图坐标系下的框。
pub fn detect(img: &RgbImage) -> Result<Vec<TextBox>, Box<dyn std::error::Error>> {
    let (ow, oh) = (img.width(), img.height());
    let (tw, th) = resize::det_target_size(ow, oh);
    let small = resize::resize_rgb(img, tw, th);

    let rw = resize::round32(tw);
    let rh = resize::round32(th);
    let padded = resize::resize_rgb(&small, rw, rh);

    let (data, h, w) = resize::to_det_tensor(&padded);
    let tensor = Tensor::from_array(([1usize, 3, h, w], data))?;

    let guard = session()?;
    let mut s = guard.lock().unwrap();
    let name = s.input_name.clone();
    let outputs = s.session.run(ort::inputs![name.as_str() => tensor])?;

    let (shape, pred) = outputs[0].try_extract_tensor::<f32>()?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let (ph, pw) = (dims[2], dims[3]);

    let boxes = postprocess(pred, ph, pw);

    let sx = ow as f32 / rw as f32;
    let sy = oh as f32 / rh as f32;
    Ok(boxes
        .into_iter()
        .map(|b| TextBox {
            x0: (b.x0 * sx).clamp(0.0, ow as f32),
            y0: (b.y0 * sy).clamp(0.0, oh as f32),
            x1: (b.x1 * sx).clamp(0.0, ow as f32),
            y1: (b.y1 * sy).clamp(0.0, oh as f32),
        })
        .filter(|b| b.width() >= MIN_SIZE && b.height() >= MIN_SIZE)
        .collect())
}

/// DB 后处理：二值化 -> 连通域 -> 外接框 -> unclip 扩张。
/// 返回模型坐标系的框（不缩放，由调用方还原）。
fn postprocess(pred: &[f32], h: usize, w: usize) -> Vec<TextBox> {
    let mut mask = vec![false; h * w];
    for i in 0..h * w {
        mask[i] = pred[i] > THRESH;
    }

    let mut labels = vec![0u32; h * w];
    let mut next = 0u32;
    let mut boxes: Vec<TextBox> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();

    for start in 0..h * w {
        if !mask[start] || labels[start] != 0 {
            continue;
        }
        next += 1;
        let label = next;
        stack.clear();
        stack.push(start);
        labels[start] = label;

        let (mut min_x, mut max_x) = (usize::MAX, 0usize);
        let (mut min_y, mut max_y) = (usize::MAX, 0usize);
        let mut sum = 0f32;
        let mut count = 0usize;

        while let Some(idx) = stack.pop() {
            let y = idx / w;
            let x = idx % w;
            sum += pred[idx];
            count += 1;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);

            if x > 0 {
                let n = idx - 1;
                if mask[n] && labels[n] == 0 {
                    labels[n] = label;
                    stack.push(n);
                }
            }
            if x + 1 < w {
                let n = idx + 1;
                if mask[n] && labels[n] == 0 {
                    labels[n] = label;
                    stack.push(n);
                }
            }
            if y > 0 {
                let n = idx - w;
                if mask[n] && labels[n] == 0 {
                    labels[n] = label;
                    stack.push(n);
                }
            }
            if y + 1 < h {
                let n = idx + w;
                if mask[n] && labels[n] == 0 {
                    labels[n] = label;
                    stack.push(n);
                }
            }
        }

        if count < 4 {
            continue;
        }
        let mean = sum / count as f32;
        if mean < BOX_THRESH {
            continue;
        }

        let bw = (max_x - min_x + 1) as f32;
        let bh = (max_y - min_y + 1) as f32;
        if bw < MIN_SIZE || bh < MIN_SIZE {
            continue;
        }

        let area = bw * bh;
        let perimeter = 2.0 * (bw + bh);
        if perimeter <= 0.0 {
            continue;
        }
        let distance = area * UNCLIP_RATIO / perimeter;

        boxes.push(TextBox {
            x0: (min_x as f32 - distance).max(0.0),
            y0: (min_y as f32 - distance).max(0.0),
            x1: (max_x as f32 + distance).min(w as f32),
            y1: (max_y as f32 + distance).min(h as f32),
        });

        if boxes.len() >= MAX_CANDIDATES {
            break;
        }
    }

    boxes.sort_by(|a, b| {
        (a.y0 as i32)
            .cmp(&(b.y0 as i32))
            .then((a.x0 as i32).cmp(&(b.x0 as i32)))
    });
    boxes
}

/// 按框裁图（带 2px 边距）。
pub fn crop(img: &RgbImage, b: &TextBox) -> RgbImage {
    let pad = 2.0f32;
    let x0 = (b.x0 - pad).max(0.0) as u32;
    let y0 = (b.y0 - pad).max(0.0) as u32;
    let x1 = ((b.x1 + pad) as u32).min(img.width());
    let y1 = ((b.y1 + pad) as u32).min(img.height());
    if x1 <= x0 || y1 <= y0 {
        return RgbImage::new(1, 1);
    }
    image::imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image()
}
