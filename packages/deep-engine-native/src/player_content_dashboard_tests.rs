use super::*;
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};

const GOLDEN: &[u8] = include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json");

#[test]
fn dashboard_startup_uses_combined_content_and_node_chart_dimensions() {
    let content =
        PlayerContent::from_package(parse_and_validate_runtime_package(GOLDEN).unwrap()).unwrap();
    assert!(content.chart.is_none());
    let runtime = content.dashboard.as_ref().unwrap();
    assert_eq!(runtime.document().pages.len(), 2);
    for node in &runtime.document().pages[0].nodes {
        if node.chart.is_some() {
            let list = runtime.chart(&node.id).unwrap().frame().display_list();
            assert_eq!(
                [list.logical_width, list.logical_height],
                [node.frame[2], node.frame[3]]
            );
        }
    }
    assert_eq!(content.deep2d.as_ref(), Some(runtime.content()));
    assert!(!content.epoch.published);
}

#[test]
fn tiny_chart_layout_is_rejected_before_a_viewer_window_can_open() {
    let mut value: serde_json::Value = serde_json::from_slice(GOLDEN).unwrap();
    let root_id = value["entrypoints"]["dashboard"]
        .as_str()
        .unwrap()
        .to_owned();
    let root = &mut value["payloads"][&root_id];
    for node in root["pages"][0]["nodes"].as_array_mut().unwrap() {
        if !node["chart"].is_null() {
            node["frame"][2] = serde_json::json!(1);
            node["frame"][3] = serde_json::json!(1);
        }
    }
    let hash = runtime_content_sha256(root);
    value["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["id"] == root_id)
        .unwrap()["contentHash"]["value"] = hash.into();
    value["packageHash"]["value"] = runtime_package_sha256(&value).unwrap().into();
    let package = parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(PlayerContent::from_package(package).is_err());
}
