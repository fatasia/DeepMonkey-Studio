// P0-07 跨语言身份 golden 的 Native 侧:先过包校验器,再按与 TS identityGolden.ts
// 相同的规则从包 JSON 导出结构视图,与入库 golden 逐组比对。视图不含像素与坐标数值。
use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use serde_json::{Map, Value, json};

const FIXTURE: &[u8] = include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json");
const GOLDEN: &str =
    include_str!("../../deep-engine/fixtures/dashboard-composition-identity-golden.json");

fn sorted_ids(items: &Value) -> Vec<String> {
    let mut ids: Vec<String> = items
        .as_array()
        .expect("payload list")
        .iter()
        .map(|item| item["id"].as_str().expect("payload identity").to_string())
        .collect();
    ids.sort();
    ids
}

fn payload_view(id: &str, payload: &Value, entry: &dyn Fn(&str) -> Option<String>) -> Value {
    let kind = if Some(id) == entry("dashboard").as_deref() {
        "dashboard-runtime"
    } else if Some(id) == entry("renderPacket").as_deref() {
        "render-packet"
    } else if Some(id) == entry("environment").as_deref() {
        "environment"
    } else if payload.get("chart").is_some() {
        "chart-runtime"
    } else if payload.get("fixture").is_some() {
        "chart-sim-runtime"
    } else if payload.get("atlases").is_some() {
        "deep2d-runtime"
    } else {
        panic!("payload {id} has no recognised identity shape")
    };
    let count = |key: &str| {
        payload
            .get(key)
            .map(|items| items.as_array().expect("payload list").len())
            .unwrap_or(0)
    };
    // TS 侧 base 对象里值为 undefined 的键会被 JSON.stringify 省略;这里保持同一语义,
    // 只插入 payload 中实际存在的身份键,否则组合包的 render-packet(无 revision)会漂移。
    let mut view = Map::new();
    view.insert("kind".into(), json!(kind));
    for key in ["revision", "schema", "schemaVersion"] {
        if let Some(value) = payload.get(key) {
            view.insert(key.into(), value.clone());
        }
    }
    match kind {
        "dashboard-runtime" => {
            view.insert("documentId".into(), payload["documentId"].clone());
            view.insert("entryPageId".into(), payload["entryPageId"].clone());
            view.insert("pages".into(), json!(count("pages")));
        }
        "render-packet" => {
            view.insert("version".into(), payload["version"].clone());
            for key in ["geometries", "instances", "materials", "textures"] {
                view.insert(key.into(), json!(count(key)));
            }
        }
        "deep2d-runtime" => {
            view.insert("atlases".into(), json!(count("atlases")));
            view.insert("quads".into(), json!(count("quads")));
            view.insert("atlasIds".into(), json!(sorted_ids(&payload["atlases"])));
            view.insert("quadIds".into(), json!(sorted_ids(&payload["quads"])));
        }
        "chart-runtime" => {
            view.insert("chartId".into(), payload["chart"]["chartId"].clone());
        }
        "chart-sim-runtime" => {
            view.insert("fixtureId".into(), payload["fixture"]["id"].clone());
        }
        _ => {}
    }
    Value::Object(view)
}

fn golden_entry(golden: &Value) -> impl Fn(&str) -> Option<String> + '_ {
    move |key: &str| golden["entrypoints"][key].as_str().map(str::to_string)
}

#[test]
fn native_parser_sees_the_same_identity_view_as_the_committed_golden() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    // 层 1:包必须先通过完整校验器,身份字段与 golden 一致。
    let package =
        parse_and_validate_runtime_package(FIXTURE).expect("composition fixture must validate");
    assert_eq!(package.package_id, golden["package"]["packageId"]);
    assert_eq!(package.package_version, golden["package"]["packageVersion"]);
    assert_eq!(
        package.package_hash,
        golden["package"]["packageHash"]["value"]
    );
    let envelope: Value = serde_json::from_slice(FIXTURE).unwrap();
    assert_eq!(envelope["packageHash"], golden["package"]["packageHash"]);
    assert_eq!(envelope["entrypoints"], golden["entrypoints"]);
    let mut resources: Vec<Value> = package
        .resource_index
        .iter()
        .map(|item| json!({"id": item.id, "kind": item.kind, "revision": item.revision}))
        .collect();
    resources.sort_by_key(|item| item["id"].as_str().unwrap().to_string());
    assert_eq!(Value::Array(resources), golden["resources"]);

    // 层 2:payload 结构视图,kind 判定顺序与 TS identityGolden.ts 完全一致。
    let entry = golden_entry(&golden);
    let mut view = Map::new();
    for (id, payload) in envelope["payloads"].as_object().expect("payload map") {
        view.insert(id.clone(), payload_view(id, payload, &entry));
    }
    assert_eq!(Value::Object(view), golden["payloads"]);
}

#[test]
fn tampering_any_payload_identity_breaks_the_golden_view() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut tampered: Value = serde_json::from_slice(FIXTURE).unwrap();
    let entry = golden_entry(&golden);
    let dashboard = golden["entrypoints"]["dashboard"]
        .as_str()
        .expect("dashboard entrypoint")
        .to_string();
    tampered["payloads"][&dashboard]["revision"] = json!(99);
    let mut view = Map::new();
    for (id, payload) in tampered["payloads"].as_object().expect("payload map") {
        view.insert(id.clone(), payload_view(id, payload, &entry));
    }
    assert_ne!(Value::Object(view), golden["payloads"]);
}
