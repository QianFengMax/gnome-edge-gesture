//! 字符集：从 rec 模型的 ONNX 元数据 "character" 字段读取。
//!
//! PP-OCRv3 的字典内嵌在模型里（6625 类），不需要外部 keys.txt。
//! 索引顺序不能变：CTC 解码出的下标直接对应这里的行。

use std::sync::OnceLock;

static CHARSET: OnceLock<Vec<String>> = OnceLock::new();

/// 从模型的 "character" 元数据解析字典。
///
/// 格式：字符之间用换行分隔。PP-OCR 的 CTC 约定是索引 0 为 blank，
/// 所以要在最前面插一个占位符；末尾再补空格（模型不直接输出空格）。
pub fn load_from_string(raw: &str) -> bool {
    let mut chars: Vec<String> = raw.split('\n').map(|s| s.to_string()).collect();
    chars.insert(0, "blank".to_string());
    if !chars.iter().any(|c| c == " ") {
        chars.push(" ".to_string());
    }
    CHARSET.set(chars).is_ok()
}

pub fn get() -> &'static [String] {
    CHARSET.get().map(|v| v.as_slice()).unwrap_or(&[])
}

pub fn is_ready() -> bool {
    CHARSET.get().is_some()
}

#[allow(dead_code)]
pub fn len() -> usize {
    get().len()
}
