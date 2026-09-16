use deep_engine_native::{
    contract::{AlphaMode, RenderPacket, ShadingModel},
    culling_contract::prepare_gpu_culling,
    lod_contract::prepare_gpu_lod,
    pbr_texture::prepare_pbr_resources,
    runtime_package::parse_and_validate_runtime_package,
    scene::prepare_scene,
    scene_resource_identity::scene_resource_manifest,
};

#[path = "../src/shadow_update_classify.rs"]
mod shadow_update_classify;

fn value() -> serde_json::Value {
    serde_json::from_str(include_str!("../fixtures/render_packet_shadow_v1.json")).unwrap()
}

fn packet() -> RenderPacket {
    serde_json::from_value(value()).unwrap()
}

#[test]
fn optional_surface_fields_remain_strict_and_legacy_defaults_are_unchanged() {
    let old = packet();
    let mut explicit = packet();
    for instance in &mut explicit.instances {
        instance.cast_shadow = Some(true);
        instance.receive_shadow = Some(true);
    }
    assert_eq!(
        prepare_scene(&old).unwrap(),
        prepare_scene(&explicit).unwrap()
    );
    for field in ["castShadow", "receiveShadow"] {
        for invalid in [
            serde_json::Value::Null,
            serde_json::json!(0),
            serde_json::json!("false"),
        ] {
            let mut json = value();
            json["instances"][0][field] = invalid;
            assert!(
                serde_json::from_value::<RenderPacket>(json).is_err(),
                "{field}"
            );
        }
    }
    for invalid in [
        serde_json::Value::Null,
        serde_json::json!("lit"),
        serde_json::json!(true),
    ] {
        let mut json = value();
        json["materials"][0]["shadingModel"] = invalid;
        assert!(serde_json::from_value::<RenderPacket>(json).is_err());
    }
    let mut json = value();
    json["materials"][0]["shadingModel"] = serde_json::json!("unlit");
    json["instances"][0]["castShadow"] = serde_json::json!(false);
    json["instances"][0]["receiveShadow"] = serde_json::json!(false);
    let parsed: RenderPacket = serde_json::from_value(json).unwrap();
    assert_eq!(parsed.materials[0].shading_model, Some(ShadingModel::Unlit));
    assert_eq!(prepare_scene(&parsed).unwrap().instances[0][31], 80.0);
}

#[test]
fn browser_golden_flags_preserve_alpha_and_sidedness_for_every_combination() {
    for (alpha, bits) in [
        (AlphaMode::Opaque, 0),
        (AlphaMode::Mask, 2),
        (AlphaMode::Blend, 4),
    ] {
        for double_sided in [false, true] {
            for receive in [false, true] {
                for unlit in [false, true] {
                    let mut packet = packet();
                    packet.materials[0].alpha_mode = Some(alpha);
                    packet.materials[0].double_sided = Some(double_sided);
                    packet.materials[0].shading_model = unlit.then_some(ShadingModel::Unlit);
                    packet.instances[0].receive_shadow = Some(receive);
                    let expected = bits
                        + u32::from(double_sided)
                        + 16 * u32::from(!receive)
                        + 64 * u32::from(unlit);
                    assert_eq!(
                        prepare_scene(&packet).unwrap().instances[0][31],
                        expected as f32
                    );
                }
            }
        }
    }
}

#[test]
fn blended_cutout_preserves_browser_abi_and_zero_default_threshold() {
    let mut json = value();
    json["materials"][0]["alphaMode"] = serde_json::json!("BLEND");
    let mut parsed: RenderPacket = serde_json::from_value(json).unwrap();
    let plain = prepare_scene(&parsed).unwrap();
    assert_eq!(plain.instances[0][29], 0.0);
    assert_eq!(plain.instances[0][31], 4.0);
    parsed.materials[0].alpha_cutoff = Some(0.25);
    let cutout = prepare_scene(&parsed).unwrap();
    assert_eq!(cutout.instances[0][29], 0.25);
    assert_eq!(cutout.instances[0][31], 6.0);
}

#[test]
fn caster_batches_split_without_hiding_noncasters_from_main_or_lod() {
    let mut packet =
        parse_and_validate_runtime_package(include_bytes!("fixtures/runtime-package-lod-v1.json"))
            .unwrap()
            .render_packet;
    packet.instances.truncate(2);
    assert_eq!(prepare_scene(&packet).unwrap().batches.len(), 1);
    packet.instances[1].cast_shadow = Some(false);
    let scene = prepare_scene(&packet).unwrap();
    assert_eq!(scene.batches.len(), 2);
    let lod = prepare_gpu_lod(&packet, &scene).unwrap();
    assert_eq!(lod.objects[0][0][3], 3);
    assert_eq!(lod.objects[1][0][3], 1);
    for instance in &mut packet.instances {
        instance.lod = None;
    }
    let scene = prepare_scene(&packet).unwrap();
    let culling = prepare_gpu_culling(&packet, &scene).unwrap();
    assert_eq!(culling.metadata[0][1], 3);
    assert_eq!(culling.metadata[1][1], 1);
    packet.instances[1].cast_shadow = None;
    packet.instances[1].receive_shadow = Some(false);
    assert_eq!(prepare_scene(&packet).unwrap().batches.len(), 1);
}

#[test]
fn updates_refresh_instance_identity_but_only_casting_invalidates_shadow() {
    let old = packet();
    let identity = |packet: &RenderPacket| {
        scene_resource_manifest(
            packet,
            &prepare_scene(packet).unwrap(),
            &prepare_pbr_resources(packet).unwrap(),
        )
        .unwrap()
    };
    let baseline = identity(&old);
    for change in 0..3 {
        let mut updated = packet();
        match change {
            0 => updated.instances[0].cast_shadow = Some(false),
            1 => updated.instances[0].receive_shadow = Some(false),
            _ => updated.materials[0].shading_model = Some(ShadingModel::Unlit),
        }
        let updated_identity = identity(&updated);
        assert_ne!(baseline.instances, updated_identity.instances);
        assert_eq!(baseline.materials, updated_identity.materials);
        let dirty = shadow_update_classify::classify_shadow_relevance(&old, &updated);
        assert_eq!(dirty.must_invalidate, change == 0);
        let reverse = shadow_update_classify::classify_shadow_relevance(&updated, &old);
        assert_eq!(reverse.must_invalidate, change == 0);
    }
    let mut explicit = packet();
    explicit.instances[0].cast_shadow = Some(true);
    explicit.instances[0].receive_shadow = Some(true);
    assert_eq!(baseline, identity(&explicit));
    assert!(!shadow_update_classify::classify_shadow_relevance(&old, &explicit).must_invalidate);
}
