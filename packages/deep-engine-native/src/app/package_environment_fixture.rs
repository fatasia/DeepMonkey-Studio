//! A real prefiltered cube payload for combined camera/scene/environment reloads.
use deep_engine_native::runtime_package::runtime_content_sha256;
use serde_json::{Value, json};

pub(super) fn replace_environment(package: &mut Value, revision: u64) {
    let source: Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/runtime-package-prefiltered-ibl-v1.json"
    ))
    .unwrap();
    let id = source["entrypoints"]["environment"].as_str().unwrap();
    let old_id = package["entrypoints"]["environment"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut environment = source["payloads"][id].clone();
    environment["revision"] = json!(revision + 1);
    // 最新代次使用黑色辐照 cube，确认 CPU/GPU 不只更新环境名称。
    if revision == 3 {
        for cube in ["specular", "diffuse"] {
            for mip in environment[cube]["mips"].as_array_mut().unwrap() {
                let bytes = mip["dataBase64"].as_str().unwrap();
                mip["dataBase64"] = json!(
                    bytes
                        .chars()
                        .map(|c| if c == '=' { '=' } else { 'A' })
                        .collect::<String>()
                );
            }
        }
    }
    let hash = runtime_content_sha256(&environment);
    package["payloads"].as_object_mut().unwrap().remove(&old_id);
    package["payloads"][id] = environment;
    package["entrypoints"]["environment"] = json!(id);
    for resource in package["resources"].as_array_mut().unwrap() {
        if resource["id"] == old_id {
            resource["id"] = json!(id);
            resource["revision"] = json!(revision + 1);
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    package["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
}
