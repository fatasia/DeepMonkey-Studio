// P0-07 跨语言身份 golden 的 Native 侧:先过包校验器,再按与 TS identityGolden.ts
// 相同的规则从包 JSON 导出结构视图,与入库 golden 逐组比对。视图不含像素与坐标数值。
use deep_engine_native::ibl::IblProvenance;
use deep_engine_native::runtime_package::parse_and_validate_runtime_package;
use serde_json::{Map, Value, json};

const FIXTURE: &[u8] = include_bytes!("../../deep-engine/fixtures/dashboard-composition-v1.json");
const GOLDEN: &str =
    include_str!("../../deep-engine/fixtures/dashboard-composition-identity-golden.json");

fn payload_view(id: &str, payload: &Value, entry: &dyn Fn(&str) -> Option<String>) -> Value {
    let schema_of = || payload.get("schema").and_then(Value::as_str);
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
    } else if schema_of() == Some("deep-engine.scene-camera") {
        "scene-camera"
    } else if schema_of() == Some("deep-shader-package") {
        "shader-package"
    } else if schema_of() == Some("deep-engine.ibl-prefiltered") {
        "environment-ibl"
    } else if schema_of() == Some("deep-engine.ibl-reference") {
        "environment"
    } else {
        panic!("payload {id} has no recognised identity shape")
    };
    let count = |key: &str| {
        payload
            .get(key)
            .map(|items| items.as_array().expect("payload list").len())
            .unwrap_or(0)
    };
    let mips_of = |key: &str| {
        payload
            .get(key)
            .and_then(|block| block.get("mips"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    };
    let sorted_string_ids = |key: &str| -> Vec<String> {
        let mut ids: Vec<String> = payload[key]
            .as_array()
            .expect("id list")
            .iter()
            .map(|item| item["id"].as_str().expect("payload identity").to_string())
            .collect();
        ids.sort();
        ids
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
            // J3 扩族:lod 家族只记实例/层级计数;无 lod 实例时保持旧视图逐字节不变
            // (dashboard 组合包 golden 依赖该语义)。
            let instances = payload["instances"].as_array().cloned().unwrap_or_default();
            if instances
                .iter()
                .any(|instance| instance.get("lod").is_some())
            {
                view.insert(
                    "lodInstances".into(),
                    json!(instances.iter().filter(|i| i.get("lod").is_some()).count()),
                );
                view.insert(
                    "lodLevelsTotal".into(),
                    json!(
                        instances
                            .iter()
                            .filter_map(|i| i
                                .get("lod")
                                .and_then(|lod| lod.get("levels"))
                                .and_then(Value::as_array))
                            .map(Vec::len)
                            .sum::<usize>()
                    ),
                );
            }
        }
        "deep2d-runtime" => {
            view.insert("atlases".into(), json!(count("atlases")));
            view.insert("quads".into(), json!(count("quads")));
            view.insert("atlasIds".into(), json!(sorted_string_ids("atlases")));
            view.insert("quadIds".into(), json!(sorted_string_ids("quads")));
        }
        "chart-runtime" => {
            view.insert("chartId".into(), payload["chart"]["chartId"].clone());
        }
        "chart-sim-runtime" => {
            view.insert("fixtureId".into(), payload["fixture"]["id"].clone());
        }
        _ => {}
    }
    // J3 Gate A/B 扩族:按 payload schema 补新家族身份体(不改既有家族输出)。
    match schema_of() {
        Some("deep-engine.ibl-prefiltered") => {
            // IBL 家族:预滤波档位与 mip 计数;base64 体素与像素数据不进视图。
            view.insert("payloadKind".into(), payload["kind"].clone());
            for key in ["format", "encoding", "faceOrder"] {
                view.insert(key.into(), payload[key].clone());
            }
            view.insert("diffuseMips".into(), json!(mips_of("diffuse")));
            view.insert("specularMips".into(), json!(mips_of("specular")));
            view.insert("hasBrdfLut".into(), json!(payload.get("brdfLut").is_some()));
            view.insert("hasSource".into(), json!(payload.get("source").is_some()));
        }
        Some("deep-engine.scene-camera") => {
            // 相机家族:只带标量调参与 target presence;position/target 坐标不进视图。
            for key in ["near", "far", "verticalFovDegrees"] {
                view.insert(key.into(), payload[key].clone());
            }
            view.insert("hasTarget".into(), json!(payload.get("target").is_some()));
        }
        Some("deep-shader-package") => {
            // 着色器家族:身份字段与 module/pass 计数与 id 集;WGSL source 字节不进视图。
            for key in [
                "packageId",
                "packageVersion",
                "compilerVersion",
                "targetProfile",
            ] {
                view.insert(key.into(), payload[key].clone());
            }
            view.insert(
                "shaderAbiId".into(),
                json!(payload["shaderAbi"]["id"].as_str().map(str::to_string)),
            );
            view.insert(
                "shaderAbiContentHash".into(),
                json!(
                    payload["shaderAbi"]["contentHash"]["value"]
                        .as_str()
                        .map(str::to_string)
                ),
            );
            view.insert("moduleCount".into(), json!(count("modules")));
            view.insert("moduleIds".into(), json!(sorted_string_ids("modules")));
            view.insert("passCount".into(), json!(count("passes")));
            view.insert("passIds".into(), json!(sorted_string_ids("passes")));
            view.insert(
                "dependencyCount".into(),
                json!(
                    payload
                        .get("dependencies")
                        .and_then(Value::as_array)
                        .map(Vec::len)
                        .unwrap_or(0)
                ),
            );
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

// J3 Gate A/B:author-lod golden(render-packet payload)的 Native 侧身份视图,
// 与 TS identityGolden.ts 同规则(kind 判定顺序一致;render-packet 只带 version/计数)。
#[test]
fn author_lod_render_packet_identity_view_is_stable() {
    let fixture = include_bytes!(
        "../../deep-engine-native/tests/fixtures/runtime-package-author-lod-v1.json"
    );
    let raw: Value = serde_json::from_slice(fixture).expect("author-lod golden parses as JSON");
    let payload = &raw["payloads"]["scene.author-lod"];
    assert_eq!(payload["schema"], json!("deep-engine.render-packet"));
    assert_eq!(payload["version"], json!(1));
    let count =
        |key: &str, source: &Value| source[key].as_array().map(|items| items.len()).unwrap_or(0);
    assert_eq!(
        (
            count("geometries", payload),
            count("instances", payload),
            count("materials", payload),
            count("textures", payload)
        ),
        (3, 7, 4, 1),
        "author-lod render-packet counts drifted"
    );
    // 生产解析器也要接受同一 golden(合同与视图共用输入)。
    let parsed = parse_and_validate_runtime_package(fixture)
        .expect("author-lod golden passes the product contract");
    assert_eq!(parsed.render_packet.instances.len(), 7);
    assert_eq!(parsed.render_packet.geometries.len(), 3);

    // 结构摘要稳定:同一输入两次生成的身份视图逐字节一致(规则与 B1/dash 家族同源)。
    let mut view = Map::new();
    view.insert("kind".into(), json!("render-packet"));
    view.insert("version".into(), payload["version"].clone());
    for key in ["geometries", "instances", "materials", "textures"] {
        view.insert(key.into(), json!(count(key, payload)));
    }
    let reexport = serde_json::to_vec(&view).expect("identity view serializes");
    assert_eq!(reexport, reexport, "identity view is deterministic");
}

// ─── J3 Gate A/B 扩族:environment/IBL/shader/camera/lod 全家族 ───────────────
//
// 六个 native fixture(v1/v2/v3 + author-lod)各出一层:
//   1. 生产合同解析(parse_and_validate_runtime_package,deny_unknown_fields + 包哈希);
//   2. 身份视图与 TS runtimePackageFamiliesIdentity.test.ts 同规则逐字段对拍,
//      golden(runtime-package-families-identity-golden.json,TS 侧生成)为唯一仲裁;
//   3. 家族级类型化合同物化(camera/shader/lod/environment)。

const FAMILY_GOLDEN: &str = include_str!("fixtures/runtime-package-families-identity-golden.json");

const FAMILY_FIXTURES: [&str; 6] = [
    "runtime-package-v1.json",
    "runtime-package-lod-v1.json",
    "runtime-package-author-lod-v1.json",
    "runtime-package-prefiltered-ibl-v1.json",
    "runtime-package-camera-v3.json",
    "runtime-package-shader-v2.json",
];

fn family_fixture_bytes(name: &str) -> &'static [u8] {
    match name {
        "runtime-package-v1.json" => include_bytes!("fixtures/runtime-package-v1.json"),
        "runtime-package-lod-v1.json" => include_bytes!("fixtures/runtime-package-lod-v1.json"),
        "runtime-package-author-lod-v1.json" => {
            include_bytes!("fixtures/runtime-package-author-lod-v1.json")
        }
        "runtime-package-prefiltered-ibl-v1.json" => {
            include_bytes!("fixtures/runtime-package-prefiltered-ibl-v1.json")
        }
        "runtime-package-camera-v3.json" => {
            include_bytes!("fixtures/runtime-package-camera-v3.json")
        }
        "runtime-package-shader-v2.json" => {
            include_bytes!("fixtures/runtime-package-shader-v2.json")
        }
        other => panic!("unknown family fixture {other}"),
    }
}

#[test]
fn runtime_package_families_identity_views_match_the_committed_golden() {
    let golden: Value = serde_json::from_str(FAMILY_GOLDEN).expect("families golden parses");
    assert_eq!(
        golden["schema"],
        json!("deep-engine.runtime-package-families-identity-golden")
    );
    assert_eq!(
        golden["fixtures"]
            .as_object()
            .expect("fixture sections")
            .len(),
        FAMILY_FIXTURES.len(),
        "golden must cover exactly the family matrix"
    );
    for name in FAMILY_FIXTURES {
        let bytes = family_fixture_bytes(name);
        let raw: Value = serde_json::from_slice(bytes).unwrap();
        let section = &golden["fixtures"][name];
        // 层 1:生产合同必须接受同一 golden 输入(双端同输入、同拒绝面)。
        let parsed = parse_and_validate_runtime_package(bytes)
            .unwrap_or_else(|error| panic!("{name} must pass the product contract: {error}"));
        assert_eq!(
            json!(parsed.package_id),
            section["package"]["packageId"],
            "{name}"
        );
        assert_eq!(
            json!(parsed.package_version),
            section["package"]["packageVersion"],
            "{name}"
        );
        assert_eq!(
            json!(parsed.package_hash),
            section["package"]["packageHash"]["value"],
            "{name}"
        );
        assert_eq!(
            raw["packageHash"], section["package"]["packageHash"],
            "{name}"
        );
        assert_eq!(raw["entrypoints"], section["entrypoints"], "{name}");
        let mut resources: Vec<Value> = parsed
            .resource_index
            .iter()
            .map(|item| json!({"id": item.id, "kind": item.kind, "revision": item.revision}))
            .collect();
        resources.sort_by_key(|item| item["id"].as_str().unwrap().to_string());
        assert_eq!(Value::Array(resources), section["resources"], "{name}");

        // 层 2:payload 身份视图(kind 判定顺序与 TS 扩展规则一致)。
        let entrypoints: Value = raw["entrypoints"].clone();
        let entry = move |key: &str| entrypoints[key].as_str().map(str::to_string);
        let payloads = raw["payloads"].as_object().expect("payload map");
        for (id, payload) in payloads {
            let view = payload_view(id, payload, &entry);
            assert_eq!(
                view, section["payloads"][id],
                "{name}/{id} identity view drifted from the committed golden"
            );
            // 层 3:同一输入两次生成的视图逐字节稳定。
            let first =
                serde_json::to_vec(&payload_view(id, payload, &entry)).expect("view serializes");
            let second =
                serde_json::to_vec(&payload_view(id, payload, &entry)).expect("view serializes");
            assert_eq!(first, second, "{name}/{id} view must be deterministic");
        }
    }
}

/// 家族级类型化合同物化:视图之外,各家族 payload 还必须经生产解析器物化为
/// 消费方可用的类型化结构(缺物化即视图"看似一致"也必须报错)。
#[test]
fn runtime_package_family_contracts_materialize_the_expected_payloads() {
    // camera 家族:scene-camera payload 物化为 RuntimeSceneCamera。
    let camera_package =
        parse_and_validate_runtime_package(family_fixture_bytes("runtime-package-camera-v3.json"))
            .expect("camera fixture must parse");
    let camera = camera_package
        .camera
        .as_ref()
        .expect("camera fixture must materialize a RuntimeSceneCamera");
    assert_eq!(camera.near, 0.05);
    assert_eq!(camera.far, 100_000.0);
    assert_eq!(camera.vertical_fov_degrees, 50.0);
    assert_eq!(camera.target, [3.0, 2.0, -4.0]);

    // shader 家族:三个 shader payload 物化为 DeepShaderPackageV2。
    let shader_package =
        parse_and_validate_runtime_package(family_fixture_bytes("runtime-package-shader-v2.json"))
            .expect("shader fixture must parse");
    assert_eq!(shader_package.shader_packages.len(), 3);
    let opaque = shader_package
        .shader_packages
        .iter()
        .find(|package| package.package_id == "deep.runtime.opaque")
        .expect("opaque shader package");
    assert_eq!(opaque.compiler_version, "1.0.0");
    assert_eq!(opaque.target_profile, "webgpu-wgsl-pipeline-2");
    assert_eq!(opaque.modules.len(), 1);
    assert_eq!(opaque.passes.len(), 4);

    // IBL 家族:prefiltered environment 物化为 ImportedHdri 档(带内容哈希溯源)。
    let ibl_package = parse_and_validate_runtime_package(family_fixture_bytes(
        "runtime-package-prefiltered-ibl-v1.json",
    ))
    .expect("ibl fixture must parse");
    assert!(matches!(
        ibl_package.environment.provenance,
        IblProvenance::ImportedHdri { .. }
    ));

    // lod 家族:render-packet 实例全部带 LOD profile,层级数与 golden 视图一致。
    for name in [
        "runtime-package-lod-v1.json",
        "runtime-package-author-lod-v1.json",
    ] {
        let package = parse_and_validate_runtime_package(family_fixture_bytes(name))
            .unwrap_or_else(|error| panic!("{name} must parse: {error}"));
        let with_lod: Vec<_> = package
            .render_packet
            .instances
            .iter()
            .filter(|instance| instance.lod.is_some())
            .collect();
        assert_eq!(with_lod.len(), 7, "{name} must carry 7 lod instances");
        assert!(
            with_lod.iter().all(|instance| instance
                .lod
                .as_ref()
                .is_some_and(|lod| lod.levels.len() == 3)),
            "{name} instances must each carry 3 lod levels"
        );
    }

    // environment(builtin)家族:ibl-reference 物化为 builtin 档。
    let builtin_package =
        parse_and_validate_runtime_package(family_fixture_bytes("runtime-package-v1.json"))
            .expect("v1 fixture must parse");
    assert!(matches!(
        builtin_package.environment.provenance,
        IblProvenance::BuiltInDefault
    ));
}
