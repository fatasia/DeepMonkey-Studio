//! Shader fixture 沿用生产解析/哈希算法，不另造缓存身份规则。
use deep_engine_native::shader_package::*;
use serde_json::{Value, json};

#[path = "../shader_package/hash.rs"]
mod hash;
#[path = "../shader_package/pipeline.rs"]
mod pipeline;

#[derive(Debug)]
struct ShaderPackageError(String);
fn fail<T>(message: impl Into<String>) -> Result<T, ShaderPackageError> {
    Err(ShaderPackageError(message.into()))
}

pub(super) fn dim_color(payload: &mut Value, revision: u64) {
    payload["packageVersion"] = json!(format!("0.2.{revision}"));
    let module = &mut payload["modules"][0];
    let previous_id = module["id"].clone();
    let original = module["source"].as_str().unwrap();
    let expression = "let n_baseColor: vec3f = n_colorMetal.rgb * deepBaseColorSample.rgb;";
    assert!(original.contains(expression));
    let source = original.replace(
        expression,
        &format!(
            "let n_baseColor: vec3f = n_colorMetal.rgb * deepBaseColorSample.rgb * {};",
            1.0 / (revision + 1) as f64,
        ),
    );
    module["sourceHash"]["value"] = json!(hash::sha256(source.as_bytes()));
    module["source"] = json!(source);
    let identity = json!({"sourceHash": module["sourceHash"]["value"], "dependencyIds": module["dependencyIds"]});
    let id = json!(format!("module.{}", hash::hash_canonical(&identity)));
    module["id"] = id.clone();
    for pass in payload["passes"].as_array_mut().unwrap() {
        if pass["moduleId"] == previous_id {
            pass["moduleId"] = id.clone();
        }
    }
    payload["modules"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let package: DeepShaderPackageV2 = serde_json::from_value(payload.clone()).unwrap();
    for (index, pass) in package.passes.iter().enumerate() {
        let module = package
            .modules
            .iter()
            .find(|module| module.id == pass.module_id)
            .unwrap();
        let execution = pipeline::resolve(&package.shader_abi.contract, pass)
            .map_err(|e| e.0)
            .unwrap();
        payload["passes"][index]["cacheKey"] = json!(
            pipeline::expected_cache_key(&package, pass, module, &execution)
                .map_err(|e| e.0)
                .unwrap()
        );
    }
    payload.as_object_mut().unwrap().remove("packageCacheKey");
    payload["packageCacheKey"] = json!(hash::hash_canonical(payload));
    parse_and_validate_shader_package(&serde_json::to_vec(payload).unwrap()).unwrap();
}
