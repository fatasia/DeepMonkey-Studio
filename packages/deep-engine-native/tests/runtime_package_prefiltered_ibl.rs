use deep_engine_native::{
    ibl::IblProvenance,
    runtime_package::{
        parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
    },
};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "fixtures/runtime-package-prefiltered-ibl-v1.json"
    ))
    .unwrap()
}
fn mutate(
    edit: impl FnOnce(&mut Value),
) -> Result<deep_engine_native::runtime_package::LoadedRuntimePackage, String> {
    let mut package = fixture();
    let id = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    edit(&mut package["payloads"][&id]);
    let hash = runtime_content_sha256(&package["payloads"][&id]);
    for resource in package["resources"].as_array_mut().unwrap() {
        if resource["id"] == id {
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    package["packageHash"]["value"] = json!(runtime_package_sha256(&package).unwrap());
    parse_and_validate_runtime_package(&serde_json::to_vec(&package).unwrap())
        .map_err(|e| e.to_string())
}

#[test]
fn shared_prefiltered_fixture_uses_payload_identity_and_decodes_half() {
    let p = fixture();
    let loaded = parse_and_validate_runtime_package(&serde_json::to_vec(&p).unwrap()).unwrap();
    let id = p["entrypoints"]["environment"].as_str().unwrap();
    assert_eq!(
        loaded.environment.provenance,
        IblProvenance::ImportedHdri {
            content_hash: runtime_content_sha256(&p["payloads"][id]),
        }
    );
    assert!(
        loaded
            .environment
            .specular
            .mips
            .iter()
            .flat_map(|m| &m.texels)
            .flatten()
            .all(|v| v.is_finite() && *v >= 0.)
    );
    assert!(mutate(|v| v["schemaVersion"] = json!(1.0)).is_ok());
    assert!(mutate(|v| v["brdfLut"]["width"] = json!(1.0)).is_ok());
}

#[test]
fn prefiltered_rejects_identity_shape_source_and_unknown_fields() {
    for (pointer, value) in [
        ("/schemaVersion", json!(2)),
        ("/revision", json!(0)),
        ("/format", json!("rgba32float")),
        ("/encoding", json!("base64")),
        ("/faceOrder", json!("other")),
        ("/source/license", json!("")),
        ("/source/license", json!("a".repeat(257))),
        ("/source/contentHash/value", json!("A".repeat(64))),
        ("/brdfLut/height", json!(2)),
        ("/specular/mips/0/size", json!(3)),
        ("/specular/mips/0/size", json!(0)),
        ("/diffuse/mips/0/size", json!(1.5)),
        ("/brdfLut/dataBase64", json!("AAAA")),
    ] {
        assert!(
            mutate(|v| *v.pointer_mut(pointer).unwrap() = value).is_err(),
            "{pointer}"
        );
    }
    assert!(mutate(|v| v["source"]["url"] = json!("file:///ignored")).is_err());
    assert!(
        mutate(|v| {
            let m = v["specular"]["mips"][0].clone();
            v["specular"]["mips"].as_array_mut().unwrap().push(m);
        })
        .is_err()
    );
    assert!(mutate(|v| v["diffuse"]["mips"] = json!([])).is_err());
}

#[test]
fn prefiltered_budget_precedes_all_encoded_byte_scans() {
    let error = mutate(|v| {
        v["specular"]["mips"] = json!([{ "size": 1, "dataBase64": "invalid" }]);
        v["diffuse"]["mips"] = json!([{ "size": 2048, "dataBase64": "invalid" }]);
    })
    .unwrap_err();
    assert!(error.contains("byte-budget"), "{error}");
}

#[test]
fn prefiltered_half_rejects_nan_infinity_negative_and_accepts_minus_zero() {
    // Four little-endian half channels; only the first channel differs.
    for data in ["AHwAAAAAAAA=", "AH4AAAAAAAA=", "ALwAAAAAAAA="] {
        let error = mutate(|v| v["brdfLut"]["dataBase64"] = json!(data)).unwrap_err();
        assert!(error.contains("invalid-half"), "{error}");
    }
    let loaded = mutate(|v| v["brdfLut"]["dataBase64"] = json!("AIAAAAAAAAA=")).unwrap();
    assert_eq!(loaded.environment.brdf_lut.texels[0], [0.; 4]);
    assert!(mutate(|v| v["brdfLut"]["dataBase64"] = json!("AAAAAAAAAAB=")).is_err());
}
