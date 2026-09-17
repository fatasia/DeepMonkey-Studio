use super::measure::{GlyphMeasureLine, GlyphMeasureRequest, MeasuredGlyphRun};
use super::{FrozenFontInput, FrozenFontRef, TextFontStyle, TextRasterizer};

fn fixture() -> FrozenFontInput {
    static FONT: std::sync::OnceLock<FrozenFontInput> = std::sync::OnceLock::new();
    FONT.get_or_init(|| {
        // Test-only discovery: snapshot explicit bytes; production never scans the OS.
        let system = cosmic_text::FontSystem::new();
        let info = system
            .db()
            .faces()
            .find(|f| {
                f.weight.0 == 400
                    && f.style == cosmic_text::Style::Normal
                    && f.families.iter().any(|(n, _)| {
                        ["Arial", "DejaVu Sans", "Liberation Sans"].contains(&n.as_str())
                    })
            })
            .expect("test machine needs an installed static Latin font");
        system
            .db()
            .with_face_data(info.id, |bytes, index| FrozenFontInput {
                bytes: bytes.to_vec(),
                sha256: crate::shader_package::hash::sha256(bytes),
                face_index: index,
            })
            .unwrap()
    })
    .clone()
}

fn line(text: &str) -> GlyphMeasureLine {
    let font = fixture();
    GlyphMeasureLine {
        text: text.into(),
        font: FrozenFontRef {
            sha256: font.sha256,
            face_index: font.face_index,
        },
        weight: 400,
        style: TextFontStyle::Normal,
        font_size: 14.0,
        line_height: 20.0,
    }
}

fn request(lines: Vec<GlyphMeasureLine>) -> GlyphMeasureRequest {
    GlyphMeasureRequest {
        lines,
        atlas_width: 256,
        atlas_height: 64,
    }
}

fn measure(lines: Vec<GlyphMeasureLine>) -> MeasuredGlyphRun {
    let mut rasterizer = TextRasterizer::from_frozen_fonts("en-US", vec![fixture()]).unwrap();
    rasterizer.measure_glyph_run(&request(lines)).unwrap()
}

#[test]
fn latin_measurement_is_deterministic_and_carries_real_coverage() {
    let build = || vec![line("Region A"), line("Region B")];
    let first = measure(build());
    let second = measure(build());
    assert_eq!(first, second, "identical inputs must be byte-identical");
    assert!(
        first.atlas_coverage.iter().any(|b| *b > 0),
        "real glyphs leave ink"
    );
    assert_eq!(first.lines.len(), 2);
    for line in &first.lines {
        assert!(line.layout_width > 0.0);
        assert!(!line.glyphs.is_empty());
        let mut previous = 0u32;
        for glyph in &line.glyphs {
            assert!(glyph.cluster >= previous);
            previous = glyph.cluster;
            let [sx, sy, sw, sh] = glyph.source;
            assert!(
                sw > 0 && sh > 0 && sx + sw <= first.atlas_width && sy + sh <= first.atlas_height
            );
            let [_, dy, dw, dh] = glyph.destination;
            assert!(dw > 0.0 && dh > 0.0 && dy.is_finite());
        }
        // Screen-space sign check: ink must land inside the 20px line box
        // (plus small overshoot slack), not below it. Catches a flipped
        // swash placement.top (baseline-up) sign.
        for glyph in &line.glyphs {
            let [_, dy, _, dh] = glyph.destination;
            assert!(
                dy >= -2.0 && dy + dh <= 24.0,
                "glyph ink {dy}..{} escapes the line box",
                dy + dh
            );
        }
    }
}

#[test]
fn cjk_against_latin_only_face_fails_closed() {
    let mut rasterizer = TextRasterizer::from_frozen_fonts("en-US", vec![fixture()]).unwrap();
    let error = rasterizer
        .measure_glyph_run(&request(vec![line("华东")]))
        .expect_err("missing CJK glyphs must fail, not estimate");
    assert!(error.contains("cannot render"), "{error}");
}

#[test]
fn undersized_atlas_is_rejected_not_clipped() {
    let mut request = request(vec![line("Region A"), line("Region B")]);
    request.atlas_width = 8;
    request.atlas_height = 8;
    let mut rasterizer = TextRasterizer::from_frozen_fonts("en-US", vec![fixture()]).unwrap();
    let error = rasterizer
        .measure_glyph_run(&request)
        .expect_err("an undersized atlas must be reported");
    assert!(error.contains("too small"), "{error}");
}

#[test]
fn whitespace_only_line_defers_without_placements() {
    let run = measure(vec![line(" ")]);
    assert!(run.lines[0].glyphs.is_empty(), "no measurable glyphs");
    assert!(run.atlas_coverage.iter().all(|b| *b == 0));
}

#[test]
fn multiline_and_oversize_lines_are_rejected_up_front() {
    let mut rasterizer = TextRasterizer::from_frozen_fonts("en-US", vec![fixture()]).unwrap();
    assert!(
        rasterizer
            .measure_glyph_run(&request(vec![line("a\nb")]))
            .is_err()
    );
    assert!(rasterizer.measure_glyph_run(&request(vec![])).is_err());
}
