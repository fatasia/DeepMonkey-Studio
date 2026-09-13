use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/runtime-package-shader-v2.json")).unwrap()
}

fn reseal(value: &mut Value) {
    for entry in value["resources"].as_array().unwrap().clone() {
        let id = entry["id"].as_str().unwrap();
        let hash = runtime_content_sha256(&value["payloads"][id]);
        value["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["id"] == id)
            .unwrap()["contentHash"]["value"] = json!(hash);
    }
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).unwrap());
}

fn parse(
    value: &Value,
) -> Result<deep_engine_native::runtime_package::LoadedRuntimePackage, String> {
    parse_and_validate_runtime_package(&serde_json::to_vec(value).unwrap())
        .map_err(|error| error.to_string())
}

#[test]
fn browser_deepsl_runtime_v2_preserves_executable_materials_and_lod() {
    let loaded = parse(&fixture()).unwrap();
    assert_eq!(
        loaded.package_hash,
        "71c978b477056ee991cd495e2dca809245a4bc81bd81e26432ce7089996ae67c"
    );
    assert_eq!(loaded.shader_packages.len(), 3);
    assert_eq!(loaded.material_bindings.len(), 3);
    assert_eq!(loaded.render_packet.instances.len(), 7);
    assert!(
        loaded
            .render_packet
            .instances
            .iter()
            .all(|instance| instance.lod.is_some())
    );
    assert!(
        loaded
            .shader_packages
            .iter()
            .all(|shader| shader.shader_abi.id == "deep.pbr.mesh.v2")
    );
    let material = loaded
        .render_packet
        .materials
        .iter()
        .find(|value| value.id == "shader.opaque")
        .unwrap();
    assert_eq!(material.emissive_factor, Some([0.07, 0.14, 0.035]));
    assert_eq!(
        material.normal_texture.as_ref().unwrap().normal_scale,
        Some(-0.5)
    );
    assert_eq!(
        material.occlusion_texture.as_ref().unwrap().strength,
        Some(0.6)
    );
    assert_eq!(
        material.base_color_texture.as_ref().unwrap().tex_coord,
        Some(1)
    );
}

#[test]
fn bindings_are_required_in_v2_and_forbidden_in_v1() {
    let mut missing = fixture();
    missing.as_object_mut().unwrap().remove("materialBindings");
    reseal(&mut missing);
    assert!(
        parse(&missing)
            .unwrap_err()
            .contains("required in runtime package v2")
    );
    let mut downgraded = fixture();
    downgraded["schemaVersion"] = json!(1);
    reseal(&mut downgraded);
    assert!(parse(&downgraded).unwrap_err().contains("forbidden in v1"));
    for invalid in [Value::Null, json!([])] {
        let mut value = fixture();
        value["materialBindings"] = invalid;
        reseal(&mut value);
        assert!(parse(&value).is_err());
    }
}

#[test]
fn rehashed_references_cannot_target_absent_material_package_or_technique() {
    for (field, expected) in [
        ("materialId", "absent material"),
        ("packageId", "absent shader"),
        ("techniqueId", "no forward pass"),
    ] {
        let mut value = fixture();
        value["materialBindings"][0][field] = json!("absent");
        reseal(&mut value);
        assert!(parse(&value).unwrap_err().contains(expected), "{field}");
    }
}

#[test]
fn duplicate_unordered_unknown_and_unbound_entries_are_rejected() {
    let mut duplicate = fixture();
    let first = duplicate["materialBindings"][0].clone();
    duplicate["materialBindings"]
        .as_array_mut()
        .unwrap()
        .insert(0, first);
    reseal(&mut duplicate);
    assert!(parse(&duplicate).unwrap_err().contains("unique material"));
    let mut unordered = fixture();
    unordered["materialBindings"]
        .as_array_mut()
        .unwrap()
        .reverse();
    reseal(&mut unordered);
    assert!(parse(&unordered).unwrap_err().contains("sorted"));
    let mut unknown = fixture();
    unknown["materialBindings"][0]["fallback"] = json!(true);
    reseal(&mut unknown);
    assert!(parse(&unknown).unwrap_err().contains("unknown field"));
    let mut unbound = fixture();
    unbound["materialBindings"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    reseal(&mut unbound);
    assert!(
        parse(&unbound)
            .unwrap_err()
            .contains("every shader entrypoint")
    );
}

#[test]
fn binding_changes_participate_in_the_manifest_hash() {
    let mut value = fixture();
    value["materialBindings"][0]["techniqueId"] = json!("other");
    assert!(parse(&value).unwrap_err().contains("hash mismatch"));
}

#[test]
fn utf8_order_accepts_the_same_unicode_scalar_order_as_browser() {
    let mut value = fixture();
    for (old, new) in [("blend.near", "材质-\u{e000}"), ("mask", "材质-\u{10000}")] {
        for binding in value["materialBindings"].as_array_mut().unwrap() {
            if binding["materialId"] == old {
                binding["materialId"] = json!(new);
            }
        }
        let packet = value["payloads"]["scene.lod"].as_object_mut().unwrap();
        for material in packet["materials"].as_array_mut().unwrap() {
            if material["id"] == old {
                material["id"] = json!(new);
            }
        }
        for instance in packet["instances"].as_array_mut().unwrap() {
            if instance["material"] == old {
                instance["material"] = json!(new);
            }
        }
    }
    value["materialBindings"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["materialId"].as_str().cmp(&b["materialId"].as_str()));
    reseal(&mut value);
    let loaded = parse(&value).unwrap();
    assert_eq!(loaded.material_bindings[1].material_id, "材质-\u{e000}");
    assert_eq!(loaded.material_bindings[2].material_id, "材质-\u{10000}");
}

#[test]
fn legacy_package_keeps_empty_executable_bindings() {
    let bytes = include_bytes!("fixtures/runtime-package-v1.json");
    let loaded = parse_and_validate_runtime_package(bytes).unwrap();
    assert!(loaded.material_bindings.is_empty());
    assert_eq!(
        loaded.package_hash,
        "621d7355747b15ded4f0c128d10090ea4d0730a6b50f4df644a10991fb3cdb6a"
    );
}
