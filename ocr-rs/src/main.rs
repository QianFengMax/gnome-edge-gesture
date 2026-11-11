//! edgegesture-ocr —— PP-OCRv3 的 Rust 实现。
//!
//! 为什么不用 Python 版：每次调用要付 ~460ms 的 Python 启动 + import 开销，
//! 而实际推理只要 200~600ms。Rust 进程启动 21ms、加载模型 45ms，端到端快 3~5 倍。
//!
//! 流水线（与 RapidOCR 保持一致，否则结果对不上）：
//!   1. 检测  ch_PP-OCRv3_det : 图 -> 文字框
//!   2. 识别  ch_PP-OCRv3_rec : 每个框 -> 文本 + 置信度
//!   3. 后处理：按 y 聚行、行内按 x 排序
//!
//! 检测后处理是难点（DB 算法）：二值化 -> 连通域 -> 轮廓 -> unclip 扩张 -> 最小外接矩形。

mod charset;
mod env;
mod det;
mod rec;
mod resize;

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: edgegesture-ocr <图片> [--json] [--timing]");
        std::process::exit(2);
    }

    let img_path = PathBuf::from(&args[1]);
    let want_json = args.iter().any(|a| a == "--json");
    let want_timing = args.iter().any(|a| a == "--timing");

    let t0 = std::time::Instant::now();

    let img = match image::open(&img_path) {
        Ok(i) => i.to_rgb8(),
        Err(e) => {
            eprintln!("无法读取图片 {}: {e}", img_path.display());
            std::process::exit(2);
        }
    };
    let t_load = t0.elapsed();

    let (items, timing) = match run(&img) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("OCR 失败: {e}");
            std::process::exit(1);
        }
    };

    if want_timing {
        eprintln!(
            "load={}ms det={}ms rec={}ms total={}ms",
            t_load.as_millis(),
            timing.det_ms,
            timing.rec_ms,
            t0.elapsed().as_millis()
        );
    }

    let text = merge_lines(&items);
    if want_json {
        #[derive(serde::Serialize)]
        struct Out<'a> {
            items: &'a [Item],
            text: &'a str,
        }
        println!("{}", serde_json::to_string(&Out { items: &items, text: &text }).unwrap());
    } else {
        println!("{text}");
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Item {
    pub text: String,
    pub score: f32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Default)]
pub struct Timing {
    pub det_ms: u128,
    pub rec_ms: u128,
}

fn run(img: &image::RgbImage) -> Result<(Vec<Item>, Timing), Box<dyn std::error::Error>> {
    let mut timing = Timing::default();

    let t = std::time::Instant::now();
    let boxes = det::detect(img)?;
    for (_i, _b) in boxes.iter().take(3).enumerate() {
    }
    timing.det_ms = t.elapsed().as_millis();

    let t = std::time::Instant::now();
    let mut items = Vec::new();
    for b in &boxes {
        let crop = det::crop(img, b);
        if let Some((text, score)) = rec::recognize(&crop)? {
            if score >= 0.3 && !text.is_empty() {
                items.push(Item {
                    text,
                    score,
                    x: b.min_x(),
                    y: b.min_y(),
                    w: b.width(),
                    h: b.height(),
                });
            }
        }
    }
    timing.rec_ms = t.elapsed().as_millis();

    Ok((items, timing))
}

/// 按 y 聚行、行内按 x 排序（与 Python 版 merge_lines 一致）。
fn merge_lines(items: &[Item]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut sorted: Vec<&Item> = items.iter().collect();
    sorted.sort_by(|a, b| a.y.partial_cmp(&b.y).unwrap().then(a.x.partial_cmp(&b.x).unwrap()));

    let mut heights: Vec<f32> = items.iter().map(|i| i.h).collect();
    heights.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let tol = (6.0f32).max(heights[heights.len() / 2] * 0.6);

    let mut lines: Vec<Vec<&Item>> = Vec::new();
    for it in sorted {
        let mut placed = false;
        for line in lines.iter_mut() {
            if (it.y - line[0].y).abs() <= tol {
                line.push(it);
                placed = true;
                break;
            }
        }
        if !placed {
            lines.push(vec![it]);
        }
    }

    lines
        .iter_mut()
        .map(|line| {
            line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
            line.iter().map(|i| i.text.as_str()).collect::<Vec<_>>().join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}
