use deep_engine_native::{
    deep2d::prepare_runtime_content, runtime_package::parse_and_validate_runtime_package,
};

const GOLDEN: &[u8] = include_bytes!("../../deep-engine/fixtures/dashboard-runtime-v1.json");

#[test]
fn typescript_dashboard_package_loads_actual_atlas_pixels_without_scene_geometry() {
    let package = parse_and_validate_runtime_package(GOLDEN).unwrap();
    assert_eq!(package.package_id, "dashboard.main");
    assert!(package.render_packet.geometries.is_empty());
    assert!(package.render_packet.instances.is_empty());
    let content = package.deep2d.as_ref().expect("actual Deep2D entry");
    let prepared = prepare_runtime_content(content).unwrap();
    assert!(!prepared.atlases.is_empty());
    assert!(!prepared.atlas_vertices.is_empty());
    assert!(
        prepared
            .atlases
            .iter()
            .any(|atlas| atlas.data.iter().any(|byte| *byte != 0))
    );
}

#[test]
fn tampered_dashboard_pixels_fail_before_native_preparation() {
    let mut value: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    let id = value["entrypoints"]["deep2d"].as_str().unwrap().to_owned();
    value["payloads"][&id]["atlases"][0]["dataBase64"] = serde_json::json!("AA==");
    assert!(parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).is_err());
    assert!(parse_and_validate_runtime_package(GOLDEN).is_ok());
}
