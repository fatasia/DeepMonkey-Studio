use std::{fs, path::Path};

use deep_engine_native::{
    contract::{RenderPacket, TextureSemantic, default_textured_fixture_path, load_and_validate},
    pbr_texture::{
        MATERIAL_UNIFORM_FLOATS, TextureEncoding, decode_tangent_normal, occlusion_factor,
        prepare_pbr_resources, srgb_channel_to_linear,
    },
    scene::prepare_scene,
};
use serde_json::Value;

#[test]
fn textured_fixture_prepares_all_five_core_slots_and_mips() {
    let (packet, summary) =
        load_and_validate(default_textured_fixture_path()).expect("textured fixture");
    assert_eq!(summary.textures, 5);
    assert_eq!(summary.triangles, 2);
    let prepared = prepare_pbr_resources(&packet).expect("prepare PBR resources");
    assert_eq!(prepared.summary().textures, 5);
    assert_eq!(prepared.summary().mip_levels, 10);
    assert_eq!(prepared.summary().srgb_textures, 2);
    assert_eq!(prepared.summary().linear_textures, 3);
    assert_eq!(
        prepared.materials[0].texture_indices,
        [Some(0), Some(1), Some(2), Some(3), Some(4)]
    );
    assert_eq!(prepared.materials[0].uniform.len(), MATERIAL_UNIFORM_FLOATS);
    assert_eq!(
        [3, 11, 19, 27, 35].map(|offset| prepared.materials[0].uniform[offset]),
        [2.0, 1.0, 1.0, 2.0, 2.0]
    );
    assert_close(prepared.materials[0].uniform[23], 0.4);
    assert_close(prepared.materials[0].uniform[31], 0.65);
    let scene = prepare_scene(&packet).expect("prepare compact instances");
    assert_eq!(&scene.instances[0][32..36], &[0.2, 0.1, 0.05, 1.0]);
    assert_eq!(prepared.textures[0].encoding, TextureEncoding::Srgb);
    assert_eq!(prepared.textures[1].encoding, TextureEncoding::Linear);
    assert_eq!(prepared.textures[2].semantic, TextureSemantic::Normal);
    assert_eq!(prepared.textures[3].semantic, TextureSemantic::Occlusion);
    assert_eq!(prepared.textures[4].encoding, TextureEncoding::Srgb);
}

#[test]
fn padded_rows_are_compacted_before_gpu_upload() {
    let mut value = fixture_value();
    value["textures"][0]["bytesPerRow"] = 12.into();
    value["textures"][0]["data"] = serde_json::json!([
        1, 2, 3, 4, 5, 6, 7, 8, 90, 91, 92, 93, 9, 10, 11, 12, 13, 14, 15, 16
    ]);
    let packet: RenderPacket = serde_json::from_value(value).expect("packet");
    let prepared = prepare_pbr_resources(&packet).expect("compact padded texture");
    assert_eq!(
        prepared.textures[0].levels[0].data,
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
    );
}

#[test]
fn numeric_reference_matches_srgb_ao_and_tangent_space_rules() {
    assert!((srgb_channel_to_linear(128) - 0.215_860_53).abs() < 1e-6);
    assert_close(occlusion_factor(0, 0.4), 0.6);
    assert_close(occlusion_factor(255, 0.4), 1.0);
    let normal = decode_tangent_normal([128, 128, 255], 0.65);
    assert!(normal[0].abs() < 0.004);
    assert!(normal[1].abs() < 0.004);
    assert!(normal[2] > 0.999);
}

#[test]
fn missing_tangent_basis_is_a_structured_rejection() {
    let mut value = fixture_value();
    value["geometries"][0]
        .as_object_mut()
        .expect("geometry")
        .remove("tangents");
    let packet: RenderPacket = serde_json::from_value(value).expect("packet");
    let error = prepare_pbr_resources(&packet).expect_err("tangent basis required");
    assert!(error.contains("requires a tangent basis"));
}

#[test]
fn explicit_null_texture_fields_are_not_treated_as_missing_defaults() {
    let mut value = fixture_value();
    value["textures"][0]["sampler"]["magFilter"] = Value::Null;
    assert!(serde_json::from_value::<RenderPacket>(value).is_err());

    let mut value = fixture_value();
    value["textures"][0]["mipmaps"] = Value::Null;
    assert!(serde_json::from_value::<RenderPacket>(value).is_err());
}

#[test]
fn failed_candidate_does_not_mutate_a_prepared_resource_snapshot() {
    let packet: RenderPacket = serde_json::from_value(fixture_value()).expect("packet");
    let accepted = prepare_pbr_resources(&packet).expect("first candidate");
    let snapshot = accepted.clone();
    let mut invalid = fixture_value();
    invalid["textures"][4]["semantic"] = "normal".into();
    let invalid: RenderPacket = serde_json::from_value(invalid).expect("packet");
    assert!(prepare_pbr_resources(&invalid).is_err());
    assert_eq!(
        accepted, snapshot,
        "published CPU snapshot must remain owned and unchanged"
    );
}

fn fixture_value() -> Value {
    let source = fs::read_to_string(default_textured_fixture_path()).expect("fixture");
    serde_json::from_str(&source).expect("json")
}

fn assert_close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() < 1e-6,
        "expected {expected}, got {actual}"
    );
}

#[test]
fn fixture_is_repository_local_and_deterministic() {
    assert!(Path::new(default_textured_fixture_path()).is_file());
    let bytes = fs::read(default_textured_fixture_path()).expect("fixture bytes");
    assert!(bytes.starts_with(b"{\n"));
}
