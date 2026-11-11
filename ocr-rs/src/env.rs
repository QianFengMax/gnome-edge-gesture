//! ONNX Runtime 只允许每个进程一个 Environment，供 det/rec 共享。

use ort::environment::Environment;
use std::sync::OnceLock;

static ENV: OnceLock<Environment> = OnceLock::new();

pub fn get() -> Result<&'static Environment, Box<dyn std::error::Error>> {
    if let Some(e) = ENV.get() {
        return Ok(e);
    }
    let e = ort::init().with_name("edgegesture-ocr").build()?;
    let _ = ENV.set(e);
    Ok(ENV.get().unwrap())
}
