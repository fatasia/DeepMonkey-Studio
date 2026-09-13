use std::{f32::consts::PI, fs};

use deep_engine_native::{
    contract::{AlphaMode, RenderPacket, default_alpha_fixture_path, load_and_validate},
    pbr_reference::{mask_covered, straight_alpha_over},
    pbr_texture::prepare_pbr_resources,
    scene::{alpha_summary, prepare_scene, transparent_batch_order},
};
use serde_json::Value;

#[test]
fn alpha_fixture_builds_bounded_batches_and_preserves_mirror_handedness() {
    let (packet, summary) = load_and_validate(default_alpha_fixture_path()).expect("alpha fixture");
    assert_eq!(summary.instances, 4);
    assert_eq!(summary.triangles, 2);
    let scene = prepare_scene(&packet).expect("alpha scene");
    assert_eq!(
        alpha_summary(&scene.batches),
        deep_engine_native::scene::SceneAlphaSummary {
            opaque_batches: 1,
            mask_batches: 1,
            blend_batches: 2,
            double_sided_batches: 2,
        }
    );
    assert!(
        scene
            .batches
            .iter()
            .filter(|batch| batch.alpha_mode == AlphaMode::Blend)
            .all(|batch| batch.instance_count == 1 && batch.sort_center.is_some())
    );
    let mask = &scene.batches[1];
    assert!(mask.double_sided);
    assert!(
        !mask.mirrored,
        "double-sided batches use the no-cull variant"
    );
    assert_eq!(scene.instances[1][30], -1.0, "shader retains mirror sign");
    assert_eq!(scene.instances[1][31], 3.0, "MASK and double-sided flags");
    assert_eq!(scene.instances[2][31], 4.0, "BLEND flag");
    assert_eq!(scene.instances[3][30], -1.0);
    assert_eq!(scene.instances[3][31], 5.0, "BLEND and double-sided flags");
}

#[test]
fn blend_order_is_global_back_to_front_and_tracks_camera_yaw() {
    let (packet, _) = load_and_validate(default_alpha_fixture_path()).expect("alpha fixture");
    let scene = prepare_scene(&packet).expect("alpha scene");
    assert_eq!(scene.batches[2].sort_center, Some([0.35, 0.0, -0.5]));
    assert_eq!(scene.batches[3].sort_center, Some([0.85, 0.0, 0.55]));
    assert_eq!(transparent_batch_order(&scene.batches, 0.0), [2, 3]);
    assert_eq!(transparent_batch_order(&scene.batches, PI), [3, 2]);

    let mut tied = fixture_value();
    tied["instances"][3]["transform"] = tied["instances"][2]["transform"].clone();
    let tied: RenderPacket = serde_json::from_value(tied).expect("tied packet");
    let tied = prepare_scene(&tied).expect("tied scene");
    assert_eq!(transparent_batch_order(&tied.batches, 0.0), [2, 3]);
}

#[test]
fn transparent_bounds_ignore_unreferenced_vertices_and_keep_finite_large_centers() {
    let mut value = fixture_value();
    let vertices = value["geometries"][0]["vertices"]
        .as_array_mut()
        .expect("vertices");
    vertices.extend([
        serde_json::json!(1000.0),
        serde_json::json!(0.0),
        serde_json::json!(1000.0),
        serde_json::json!(0.0),
        serde_json::json!(0.0),
        serde_json::json!(1.0),
    ]);
    value["geometries"][0]["uv0"]
        .as_array_mut()
        .expect("uv0")
        .extend([serde_json::json!(0.0), serde_json::json!(0.0)]);
    value["geometries"][0]["tangents"]
        .as_array_mut()
        .expect("tangents")
        .extend([
            serde_json::json!(1.0),
            serde_json::json!(0.0),
            serde_json::json!(0.0),
            serde_json::json!(1.0),
        ]);
    let packet: RenderPacket = serde_json::from_value(value).expect("packet with unused vertex");
    let scene = prepare_scene(&packet).expect("unused vertices cannot move draw bounds");
    assert_eq!(scene.batches[2].sort_center, Some([0.35, 0.0, -0.5]));
    assert_eq!(scene.batches[3].sort_center, Some([0.85, 0.0, 0.55]));

    let mut value = fixture_value();
    let vertices = value["geometries"][0]["vertices"]
        .as_array_mut()
        .expect("vertices");
    for vertex in vertices.chunks_exact_mut(6) {
        vertex[0] = serde_json::json!(3.0e38_f32);
    }
    for instance in value["instances"]
        .as_array_mut()
        .expect("instances")
        .iter_mut()
        .skip(2)
    {
        let x_scale = instance["transform"][0].as_f64().expect("x scale") as f32;
        instance["transform"][12] = serde_json::json!(-(x_scale * 3.0e38_f32));
    }
    let packet: RenderPacket = serde_json::from_value(value).expect("large finite packet");
    let scene = prepare_scene(&packet).expect("finite midpoint must not overflow");
    assert!(
        scene
            .batches
            .iter()
            .filter_map(|batch| batch.sort_center)
            .all(|center| center.iter().all(|value| value.is_finite()))
    );
}

