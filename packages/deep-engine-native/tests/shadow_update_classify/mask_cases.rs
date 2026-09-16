use super::*;
use deep_engine_native::shadow_cache::{ShadowCache, ShadowVersion};

#[test]
fn mask_alpha_inputs_invalidate() {
    let masked = |cutoff: Option<f32>| {
        let mut packet = fixture_packet();
        edit(
            &mut packet,
            |p| &mut p.materials,
            |m| {
                m[0].alpha_mode = Some(AlphaMode::Mask);
                m[0].base_color_alpha = Some(0.25);
                m[0].alpha_cutoff = cutoff;
            },
        );
        packet
    };
    check(
        &fixture_packet(),
        &masked(None),
        Some(ShadowInvalidation::MaterialCaster),
    );
    check(
        &masked(None),
        &masked(Some(0.75)),
        Some(ShadowInvalidation::MaterialCaster),
    );
}

#[test]
fn mask_base_color_inputs_invalidate() {
    let mapped = || {
        let mut packet = fixture_packet();
        mask_receiver_with_map(&mut packet);
        packet
    };
    check(
        &fixture_packet(),
        &mapped(),
        Some(ShadowInvalidation::MaterialCaster),
    );

    let mut repainted = mapped();
    repainted.textures[0].data = vec![0, 0, 0, 255];
    check(
        &mapped(),
        &repainted,
        Some(ShadowInvalidation::TextureContent),
    );

    let mut remapped = mapped();
    edit(
        &mut remapped,
        |p| &mut p.materials,
        |m| {
            m[0].base_color_texture = Some(slot("other-map"));
        },
    );
    check(
        &mapped(),
        &remapped,
        Some(ShadowInvalidation::MaterialCaster),
    );
}

#[test]
fn mask_sampling_uv0_invalidates() {
    let mapped = || {
        let mut packet = fixture_packet();
        mask_receiver_with_map(&mut packet);
        packet
    };
    let mut uv_shifted = mapped();
    edit(
        &mut uv_shifted,
        |p| &mut p.geometries,
        |g| {
            let mut uv0 = g[0]
                .uv0
                .take()
                .unwrap_or_else(|| vec![0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0]);
            uv0[0] = 0.01;
            g[0].uv0 = Some(uv0);
        },
    );
    check(
        &mapped(),
        &uv_shifted,
        Some(ShadowInvalidation::GeometryContent),
    );
}

#[test]
fn invalid_updates_repaint_never_and_valid_updates_repaint_each_once() {
    let base = fixture_packet();
    let stale = |factor: [f32; 3]| {
        let mut packet = fixture_packet();
        edit(
            &mut packet,
            |p| &mut p.materials,
            |m| m[1].emissive_factor = Some(factor),
        );
        packet
    };
    let shifted = |offset: usize| {
        let mut packet = fixture_packet();
        edit(
            &mut packet,
            |p| &mut p.instances,
            move |i| {
                i[1].transform[offset] += 0.25;
            },
        );
        packet
    };

    assert_eq!(
        shadow_repaints(&base, &[stale([0.4, 0.1, 0.9]), stale([0.1, 0.4, 0.9])]),
        0,
        "consecutive shadow-irrelevant updates must not schedule a repaint"
    );
    assert_eq!(
        shadow_repaints(&base, &[shifted(12), shifted(13)]),
        2,
        "each shadow-relevant update must schedule exactly one repaint"
    );
}

/// Replays classifier decisions against the real `ShadowVersion`/`ShadowCache`
/// pairing and counts how often a shadow render becomes pending.
fn shadow_repaints(base: &RenderPacket, updates: &[RenderPacket]) -> usize {
    let mut version = ShadowVersion::INITIAL;
    let mut cache = ShadowCache::default();
    cache.commit(version);
    let mut repaints = 0;
    let mut previous = base;
    for next in updates {
        if classify_shadow_relevance(previous, next).must_invalidate {
            version.bump_scene();
        }
        if cache.needs_render(version) {
            repaints += 1;
            cache.commit(version);
        }
        previous = next;
    }
    repaints
}
