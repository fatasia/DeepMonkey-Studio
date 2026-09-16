use deep_engine_native::runtime_camera::RuntimeSceneCamera;
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../deep-engine/fixtures/runtime-camera-v1.json"
    ))
    .unwrap()
}

#[test]
fn shared_typescript_fixture_validates() {
    let camera: RuntimeSceneCamera = serde_json::from_value(fixture()).unwrap();
    camera.validate().unwrap();
    assert_eq!(camera.vertical_fov_degrees, 50.0);
    assert_eq!(camera.far, 100_000.0);
}

#[test]
fn malformed_identity_projection_and_coordinates_are_rejected() {
    for (key, value) in [
        ("schemaVersion", json!(2)),
        ("id", json!("A")),
        ("revision", json!(0)),
        ("revision", json!(1.5)),
        ("position", json!([1, 2])),
        ("position", json!([1e8, 0, 0])),
        ("target", json!([12, 8, 16])),
        ("verticalFovDegrees", json!(0)),
        ("verticalFovDegrees", json!(180)),
        ("near", json!(0)),
        ("far", json!(0.04)),
        ("far", json!(1e7)),
        ("unknown", json!(1)),
    ] {
        let mut value_fixture = fixture();
        value_fixture[key] = value;
        let result = serde_json::from_value::<RuntimeSceneCamera>(value_fixture)
            .map_err(|e| e.to_string())
            .and_then(|c| c.validate());
        assert!(result.is_err(), "accepted invalid {key}");
    }
    let mut camera: RuntimeSceneCamera = serde_json::from_value(fixture()).unwrap();
    camera.position = [1e7, 0.0, 0.0];
    camera.target = [1e7 - 0.01, 0.0, 0.0];
    assert!(camera.validate().is_err());
    camera.position[0] = f64::NAN;
    assert!(camera.validate().is_err());
}
