use deep_engine_native::native_ui::{RetainedUiTree, layout_tree, validate_retained_ui_tree};

#[test]
fn compiled_dashboard_source_has_the_same_visible_rectangles_in_native() {
    let golden: serde_json::Value = serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/dashboard-layout-v1.json"
    ))
    .unwrap();
    let tree: RetainedUiTree = serde_json::from_value(golden["tree"].clone()).unwrap();
    let validation = validate_retained_ui_tree(&tree);
    assert!(validation.valid, "{:?}", validation.diagnostics);
    let native = layout_tree(&tree).unwrap();
    let expected = golden["layout"]["frames"].as_array().unwrap();
    assert_eq!(native.frames.len(), expected.len());
    for (frame, expected) in native.frames.iter().zip(expected) {
        assert_eq!(frame.id, expected["id"].as_str().unwrap());
        assert_eq!(
            frame.rect,
            [
                expected["x"].as_f64().unwrap(),
                expected["y"].as_f64().unwrap(),
                expected["width"].as_f64().unwrap(),
                expected["height"].as_f64().unwrap()
            ]
        );
        assert_eq!(frame.z_index as i64, expected["zIndex"].as_i64().unwrap());
        assert_eq!(frame.order, expected["order"].as_u64().unwrap() as usize);
        assert!(frame.clip.is_none());
    }
}
