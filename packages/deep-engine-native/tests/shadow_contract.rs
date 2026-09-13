use deep_engine_native::{
    contract::{AlphaMode, load_and_validate},
    mesh_abi::{SHADOW_FORMAT, SHADOW_MAP_SIZE, frame_uniform},
    shadow_cache::{ShadowCache, ShadowCasterMode, ShadowVersion, shadow_caster_mode},
};

#[test]
fn shadow_probe_fixture_is_a_real_two_layer_drawable_scene() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/render_packet_shadow_v1.json");
    let (packet, summary) = load_and_validate(&path).expect("valid shadow probe fixture");
    assert_eq!(
        (summary.geometries, summary.materials, summary.instances),
        (1, 2, 2)
    );
    assert!(packet.instances[1].transform[14] > packet.instances[0].transform[14]);
}

#[test]
fn shadow_cache_only_renders_when_scene_or_light_version_changes() {
    let mut cache = ShadowCache::default();
    let mut version = ShadowVersion::INITIAL;
    assert!(cache.needs_render(version));
    cache.commit(version);
    assert!(!cache.needs_render(version));

    version.bump_light();
    assert!(cache.needs_render(version));
    cache.commit(version);
    version.bump_scene();
    assert!(cache.needs_render(version));
    cache.invalidate();
    assert_eq!(cache.rendered(), None);
}

#[test]
fn opaque_and_mask_cast_but_blend_never_enters_the_shadow_pass() {
    assert_eq!(
        shadow_caster_mode(AlphaMode::Opaque, true),
        Some(ShadowCasterMode::Solid)
    );
    assert_eq!(
        shadow_caster_mode(AlphaMode::Mask, false),
        Some(ShadowCasterMode::MaskPlain)
    );
    assert_eq!(
        shadow_caster_mode(AlphaMode::Mask, true),
        Some(ShadowCasterMode::MaskMaterial)
    );
    assert_eq!(shadow_caster_mode(AlphaMode::Blend, true), None);
}

#[test]
fn frame_contains_a_finite_light_vp_without_repurposing_tuning() {
    assert_eq!(SHADOW_FORMAT, wgpu::TextureFormat::Depth32Float);
    assert_eq!(SHADOW_MAP_SIZE, 2_048);
    let frame = frame_uniform(16.0 / 9.0, 0.55);
    assert!(frame[4..8].iter().flatten().all(|value| value.is_finite()));
    assert_ne!(frame[4..8], [[0.0; 4]; 4]);
    assert_eq!(frame[12], [0.0, 0.0, 0.0, 0.0]);
    assert_eq!(
        frame[4..8],
        frame_uniform(1.0, 0.55)[4..8],
        "surface resize must not invalidate a directional shadow map"
    );
    assert_ne!(
        frame[4..8],
        frame_uniform(16.0 / 9.0, 0.73)[4..8],
        "light rotation must produce a new shadow projection"
    );
}
