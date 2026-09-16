//! Windows evidence uses installed font bytes only in memory, never artifact font fixtures.
use super::*;
use cosmic_text::{FontSystem, Style, fontdb};
fn snapshot(fonts: &FontSystem, id: fontdb::ID) -> FrozenFontInput {
    fonts
        .db()
        .with_face_data(id, |bytes, index| FrozenFontInput {
            bytes: bytes.to_vec(),
            sha256: crate::shader_package::hash::sha256(bytes),
            face_index: index,
        })
        .expect("installed test face bytes must be accessible")
}
fn yahei_faces() -> Vec<FrozenFontInput> {
    let fonts = FontSystem::new();
    let mut faces: Vec<_> = fonts
        .db()
        .faces()
        .filter(|face| {
            face.weight.0 == 400
                && face.style == Style::Normal
                && face
                    .families
                    .iter()
                    .any(|(family, _)| family.contains("YaHei"))
        })
        .map(|face| snapshot(&fonts, face.id))
        .collect();
    faces.sort_by(|a, b| (&a.sha256, a.face_index).cmp(&(&b.sha256, b.face_index)));
    faces.dedup_by(|a, b| a.sha256 == b.sha256 && a.face_index == b.face_index);
    let first = faces
        .iter()
        .find(|a| {
            faces
                .iter()
                .any(|b| a.sha256 == b.sha256 && a.face_index != b.face_index)
        })
        .expect("Windows evidence requires installed Microsoft YaHei TTC with multiple faces")
        .sha256
        .clone();
    faces.retain(|f| f.sha256 == first);
    faces.truncate(2);
    assert_eq!(faces.len(), 2);
    faces
}
fn request(font: &FrozenFontInput, text: &str) -> StyledTextRequest {
    StyledTextRequest {
        text: text.into(),
        font: FrozenFontRef {
            sha256: font.sha256.clone(),
            face_index: font.face_index,
        },
        weight: 400,
        style: TextFontStyle::Normal,
        align: TextAlign::Left,
        vertical_align: TextVerticalAlign::Top,
        wrap: TextWrap::None,
        font_size: 28.,
        line_height: 38.,
        width: 640,
        height: 96,
        color: [85, 120, 210, 255],
    }
}
fn assert_ink(output: &StyledRasterizedText) {
    let mut bounds = None;
    for (i, pixel) in output.rgba.chunks_exact(4).enumerate() {
        if pixel[3] == 0 {
            continue;
        }
        let x = i as u32 % output.width;
        let y = i as u32 / output.width;
        let b = bounds.get_or_insert([x, y, x + 1, y + 1]);
        b[0] = b[0].min(x);
        b[1] = b[1].min(y);
        b[2] = b[2].max(x + 1);
        b[3] = b[3].max(y + 1);
    }
    assert!(
        bounds.is_some(),
        "text must produce actual nontransparent pixels"
    );
    assert_eq!(
        output.ink_bounds, bounds,
        "inkBounds must be exact LTRB with exclusive right/bottom"
    );
    assert!(
        output.glyph_count > 0
            && output.line_count > 0
            && output.layout_width > 0.
            && output.layout_height > 0.
    );
    assert!(
        output
            .lines
            .iter()
            .all(|line| line.baseline.is_finite() && line.top.is_finite() && line.width > 0.)
    );
}
#[test]
fn yahei_ttc_chinese_combining_marks_keep_distinct_frozen_face_indices() {
    let fonts = yahei_faces();
    assert_eq!(fonts[0].sha256, fonts[1].sha256);
    assert_ne!(fonts[0].face_index, fonts[1].face_index);
    let mut producer = TextRasterizer::from_frozen_fonts("zh-CN", fonts.clone()).unwrap();
    let mut identities = Vec::new();
    for font in &fonts {
        let result = producer
            .rasterize_styled(request(font, "中文水泵 e\u{0301} A\u{0308}"))
            .unwrap();
        assert_ink(&result);
        assert!(!result.clipped);
        assert_eq!(result.used_faces.len(), 1);
        assert_eq!(result.used_faces[0].sha256, font.sha256);
        assert_eq!(result.used_faces[0].face_index, font.face_index);
        let mut clipped = request(font, "中文水泵 e\u{0301}");
        clipped.width = 24;
        clipped.height = 16;
        let clip = producer.rasterize_styled(clipped).unwrap();
        assert_ink(&clip);
        assert!(clip.clipped);
        identities.push(result.used_faces[0].clone());
    }
    assert_ne!(identities[0].face_index, identities[1].face_index);
}
fn rtl_font() -> FrozenFontInput {
    let fonts = FontSystem::new();
    for face in fonts.db().faces().filter(|face| {
        face.weight.0 == 400
            && face.style == Style::Normal
            && face
                .families
                .iter()
                .any(|(family, _)| ["Arial", "Segoe UI", "Tahoma"].contains(&family.as_str()))
    }) {
        let font = snapshot(&fonts, face.id);
        if let Ok(mut producer) = TextRasterizer::from_frozen_fonts("he-IL", vec![font.clone()])
            && producer
                .rasterize_styled(request(&font, "שלום e\u{0301}"))
                .is_ok()
        {
            return font;
        }
    }
    panic!(
        "Windows evidence requires an installed static font covering Hebrew and combining marks"
    );
}
#[test]
fn rtl_and_mixed_chinese_runs_use_only_explicit_frozen_faces() {
    let rtl = rtl_font();
    let yahei = yahei_faces().remove(0);
    let mut producer =
        TextRasterizer::from_frozen_fonts("he-IL", vec![yahei.clone(), rtl.clone()]).unwrap();
    let left = producer
        .rasterize_styled(request(&rtl, "שלום e\u{0301}"))
        .unwrap();
    assert_ink(&left);
    let mut right_request = request(&rtl, "שלום e\u{0301}");
    right_request.align = TextAlign::Right;
    let right = producer.rasterize_styled(right_request).unwrap();
    assert_ink(&right);
    assert_eq!(left.layout_width, right.layout_width);
    assert!(right.ink_bounds.unwrap()[0] > left.ink_bounds.unwrap()[0]);
    let mixed = producer
        .rasterize_styled(request(&yahei, "中文 e\u{0301} שלום"))
        .unwrap();
    assert_ink(&mixed);
    assert!(!mixed.clipped);
    for used in &mixed.used_faces {
        assert!(
            [&yahei, &rtl]
                .iter()
                .any(|font| font.sha256 == used.sha256 && font.face_index == used.face_index)
        );
    }
    let repeated = producer
        .rasterize_styled(request(&yahei, "中文 e\u{0301} שלום"))
        .unwrap();
    assert_eq!(mixed.rgba, repeated.rgba);
    assert_eq!(mixed.used_faces, repeated.used_faces);
}
