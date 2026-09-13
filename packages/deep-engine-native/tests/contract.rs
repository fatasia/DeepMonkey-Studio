use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use deep_engine_native::contract::{default_fixture_path, load_and_validate};
use deep_engine_native::scene::prepare_scene;
use serde_json::Value;

#[test]
fn golden_packet_is_valid_and_drawable() {
    let (packet, summary) = load_and_validate(default_fixture_path()).expect("golden contract");
    assert_eq!(summary.triangles, 13);
    assert_eq!(summary.instances, 4);
    let prepared = prepare_scene(&packet).expect("drawable scene");
    assert_eq!(prepared.geometry_keys.len(), 2);
    assert_eq!(prepared.instances.len(), 4);
}

#[test]
fn wrong_version_and_dangling_references_fail() {
    let source = fs::read_to_string(default_fixture_path()).expect("fixture");
    let mut packet: Value = serde_json::from_str(&source).expect("json");
    packet["version"] = 2.into();
    assert!(validate_temp(&packet).contains("unsupported contract"));

    packet["version"] = 1.into();
    packet["instances"][0]["geometry"] = "missing".into();
    assert!(validate_temp(&packet).contains("dangling resource"));
}

#[test]
fn duplicate_ids_and_invalid_indices_fail() {
    let source = fs::read_to_string(default_fixture_path()).expect("fixture");
    let mut packet: Value = serde_json::from_str(&source).expect("json");
    let duplicate = packet["instances"][0].clone();
    packet["instances"]
        .as_array_mut()
        .expect("instances")
        .push(duplicate);
    assert!(validate_temp(&packet).contains("duplicate instance"));

    let mut packet: Value = serde_json::from_str(&source).expect("json");
    packet["geometries"][0]["indices"][0] = 999.into();
    assert!(validate_temp(&packet).contains("out-of-range index"));
}

#[test]
fn texture_semantics_and_complete_mips_are_enforced() {
    let source = fs::read_to_string(default_fixture_path()).expect("fixture");
    let mut packet: Value = serde_json::from_str(&source).expect("json");
    packet["textures"] = serde_json::json!([{
        "id": "color", "revision": 0, "semantic": "baseColor",
        "width": 2, "height": 2, "data": [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255],
        "mipmaps": [{"width": 1, "height": 1, "data": [255, 0, 0, 255]}]
    }]);
    packet["materials"][0]["baseColorTexture"] =
        serde_json::json!({"texture": "color", "texCoord": 0});
    packet["geometries"][0]["uv0"] =
        serde_json::json!([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    assert!(load_temp(&packet).is_ok());

    packet["textures"][0]["semantic"] = "normal".into();
    assert!(validate_temp(&packet).contains("mismatched texture"));

    packet["textures"][0]["semantic"] = "baseColor".into();
    packet["textures"][0]["mipmaps"][0]["width"] = 2.into();
    assert!(validate_temp(&packet).contains("invalid dimensions"));
}

#[test]
fn texture_slots_select_uv1_per_slot_and_require_only_the_selected_set() {
    let source = fs::read_to_string(default_fixture_path()).expect("fixture");
    let mut packet: Value = serde_json::from_str(&source).expect("json");
    packet["textures"] = serde_json::json!([{
        "id": "color", "revision": 0, "semantic": "baseColor",
        "width": 1, "height": 1, "data": [255, 255, 255, 255]
    }]);
    packet["materials"][0]["baseColorTexture"] =
        serde_json::json!({"texture": "color", "texCoord": 1});
    packet["geometries"][0]["uv1"] =
        serde_json::json!([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
    assert!(load_temp(&packet).is_ok());

    packet["geometries"][0]
        .as_object_mut()
        .expect("geometry")
        .remove("uv1");
    assert!(validate_temp(&packet).contains("requires UV1"));

    packet["materials"][0]["baseColorTexture"]["texCoord"] = 2.into();
    assert!(validate_temp(&packet).contains("invalid texture transform"));
}

fn validate_temp(packet: &Value) -> String {
    load_temp(packet).expect_err("contract should fail")
}

fn load_temp(packet: &Value) -> Result<(), String> {
    static NEXT_FILE: AtomicUsize = AtomicUsize::new(0);
    let suffix = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "target/contract-negative-{}-{suffix}.json",
        std::process::id()
    ));
    fs::create_dir_all(path.parent().expect("parent")).expect("target");
    fs::write(&path, serde_json::to_vec(packet).expect("serialize")).expect("write");
    load_and_validate(&path).map(|_| ())
}
