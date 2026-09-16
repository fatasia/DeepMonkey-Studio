#![cfg(target_os = "windows")]
use deep_engine_native::platform_text::{TextRasterRequest, TextRasterizer};
use std::sync::{Mutex, OnceLock};

fn rasterizer() -> std::sync::MutexGuard<'static, TextRasterizer> {
    static RASTERIZER: OnceLock<Mutex<TextRasterizer>> = OnceLock::new();
    RASTERIZER
        .get_or_init(|| Mutex::new(TextRasterizer::new()))
        .lock()
        .unwrap()
}
fn request(text: &str) -> TextRasterRequest<'_> {
    TextRasterRequest {
        text,
        family: "Microsoft YaHei",
        font_size: 16.0,
        line_height: 24.0,
        width: 320,
        height: 80,
        color: [50, 130, 210, 200],
    }
}
#[test]
fn installed_chinese_font_generates_real_pixels_and_repeatable_output() {
    let mut rasterizer = rasterizer();
    let first = rasterizer
        .rasterize(request("泵站 A-01\n温度 25.6°C"))
        .unwrap();
    assert_eq!(first.rgba.len(), 320 * 80 * 4);
    assert!(first.glyph_count > 10);
    assert_eq!(first.line_count, 2);
    assert!(
        first
            .rgba
            .chunks_exact(4)
            .filter(|pixel| pixel[3] > 0)
            .count()
            > 100
    );
    for pixel in first.rgba.chunks_exact(4).filter(|pixel| pixel[3] > 0) {
        assert_eq!(&pixel[..3], &[50, 130, 210]);
    }
    let second = rasterizer
        .rasterize(request("泵站 A-01\n温度 25.6°C"))
        .unwrap();
    assert_eq!(first.rgba, second.rgba);
}
#[test]
fn advanced_shaping_handles_arabic_and_combining_text() {
    let mut rasterizer = rasterizer();
    for text in ["مرحبا بالعالم", "e\u{301} + café"] {
        let result = rasterizer.rasterize(request(text)).unwrap();
        assert!(result.glyph_count > 0);
        assert!(result.rgba.chunks_exact(4).any(|pixel| pixel[3] > 0));
    }
}
#[test]
fn empty_and_invalid_requests_are_bounded_without_poisoning_next_render() {
    let mut rasterizer = rasterizer();
    let empty = rasterizer.rasterize(request("")).unwrap();
    assert_eq!(empty.glyph_count, 0);
    assert!(empty.rgba.iter().all(|byte| *byte == 0));
    let mut bad = request("test");
    bad.width = 4096;
    assert!(rasterizer.rasterize(bad).is_err());
    let mut bad = request("test");
    bad.font_size = f32::NAN;
    assert!(rasterizer.rasterize(bad).is_err());
    let huge = "中".repeat(10_000);
    assert!(rasterizer.rasterize(request(&huge)).is_err());
    assert!(rasterizer.rasterize(request("恢复")).unwrap().glyph_count > 0);
}
