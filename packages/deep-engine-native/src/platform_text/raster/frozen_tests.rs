use super::*;
use std::sync::OnceLock;
fn fixture() -> FrozenFontInput {
    static FONT: OnceLock<FrozenFontInput> = OnceLock::new();
    FONT.get_or_init(|| {
        // Test-only discovery: snapshot explicit bytes; production constructor never scans the OS.
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
fn rasterizer() -> FrozenTextRasterizer {
    TextRasterizer::from_frozen_fonts("en-US", vec![fixture()]).unwrap()
}
#[test]
fn batched_labels_reuse_current_glyph_allocations_without_retaining_old_glyphs() {
    let mut painter = rasterizer();
    painter.rasterize_styled(request("AAA")).unwrap();
    let prior: Vec<_> = painter.inner.cache.image_cache.iter().filter_map(|(key, image)|
        image.as_ref().map(|image| (*key, image.data.as_ptr()))).collect();
    assert!(!prior.is_empty());
    painter.rasterize_styled(request("AAA")).unwrap();
    for (key, pointer) in &prior {
        assert_eq!(painter.inner.cache.image_cache[key].as_ref().unwrap().data.as_ptr(), *pointer);
    }
    painter.rasterize_styled(request("BBB")).unwrap();
    assert!(prior.iter().all(|(key, _)| !painter.inner.cache.image_cache.contains_key(key)));
}
fn request(text: &str) -> StyledTextRequest {
    let f = fixture();
    StyledTextRequest {
        text: text.into(),
        font: FrozenFontRef {
            sha256: f.sha256,
            face_index: f.face_index,
        },
        weight: 400,
        style: TextFontStyle::Normal,
        align: TextAlign::Left,
        vertical_align: TextVerticalAlign::Top,
        wrap: TextWrap::None,
        font_size: 20.,
        line_height: 26.,
        width: 320,
        height: 64,
        color: [45, 110, 210, 255],
    }
}
#[test]
fn frozen_font_identity_and_real_pixels_are_deterministic() {
    let mut a = rasterizer();
    let mut b = rasterizer();
    let r = request("AV ffi e\u{0301}");
    let first = a.rasterize_styled(r.clone()).unwrap();
    let second = b.rasterize_styled(r).unwrap();
    assert_eq!(first.rgba, second.rgba);
    assert!(first.rgba.chunks_exact(4).any(|p| p[3] > 0));
    assert_eq!(first.used_faces, second.used_faces);
    assert_eq!(first.used_faces.len(), 1);
    assert_eq!(first.used_faces[0].sha256, fixture().sha256);
    assert_eq!(first.used_faces[0].face_index, fixture().face_index);
    assert!(first.layout_width > 0.);
    assert!(!first.clipped);
}
#[test]
fn alignments_move_ink_without_changing_advance_or_font_identity() {
    let mut raster = rasterizer();
    let mut r = request("Text");
    let left = raster.rasterize_styled(r.clone()).unwrap();
    r.align = TextAlign::Center;
    let center = raster.rasterize_styled(r.clone()).unwrap();
    r.align = TextAlign::Right;
    let right = raster.rasterize_styled(r).unwrap();
    assert_eq!(left.layout_width, center.layout_width);
    assert_eq!(left.layout_width, right.layout_width);
    assert!(left.ink_bounds.unwrap()[0] < center.ink_bounds.unwrap()[0]);
    assert!(center.ink_bounds.unwrap()[0] < right.ink_bounds.unwrap()[0]);
}
#[test]
fn full_layout_checks_missing_glyph_below_the_visible_viewport() {
    let mut raster = rasterizer();
    let mut r = request("OK\n\n\n\u{10FFFF}");
    r.height = 20;
    assert!(
        raster
            .rasterize_styled(r)
            .unwrap_err()
            .contains("cannot render glyph")
    );
}
#[test]
fn wrap_measurement_and_clipping_use_complete_layout() {
    let mut raster = rasterizer();
    let mut r = request("one two three four five six");
    r.width = 64;
    r.height = 20;
    r.wrap = TextWrap::WordOrGlyph;
    let output = raster.rasterize_styled(r).unwrap();
    assert!(output.line_count > 1);
    assert!(output.layout_height > 20.);
    assert!(output.clipped);
    assert!(output.lines.iter().all(|l| l.width <= 64.));
}
#[test]
fn frozen_hash_face_index_duplicates_and_bad_font_data_are_rejected() {
    let f = fixture();
    let mut bad = f.clone();
    bad.sha256 = "0".repeat(64);
    assert!(TextRasterizer::from_frozen_fonts("en", vec![bad]).is_err());
    let mut bad = f.clone();
    bad.face_index = u32::MAX;
    assert!(TextRasterizer::from_frozen_fonts("en", vec![bad]).is_err());
    assert!(TextRasterizer::from_frozen_fonts("en", vec![f.clone(), f]).is_err());
    let bytes = vec![1, 2, 3];
    let sha256 = crate::shader_package::hash::sha256(&bytes);
    assert!(
        TextRasterizer::from_frozen_fonts(
            "en",
            vec![FrozenFontInput {
                bytes,
                sha256,
                face_index: 0
            }]
        )
        .is_err()
    );
    assert!(TextRasterizer::from_frozen_fonts("en", vec![]).is_err());
}
#[test]
fn unknown_face_and_synthetic_style_are_not_silently_substituted() {
    let mut raster = rasterizer();
    let mut r = request("Bold");
    r.weight = 700;
    assert!(raster.rasterize_styled(r).is_err());
    let mut r = request("Italic");
    r.style = TextFontStyle::Italic;
    assert!(raster.rasterize_styled(r).is_err());
    let mut r = request("Unknown");
    r.font.sha256 = "a".repeat(64);
    assert!(raster.rasterize_styled(r).is_err());
}
#[test]
fn request_budget_and_empty_text_are_explicit() {
    let mut raster = rasterizer();
    let empty = raster.rasterize_styled(request("")).unwrap();
    assert_eq!(empty.glyph_count, 0);
    assert!(empty.ink_bounds.is_none());
    assert!(empty.used_faces.is_empty());
    let mut r = request("size");
    r.width = 2049;
    assert!(raster.rasterize_styled(r).is_err());
    let mut r = request("size");
    r.font_size = f32::NAN;
    assert!(raster.rasterize_styled(r).is_err());
    assert!(
        raster
            .rasterize_styled(request(&"a".repeat(16_385)))
            .is_err()
    );
}

#[test]
fn vertical_alignment_offsets_pixels_and_reported_layout_consistently() {
    let mut raster = rasterizer();
    let mut r = request("Vertical");
    r.height = 90;
    r.line_height = 25.5;
    let top = raster.rasterize_styled(r.clone()).unwrap();
    r.vertical_align = TextVerticalAlign::Center;
    let center = raster.rasterize_styled(r.clone()).unwrap();
    r.vertical_align = TextVerticalAlign::Bottom;
    let bottom = raster.rasterize_styled(r).unwrap();
    let room = 90. - top.layout_height;
    assert_eq!(center.layout_height, top.layout_height);
    assert_eq!(bottom.layout_height, top.layout_height);
    for (result, offset) in [(&center, room / 2.), (&bottom, room)] {
        assert_eq!(result.lines[0].top, top.lines[0].top + offset);
        assert_eq!(result.lines[0].baseline, top.lines[0].baseline + offset);
        assert_eq!(
            result.ink_bounds.unwrap()[1],
            top.ink_bounds.unwrap()[1] + offset.round() as u32
        );
        assert!(!result.clipped);
    }
}
#[test]
fn overflowing_text_never_loses_first_line_to_negative_alignment_offset() {
    let mut raster = rasterizer();
    let mut r = request("first\nsecond\nthird");
    r.height = 20;
    let top = raster.rasterize_styled(r.clone()).unwrap();
    assert!(top.clipped);
    for align in [TextVerticalAlign::Center, TextVerticalAlign::Bottom] {
        r.vertical_align = align;
        let output = raster.rasterize_styled(r.clone()).unwrap();
        assert_eq!(output.rgba, top.rgba);
        assert_eq!(output.lines[0].baseline, top.lines[0].baseline);
        assert_eq!(output.layout_height, top.layout_height);
        assert!(output.clipped);
    }
    let mut value = serde_json::to_value(request("required")).unwrap();
    value.as_object_mut().unwrap().remove("verticalAlign");
    assert!(serde_json::from_value::<StyledTextRequest>(value).is_err());
}

#[path = "frozen_regression_tests.rs"]
mod regressions;
