use std::{collections::BTreeMap, path::PathBuf};

use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Map, Value, json};

fn fixture(path: &str) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(root.join(path)).expect("fixture")).expect("fixture JSON")
}

fn browser_packet() -> Value {
    let mut packet = fixture("fixtures/render_packet_v1.json");
    let root = packet.as_object_mut().expect("packet");
    root.remove("schema");
    root.remove("version");
    let material = root["materials"][0].as_object_mut().expect("material");
    material.insert("emissiveFactor".into(), json!([0.25, 0.5, 0.75]));
    material.insert("emissiveStrength".into(), json!(4.0));
    for field in ["vertices", "indices"] {
        let source = root["geometries"][0][field]
            .as_array()
            .expect("array")
            .clone();
        root["geometries"][0][field] = Value::Object(
            source
                .into_iter()
                .enumerate()
                .map(|(index, value)| (index.to_string(), value))
                .collect(),
        );
    }
    packet
}

fn package() -> Value {
    let payloads = BTreeMap::from([
        (
            "deep.fixture.pbr",
            fixture("tests/fixtures/deep_shader_package_v2.json"),
        ),
        (
            "deep.builtin.studio-ibl.v1",
            json!({
                "schema": "deep-engine.ibl-reference", "schemaVersion": 1,
                "id": "deep.builtin.studio-ibl.v1", "revision": 1, "kind": "builtin-default"
            }),
        ),
        (
            "native:deep2d:atlas-smoke",
            fixture("fixtures/deep2d_runtime_atlas_v1.json"),
        ),
        ("scene.main", browser_packet()),
    ]);
    let kinds = BTreeMap::from([
        ("deep.fixture.pbr", "shader-package"),
        ("deep.builtin.studio-ibl.v1", "ibl-environment"),
        ("native:deep2d:atlas-smoke", "deep2d-runtime"),
        ("scene.main", "render-packet"),
    ]);
    let resources: Vec<_> = payloads
        .iter()
        .map(|(id, payload)| {
            json!({
                "id": id, "kind": kinds[id], "revision": 1,
                "contentHash": { "algorithm": "sha256", "value": runtime_content_sha256(payload) }
            })
        })
        .collect();
    let payloads: Map<String, Value> = payloads
        .into_iter()
        .map(|(id, payload)| (id.to_string(), payload))
        .collect();
    let mut value = json!({
        "schema": "deep-engine.runtime-package", "schemaVersion": 1,
        "packageId": "deep.fixture.runtime", "packageVersion": "1.0.0",
        "entrypoints": {
            "renderPacket": "scene.main", "deep2d": "native:deep2d:atlas-smoke",
            "environment": "deep.builtin.studio-ibl.v1", "shaderPackages": ["deep.fixture.pbr"]
        },
        "resources": resources, "payloads": payloads,
        "packageHash": { "algorithm": "sha256", "value": "0".repeat(64) }
    });
    reseal_package(&mut value);
    value
}

fn reseal_package(value: &mut Value) {
    value["packageHash"]["value"] =
        json!(runtime_package_sha256(value).expect("runtime package hash"));
}

fn reseal_resource(value: &mut Value, id: &str) {
    let hash = runtime_content_sha256(&value["payloads"][id]);
    let resource = value["resources"]
        .as_array_mut()
        .expect("resources")
        .iter_mut()
        .find(|resource| resource["id"] == id)
        .expect("resource");
    resource["contentHash"]["value"] = json!(hash);
    reseal_package(value);
}

fn parse(
    value: &Value,
) -> Result<deep_engine_native::runtime_package::LoadedRuntimePackage, String> {
    parse_and_validate_runtime_package(&serde_json::to_vec(value).expect("serialize"))
        .map_err(|error| error.to_string())
}

#[test]
fn consumes_one_editor_runtime_package_through_every_existing_contract() {
    let loaded = parse(&package()).expect("valid unified runtime package");
    let summary = loaded.summary();
    assert_eq!(loaded.package_id, "deep.fixture.runtime");
    assert_eq!(summary.resources, 4);
    assert_eq!(summary.instances, 4);
    assert!(summary.has_deep2d);
    assert_eq!(summary.shader_packages, 1);
    assert_eq!(loaded.environment.id, "deep.builtin.studio-ibl.v1");
    assert_eq!(loaded.render_packet.schema, "deep-engine.render-packet");
    assert_eq!(
        loaded.render_packet.materials[0].emissive_factor,
        Some([1.0, 2.0, 3.0])
    );
}

#[test]
fn rejects_envelope_index_payload_and_entrypoint_tampering() {
    let mut hash = package();
    hash["packageId"] = json!("deep.changed");
    assert!(
        parse(&hash)
            .expect_err("package hash")
            .contains("package hash mismatch")
    );

    let mut content = package();
    content["payloads"]["scene.main"]["instances"][0]["id"] = json!("changed");
    reseal_package(&mut content);
    assert!(
        parse(&content)
            .expect_err("content hash")
            .contains("content hash mismatch")
    );

    let mut order = package();
    order["resources"]
        .as_array_mut()
        .expect("resources")
        .swap(0, 1);
    reseal_package(&mut order);
    assert!(
        parse(&order)
            .expect_err("order")
            .contains("sorted by unique id")
    );

    let mut kind = package();
    kind["entrypoints"]["renderPacket"] = json!("deep.builtin.studio-ibl.v1");
    reseal_package(&mut kind);
    assert!(
        parse(&kind)
            .expect_err("kind")
            .contains("wrong resource kind")
    );
}

#[test]
fn rejects_unknown_fields_missing_required_roles_and_nested_identity_drift() {
    let mut unknown = package();
    unknown["unexpected"] = json!(true);
    reseal_package(&mut unknown);
    assert!(
        parse(&unknown)
            .expect_err("unknown")
            .contains("unknown field")
    );

    let mut missing = package();
    missing["entrypoints"]
        .as_object_mut()
        .expect("entrypoints")
        .remove("deep2d");
    reseal_package(&mut missing);
    assert!(
        parse(&missing)
            .expect_err("required null")
            .contains("missing field")
    );

    let mut identity = package();
    let deep2d = identity["resources"]
        .as_array_mut()
        .expect("resources")
        .iter_mut()
        .find(|resource| resource["id"] == "native:deep2d:atlas-smoke")
        .expect("deep2d");
    deep2d["revision"] = json!(2);
    reseal_package(&mut identity);
    assert!(
        parse(&identity)
            .expect_err("identity")
            .contains("identity differs")
    );
}

#[test]
fn validates_browser_lod_profiles_through_the_native_contract() {
    let mut value = package();
    let packet = &mut value["payloads"]["scene.main"];
    packet["instances"][0]["lod"] = json!({
        "levels": [
            { "geometry": packet["instances"][0]["geometry"], "minProjectedDiameterPixels": 180, "geometricError": 0 },
            { "geometry": packet["geometries"][1]["id"], "minProjectedDiameterPixels": 0, "geometricError": 1 }
        ]
    });
    reseal_resource(&mut value, "scene.main");
    let loaded = parse(&value).expect("valid browser LOD");
    assert_eq!(
        loaded.render_packet.instances[0]
            .lod
            .as_ref()
            .unwrap()
            .levels
            .len(),
        2
    );

    value["payloads"]["scene.main"]["instances"][0]["lod"]["levels"]
        .as_array_mut()
        .unwrap()
        .pop();
    reseal_resource(&mut value, "scene.main");
    assert!(
        parse(&value)
            .expect_err("LOD")
            .contains("must have 2-8 levels")
    );
}
