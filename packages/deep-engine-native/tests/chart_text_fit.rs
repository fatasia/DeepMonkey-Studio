//! P1-17:文字按真实字形测量做省略截断;字符数上限只是搜索上界。
use deep_engine_native::chart::legend_render::fit_ellipsis;
use deep_engine_native::platform_text::TextRasterizer;

fn fit(
    rasterizer: &mut TextRasterizer,
    text: &str,
    max_width: f64,
    max_chars: usize,
) -> Result<String, String> {
    fit_ellipsis(
        rasterizer,
        text,
        "Inter",
        12.0,
        16.0,
        max_width,
        max_chars,
    )
}

#[test]
fn short_text_passes_through_and_long_text_fits_measured_width() {
    let mut rasterizer = TextRasterizer::new();
    let short = "Short label";
    assert_eq!(fit(&mut rasterizer, short, 400.0, 24).unwrap(), short);
    let long = "Long device name Long device name Long device name Long device name";
    let fitted = fit(&mut rasterizer, long, 120.0, 24).unwrap();
    assert!(fitted.ends_with('…'), "fitted={fitted}");
    assert!(fitted.chars().count() < long.chars().count());
    let width = rasterizer
        .measure(&fitted, "Inter", 12.0, 16.0)
        .unwrap();
    assert!(width <= 120.0, "measured {width} exceeds budget");
    // 同一文本在更大预算下应保留更多字符。
    let wider = fit(&mut rasterizer, long, 400.0, 24).unwrap();
    assert!(wider.chars().count() >= fitted.chars().count());
}

#[test]
fn tiny_budget_degrades_to_ellipsis_and_controls_are_normalized() {
    let mut rasterizer = TextRasterizer::new();
    let tiny = fit(&mut rasterizer, "Any long text", 1.0, 24).unwrap();
    assert_eq!(tiny, "…");
    let normalized = fit(&mut rasterizer, "a\u{7}b", 400.0, 24).unwrap();
    assert_eq!(normalized, "a b");
    assert_eq!(
        fit(&mut rasterizer, "", 100.0, 24).unwrap(),
        "",
        "空文本原样通过,不报错"
    );
    for (text, width, chars) in [
        ("Text", 100.0, 0),
        ("Text", 0.0, 24),
        ("Text", f64::NAN, 24),
    ] {
        assert!(
            fit(&mut rasterizer, text, width, chars).is_err(),
            "budget must be validated"
        );
    }
}

#[test]
fn max_chars_bounds_the_search_without_breaking_the_ellipsis() {
    let mut rasterizer = TextRasterizer::new();
    let long = "ABCDEFGHIJ".repeat(5);
    let fitted = fit(&mut rasterizer, &long, 96.0, 6).unwrap();
    // 前缀最多 6 字符(含省略号最多 7);宽度仍须达标。
    assert!(fitted.chars().count() <= 7);
    let width = rasterizer
        .measure(&fitted, "Inter", 12.0, 16.0)
        .unwrap();
    assert!(width <= 96.0, "measured {width} exceeds budget");
}
