//! 图像缩放与归一化。
//!
//! 必须与 Python 版一致，否则模型看到的输入分布变了，识别结果会漂移：
//!   Det: resize 到 32 的倍数 -> 归一化 (x/255 - mean) / std，HWC -> CHW
//!   Rec: 等比缩到高 48 -> 归一化 (x/255 - 0.5) / 0.5，HWC -> CHW

use image::{imageops, RgbImage};

pub const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
pub const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// 检测输入：短边上限 736、总像素上限 95 万，只缩不放。
/// 这些值来自实测：RapidOCR 默认 limit_type=min 会把 700x120 撑成 4288x736，
/// 检测从 311ms 涨到 1295ms。
pub const MAX_SHORT_SIDE: u32 = 736;
pub const MAX_DET_PIXELS: u32 = 950_000;

pub fn det_target_size(w: u32, h: u32) -> (u32, u32) {
    let mut scale = 1.0f32;
    let short = w.min(h);
    if short > MAX_SHORT_SIDE {
        scale = scale.min(MAX_SHORT_SIDE as f32 / short as f32);
    }
    let pixels = w * h;
    if pixels > MAX_DET_PIXELS {
        scale = scale.min((MAX_DET_PIXELS as f32 / pixels as f32).sqrt());
    }
    if scale >= 1.0 {
        return (w, h);
    }
    (
        ((w as f32 * scale) as u32).max(1),
        ((h as f32 * scale) as u32).max(1),
    )
}

/// 缩放到 32 的倍数（DB 检测网络要求）。
pub fn round32(v: u32) -> u32 {
    ((v as f32 / 32.0).round() as u32 * 32).max(32)
}

pub fn resize_rgb(img: &RgbImage, w: u32, h: u32) -> RgbImage {
    if img.width() == w && img.height() == h {
        return img.clone();
    }
    imageops::resize(img, w, h, imageops::FilterType::Triangle)
}

/// HWC RGB u8 -> CHW f32，按 Det 的 mean/std 归一化。
pub fn to_det_tensor(img: &RgbImage) -> (Vec<f32>, usize, usize) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut out = vec![0f32; 3 * h * w];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                let v = p[c] as f32 / 255.0;
                out[c * h * w + y * w + x] = (v - DET_MEAN[c]) / DET_STD[c];
            }
        }
    }
    (out, h, w)
}

/// 识别输入固定高 48，宽度按比例但不超过限值。
pub const REC_HEIGHT: u32 = 48;
pub const MAX_REC_WIDTH: u32 = 480;

pub fn rec_target_width(w: u32, h: u32) -> u32 {
    if h == 0 {
        return 1;
    }
    let target = (REC_HEIGHT as f32 * (w as f32 / h as f32)) as u32;
    target.clamp(1, MAX_REC_WIDTH)
}

/// HWC RGB u8 -> CHW f32，按 Rec 的 0.5/0.5 归一化。
pub fn to_rec_tensor(img: &RgbImage) -> (Vec<f32>, usize, usize) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut out = vec![0f32; 3 * h * w];
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                out[c * h * w + y * w + x] = (p[c] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
    }
    (out, h, w)
}
