use deep_engine_native::runtime_package::{
    RuntimeResourceKind, RuntimeResourcePlanAction, parse_and_validate_runtime_package,
    plan_runtime_package_diff, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

fn resign(value: &mut Value) {
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).unwrap());
}
fn fixture() -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("fixtures/runtime-package-v1.json")).unwrap();
    let camera: Value = serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/runtime-camera-v1.json"
    ))
    .unwrap();
    value["schemaVersion"] = json!(3);
    value["materialBindings"] = json!([]);
    value["entrypoints"]["camera"] = json!("scene.camera");
    value["payloads"]["scene.camera"] = camera.clone();
    let entries = value["resources"].as_array_mut().unwrap();
    entries.push(
        json!({"id":"scene.camera", "kind":"scene-camera", "revision":1,
        "contentHash":{"algorithm":"sha256","value":runtime_content_sha256(&camera)}}),
    );
    entries.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    resign(&mut value);
    value
}
fn load(
    value: &Value,
) -> Result<deep_engine_native::runtime_package::LoadedRuntimePackage, String> {
    parse_and_validate_runtime_package(&serde_json::to_vec(value).unwrap())
        .map_err(|e| e.to_string())
}
#[test]
fn consumes_actual_typescript_builder_v3_output() {
    let loaded = parse_and_validate_runtime_package(include_bytes!(
        "fixtures/runtime-package-camera-v3.json"
    ))
    .unwrap();
    let view =
        deep_engine_native::player_view::PlayerView::from_camera(loaded.camera.as_ref().unwrap())
            .unwrap();
    assert_eq!(view.target, [3.0, 2.0, -4.0]);
    assert_eq!(view.far, 100000.0);
    for (actual, expected) in view.eye().iter().zip([12.0, 8.0, 16.0]) {
        assert!((actual - expected).abs() < 0.00001);
    }
}

#[test]
fn camera_is_loaded_and_camera_only_change_replaces_one_resource() {
    let first = fixture();
    let old = load(&first).unwrap();
    assert_eq!(old.camera.as_ref().unwrap().position, [12.0, 8.0, 16.0]);
    let mut next = first.clone();
    next["payloads"]["scene.camera"]["position"][0] = json!(13);
    next["payloads"]["scene.camera"]["revision"] = json!(2);
    let hash = runtime_content_sha256(&next["payloads"]["scene.camera"]);
    for entry in next["resources"].as_array_mut().unwrap() {
        if entry["id"] == "scene.camera" {
            entry["revision"] = json!(2);
            entry["contentHash"]["value"] = json!(hash);
        }
    }
    resign(&mut next);
    let new = load(&next).unwrap();
    let diff = plan_runtime_package_diff(&old, &new).unwrap();
    assert_eq!(diff.entries.len(), 1);
    assert_eq!(diff.entries[0].kind, RuntimeResourceKind::SceneCamera);
    assert_eq!(diff.entries[0].action, RuntimeResourcePlanAction::Replace);
    assert_eq!(diff.reused, old.resource_index.len() - 1);
}
#[test]
fn invalid_camera_roles_identity_and_downgrades_are_rejected_after_rehash() {
    for case in 0..8 {
        let mut value = fixture();
        match case {
            0 => {
                value["entrypoints"]
                    .as_object_mut()
                    .unwrap()
                    .remove("camera");
            }
            1 => value["entrypoints"]["camera"] = Value::Null,
            2 => value["entrypoints"]["camera"] = json!("scene.main"),
            3 => value["schemaVersion"] = json!(2),
            4 => {
                value.as_object_mut().unwrap().remove("materialBindings");
            }
            5 => value["payloads"]["scene.camera"]["revision"] = json!(3),
            6 => value["payloads"]["scene.camera"]["id"] = json!("other"),
            _ => value["payloads"]["scene.camera"]["far"] = json!(0.01),
        }
        let hash = runtime_content_sha256(&value["payloads"]["scene.camera"]);
        for entry in value["resources"].as_array_mut().unwrap() {
            if entry["id"] == "scene.camera" {
                entry["contentHash"]["value"] = json!(hash);
            }
        }
        resign(&mut value);
        assert!(load(&value).is_err(), "accepted case {case}");
    }
}