#[test]
fn material_alpha_factor_is_separate_from_texture_alpha_and_cutoff() {
    let (packet, _) = load_and_validate(default_alpha_fixture_path()).expect("alpha fixture");
    let scene = prepare_scene(&packet).expect("alpha scene");
    let pbr = prepare_pbr_resources(&packet).expect("alpha PBR");
    assert_eq!(pbr.textures[0].levels[0].data[3], 32);
    assert_eq!(pbr.textures[0].levels[0].data[7], 128);
    assert_eq!(scene.instances[1][35], 0.75);
    assert_eq!(scene.instances[1][29], 0.4);
    assert_eq!(scene.instances[2][35], 0.45);
    assert_eq!(scene.instances[3][35], 0.65);
    assert!(
        pbr.materials
            .iter()
            .all(|material| material.uniform.len() == 40)
    );
    assert!(!mask_covered(0.75, 128, 0.4));
    assert!(mask_covered(0.75, 224, 0.4));
    let blended = straight_alpha_over([0.8, 0.4, 0.2, 0.25], [0.2, 0.4, 0.8, 0.5]);
    for (actual, expected) in blended.into_iter().zip([0.35, 0.4, 0.65, 0.625]) {
        assert!((actual - expected).abs() < 1e-6);
    }
}

#[test]
fn unknown_or_premultiplied_blending_is_rejected_during_deserialization() {
    let mut value = fixture_value();
    value["materials"][0]["alphaMode"] = "ADD".into();
    assert!(serde_json::from_value::<RenderPacket>(value).is_err());

    for field in ["premultiplied", "blending"] {
        let mut value = fixture_value();
        value["materials"][0][field] = true.into();
        assert!(serde_json::from_value::<RenderPacket>(value).is_err());
    }

    let mut value = fixture_value();
    value["materials"][0]["doubleSided"] = Value::Null;
    assert!(serde_json::from_value::<RenderPacket>(value).is_err());
}

#[test]
fn rejected_alpha_candidate_cannot_mutate_an_accepted_scene() {
    let (accepted_packet, _) =
        load_and_validate(default_alpha_fixture_path()).expect("alpha fixture");
    let accepted = prepare_scene(&accepted_packet).expect("accepted scene");
    let snapshot = accepted.clone();
    let mut invalid = fixture_value();
    invalid["materials"][1]["baseColorAlpha"] = 2.0.into();
    let invalid: RenderPacket = serde_json::from_value(invalid).expect("typed packet");
    assert!(prepare_scene(&invalid).is_err());
    assert_eq!(accepted, snapshot);
}

#[test]
fn wgsl_and_pipeline_sources_freeze_mask_blend_and_two_sided_rules() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let shader =
        fs::read_to_string(root.join("assets/shaders/native_mesh_v1.wgsl")).expect("mesh shader");
    assert!(shader.contains("input.emissive_alpha.w * base_sample.a"));
    assert!(shader.contains("alpha < input.material.y"));
    assert!(shader.contains("@builtin(front_facing) front_facing"));
    assert!(shader.contains("input.material.z > 0.0"));
    assert!(shader.contains("flag(input.material.w, 1u) && !gltf_front"));

    let pipeline = [
        "src/pipeline.rs",
        "src/pipeline/mesh.rs",
        "src/pipeline/raster.rs",
        "src/pipeline/shadow.rs",
    ]
    .map(|path| fs::read_to_string(root.join(path)).expect("pipeline source"))
    .join("\n");
    assert!(pipeline.contains("MESH_PIPELINE_VARIANTS: usize = 12"));
    assert!(pipeline.contains("BlendFactor::SrcAlpha"));
    assert!(pipeline.contains("BlendFactor::OneMinusSrcAlpha"));
    assert!(pipeline.contains("depth_write_enabled: Some(!transparent)"));
    assert!(pipeline.contains("double_sided"));
    let abi = fs::read_to_string(root.join("src/mesh_abi.rs")).expect("mesh ABI source");
    assert!(abi.contains("0 => Float32x3, 1 => Float32x3, 10 => Float32x2, 13 => Float32x2"));
    assert!(abi.contains("11 => Float32x4"));
}

fn fixture_value() -> Value {
    let source = fs::read_to_string(default_alpha_fixture_path()).expect("fixture");
    serde_json::from_str(&source).expect("fixture JSON")
}
