use deep_engine_native::{
    deep2d::prepare_runtime_content, runtime_package::parse_and_validate_runtime_package,
};

const GOLDEN: &[u8] =
    include_bytes!("../../deep-engine/fixtures/dashboard-content-runtime-v1.json");

#[test]
fn authored_shapes_compile_to_native_paths_without_raster_snapshots() {
    let package = parse_and_validate_runtime_package(GOLDEN).unwrap();
    assert_eq!(package.package_id, "dashboard.shape-content");
    assert!(package.render_packet.geometries.is_empty());
    let content = package.deep2d.as_ref().unwrap();
    let prepared = prepare_runtime_content(content).unwrap();
    // 三个组件各产出容器背景 + 内容填充;边框未配置时无描边三角形。
    assert_eq!(prepared.path.summary.commands, 6);
    assert!(prepared.path.vertices.len() > 6 * 6);
    assert_eq!(prepared.path.summary.stroke_triangles, 0);
    assert!(prepared.atlases.is_empty());
    assert!(prepared.atlas_vertices.is_empty());
    // This test exercises Native path tessellation, including rounded and elliptical curves.
    let report: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../deep-engine/fixtures/dashboard-content-v1.json"
    ))
    .unwrap();
    assert_eq!(report["publicationReady"], false);
    assert_eq!(report["capabilityReport"]["degraded"], 3);
    assert_eq!(report["capabilityReport"]["contentCompiled"], 3);
    assert_eq!(
        report["displayList"]["commands"].as_array().unwrap().len(),
        6
    );
}

#[test]
fn a_changed_author_path_cannot_keep_its_original_package_identity() {
    let mut value: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    let entry = value["entrypoints"]["deep2d"].as_str().unwrap().to_owned();
    value["payloads"][&entry]["displayList"]["resources"][0]["verbs"][1]["x"] =
        serde_json::json!(999);
    assert!(parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).is_err());
}
