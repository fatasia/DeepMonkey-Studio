use super::*;
use cosmic_text::{Attrs, Buffer, Family, FontSystem, Metrics, Shaping, Style, SwashCache, fontdb};
use std::collections::BTreeMap;

fn second_font(primary: &FrozenFontInput) -> FrozenFontInput {
    let primary_fonts = TextRasterizer::from_frozen_fonts("en-US", vec![primary.clone()]).unwrap();
    let primary_family = &primary_fonts.identities.values().next().unwrap().family;
    let system = FontSystem::new();
    for face in system.db().faces().filter(|face| {
        face.weight.0 == 400
            && face.style == Style::Normal
            && face.stretch == cosmic_text::Stretch::Normal
            && face
                .families
                .first()
                .is_some_and(|(name, _)| name != primary_family)
    }) {
        let input = system
            .db()
            .with_face_data(face.id, |bytes, index| FrozenFontInput {
                bytes: bytes.to_vec(),
                sha256: crate::shader_package::hash::sha256(bytes),
                face_index: index,
            })
            .unwrap();
        if input.sha256 == primary.sha256 {
            continue;
        }
        if let Ok(mut producer) = TextRasterizer::from_frozen_fonts("en-US", vec![input.clone()]) {
            let mut r = request("ABC");
            r.font = FrozenFontRef {
                sha256: input.sha256.clone(),
                face_index: input.face_index,
            };
            if producer.rasterize_styled(r).is_ok() {
                return input;
            }
        }
    }
    panic!("test requires another installed static Latin font");
}
#[test]
fn secondary_family_alias_cannot_hijack_the_requested_primary_face() {
    let first = fixture();
    let second = second_font(&first);
    let a = TextRasterizer::from_frozen_fonts("en-US", vec![first]).unwrap();
    let b = TextRasterizer::from_frozen_fonts("en-US", vec![second]).unwrap();
    let (&aid, identity_a) = a.identities.iter().next().unwrap();
    let (&bid, identity_b) = b.identities.iter().next().unwrap();
    let face_a = a.inner.fonts.db().face(aid).unwrap().clone();
    let mut face_b = b.inner.fonts.db().face(bid).unwrap().clone();
    assert_ne!(face_a.families[0].0, face_b.families[0].0);
    // Only database aliases are injected. Both faces retain actual validated font bytes.
    face_b.families.push(face_a.families[0].clone());
    let mut db = fontdb::Database::new();
    let b_id = db.push_face_info(face_b);
    let a_id = db.push_face_info(face_a);
    let mut fonts = FontSystem::new_with_locale_and_db("en-US".into(), db);
    let attrs = Attrs::new().family(Family::Name(&identity_a.family));
    let mut buffer = Buffer::new(&mut fonts, Metrics::new(20., 26.));
    buffer.set_text("ABC", &attrs, Shaping::Advanced, None);
    buffer.shape_until_scroll(&mut fonts, false);
    let actual: Vec<_> = buffer
        .layout_runs()
        .flat_map(|run| run.glyphs.iter().map(|g| g.font_id))
        .collect();
    assert!(!actual.is_empty());
    assert!(
        actual.iter().all(|id| *id == b_id),
        "dependency must demonstrate the real alias misselection"
    );
    let mut producer = FrozenTextRasterizer {
        inner: TextRasterizer {
            fonts,
            cache: SwashCache::new(),
            profile: None,
            display_scale: 1.0,
        },
        identities: BTreeMap::from([(a_id, identity_a.clone()), (b_id, identity_b.clone())]),
    };
    let error = producer.rasterize_styled(request("ABC")).unwrap_err();
    assert!(error.contains("primary family selector"));
    // The other unambiguous primary remains usable; unrelated fallback faces are not banned.
    let mut r = request("ABC");
    r.font = FrozenFontRef {
        sha256: identity_b.sha256.clone(),
        face_index: identity_b.face_index,
    };
    let raster = producer.rasterize_styled(r).unwrap();
    assert!(raster.rgba.chunks_exact(4).any(|p| p[3] > 0));
    assert_eq!(raster.used_faces, vec![identity_b.clone()]);
}
#[test]
fn half_pixel_vertical_offset_is_one_rigid_translation_across_zero() {
    let mut producer = rasterizer();
    let mut r = request("ÉH");
    r.line_height = 1.;
    r.height = 2;
    r.vertical_align = TextVerticalAlign::Center;
    let center = producer.rasterize_styled(r.clone()).unwrap();
    r.vertical_align = TextVerticalAlign::Bottom;
    let bottom = producer.rasterize_styled(r).unwrap();
    assert_eq!(center.layout_height, 1.);
    assert_eq!(center.lines[0].top, 0.5);
    assert_eq!(bottom.lines[0].top, 1.);
    assert_eq!(
        center.rgba, bottom.rgba,
        "offsets .5 and 1 quantize to the same rigid pixel translation"
    );
    assert_eq!(center.ink_bounds, bottom.ink_bounds);
    assert!(center.rgba.chunks_exact(4).any(|p| p[3] > 0));
    assert!(center.clipped && bottom.clipped);
}
#[test]
fn offscreen_missing_glyph_is_rejected_before_raster_cache_population() {
    let mut producer = rasterizer();
    let mut r = request("AAAA\n\n\u{10FFFF}");
    r.height = 1;
    assert!(producer.rasterize_styled(r).is_err());
    assert!(producer.inner.cache.image_cache.is_empty());
}
