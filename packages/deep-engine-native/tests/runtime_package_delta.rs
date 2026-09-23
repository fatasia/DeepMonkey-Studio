//! P3-01 对象级内容寻址 delta 热同步合同测试矩阵。
//!
//! 覆盖:build 与既有 diff.rs 的对拍、apply 产物 == 直接全量 v2 解析、
//! 迟到 delta 幂等跳过、丢包/截断结构化诊断、schema 不兼容、依赖闭包、
//! 以及发布侧封出非法目标时的既有校验兜底。

use deep_engine_native::runtime_package::{
    RuntimePackageDeltaOutcome, RuntimePackageDeltaRejectionReason, apply_runtime_package_delta,
    build_runtime_package_delta, parse_and_validate_runtime_package, plan_runtime_package_diff,
    runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

const DEEP2D_ID: &str = "native:deep2d:atlas-smoke";
const SCENE_ID: &str = "scene.main";

fn v1_bytes() -> Vec<u8> {
    include_bytes!("fixtures/runtime-package-v1.json").to_vec()
}

fn v2_bytes() -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&v1_bytes()).unwrap();
    change_scene(&mut value);
    reseal(&mut value);
    serde_json::to_vec(&value).unwrap()
}

fn dynamic_v7_bytes(revision: u64) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&v1_bytes()).unwrap();
    let id = "scene.dynamic";
    value["schemaVersion"] = json!(7);
    value["packageVersion"] = json!(format!("1.0.{revision}"));
    value["materialBindings"] = json!([]);
    value["entrypoints"]["dynamicRuntime"] = json!(id);
    value["payloads"][id] = json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 1, "id": id,
        "revision": revision + 1,
        "animation": { "schema": "deep-engine.dynamic-animation", "schemaVersion": 1,
            "durationMs": 1000, "tracks": [{ "targetId": "pump", "property": "translation",
                "keyframes": [{ "timeMs": 0, "value": [0, 0, 0, 0, 0, 0, 1] },
                    { "timeMs": 1000, "value": [revision as f64 + 1.0, 0, 0, 0, 0, 0, 1] }] }] }
    });
    value["resources"].as_array_mut().unwrap().push(json!({
        "id": id, "kind": "dynamic-runtime", "revision": revision + 1,
        "contentHash": { "algorithm": "sha256", "value": "0".repeat(64) }
    }));
    value["resources"]
        .as_array_mut()
        .unwrap()
        .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    reseal(&mut value);
    serde_json::to_vec(&value).unwrap()
}

/// 去掉 deep2d 布局对象:入口置空并移除资源与载荷,重封后是合法包。
fn stripped_bytes() -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&v1_bytes()).unwrap();
    value["entrypoints"]["deep2d"] = Value::Null;
    let resources = value["resources"].as_array_mut().unwrap();
    resources.retain(|resource| resource["id"] != json!(DEEP2D_ID));
    value["payloads"].as_object_mut().unwrap().remove(DEEP2D_ID);
    reseal(&mut value);
    serde_json::to_vec(&value).unwrap()
}

fn change_scene(value: &mut Value) {
    value["payloads"][SCENE_ID]["instances"][0]["transform"][12] = json!(-0.25);
    let resource = value["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["id"] == json!(SCENE_ID))
        .unwrap();
    resource["revision"] = json!(resource["revision"].as_u64().unwrap() + 1);
}

/// 逐资源回填内容哈希再重封包哈希;任何结构修改后都必须调用。
fn reseal(value: &mut Value) {
    let hashes = value["payloads"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(id, payload)| (id.clone(), runtime_content_sha256(payload)))
        .collect::<Vec<_>>();
    for (id, hash) in hashes {
        value["resources"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|resource| resource["id"] == json!(id))
            .expect("payload keys match the resource index")["contentHash"]["value"] = json!(hash);
    }
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).unwrap());
}

fn manifest_value(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

fn resealed_value(bytes: &[u8]) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(bytes).unwrap();
    reseal(&mut value);
    serde_json::to_vec(&value).unwrap()
}

fn applied(
    baseline: &[u8],
    manifest: &[u8],
) -> deep_engine_native::runtime_package::AppliedRuntimePackageDelta {
    match apply_runtime_package_delta(baseline, manifest).unwrap() {
        RuntimePackageDeltaOutcome::Applied(delta) => *delta,
        RuntimePackageDeltaOutcome::IdempotentSkip => panic!("expected an applied delta"),
    }
}

fn rejected_reason(
    baseline: &[u8],
    manifest: &[u8],
) -> (RuntimePackageDeltaRejectionReason, String) {
    let error = apply_runtime_package_delta(baseline, manifest).unwrap_err();
    (error.reason, error.message)
}

#[test]
fn delta_operations_match_the_resource_diff_plan() {
    let manifest = manifest_value(&build_runtime_package_delta(&v1_bytes(), &v2_bytes()).unwrap());
    let base = parse_and_validate_runtime_package(&v1_bytes()).unwrap();
    let target = parse_and_validate_runtime_package(&v2_bytes()).unwrap();
    let plan = plan_runtime_package_diff(&base, &target).unwrap();
    assert_eq!(plan.entries.len(), 1);
    let operations = manifest["operations"].as_array().unwrap();
    assert_eq!(operations.len(), plan.entries.len());
    assert_eq!(operations[0]["action"], json!("upsert"));
    assert_eq!(operations[0]["resource"]["id"], json!(SCENE_ID));
    assert_eq!(manifest["operationCount"], json!(1));
    assert_eq!(manifest["packageId"], json!("deep.runtime.golden"));
    assert_eq!(
        manifest["targetPackageHash"],
        json!(target.package_hash.as_str())
    );
    assert_eq!(
        manifest["basePackageHash"],
        json!(base.package_hash.as_str())
    );
    // 未变对象不出现在操作清单中:它们继续由基线供给(入口字段合法携带其 id)。
    let operations_json = serde_json::to_string(&manifest["operations"]).unwrap();
    assert!(!operations_json.contains("deep.builtin.studio-ibl.v1"));
}

#[test]
fn build_is_deterministic_and_ordered_like_the_diff_plan() {
    let base = stripped_bytes();
    let target = v2_bytes();
    let first = build_runtime_package_delta(&base, &target).unwrap();
    let second = build_runtime_package_delta(&base, &target).unwrap();
    assert_eq!(first, second);
    let manifest = manifest_value(&first);
    let operations = manifest["operations"].as_array().unwrap();
    let actions = operations
        .iter()
        .map(|operation| operation["action"].clone())
        .collect::<Vec<_>>();
    assert_eq!(actions, [json!("upsert"), json!("upsert")]);
    // 计划按 (id, kind) 排序:deep2d 布局对象先于场景文档。
    assert_eq!(operations[0]["resource"]["id"], json!(DEEP2D_ID));
    assert_eq!(operations[1]["resource"]["id"], json!(SCENE_ID));
    assert_eq!(manifest["operationCount"], json!(2));
}

#[test]
fn applied_delta_equals_the_full_target_parse() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let delta = applied(&base_bytes, &manifest);
    let base = parse_and_validate_runtime_package(&base_bytes).unwrap();
    let direct = parse_and_validate_runtime_package(&target_bytes).unwrap();
    // 产物字节独立通过既有 parse_and_validate,且内容身份与全量 v2 一致。
    let reparsed = parse_and_validate_runtime_package(&delta.bytes).unwrap();
    assert_eq!(reparsed.package_hash, direct.package_hash);
    assert_eq!(delta.package.package_hash, direct.package_hash);
    assert_eq!(delta.base_package_hash, base.package_hash);
    assert_eq!(delta.upserts, 1);
    assert_eq!(delta.removes, 0);
    // 与既有 diff.rs 对拍:应用残差为空,基线→产物的计划与基线→全量 v2 逐条相等。
    let residual = plan_runtime_package_diff(&delta.package, &direct).unwrap();
    assert!(residual.is_empty(), "{residual:?}");
    assert_eq!(residual.reused, direct.resource_index.len());
    assert_eq!(
        plan_runtime_package_diff(&base, &delta.package).unwrap(),
        plan_runtime_package_diff(&base, &direct).unwrap()
    );
}

#[test]
fn applied_delta_reconstructs_removed_layout_objects() {
    let (base_bytes, target_bytes) = (v1_bytes(), stripped_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let delta = applied(&base_bytes, &manifest);
    assert_eq!(delta.removes, 1);
    let direct = parse_and_validate_runtime_package(&target_bytes).unwrap();
    assert_eq!(delta.package.package_hash, direct.package_hash);
    let residual = plan_runtime_package_diff(&delta.package, &direct).unwrap();
    assert!(residual.is_empty(), "{residual:?}");
}

#[test]
fn applied_delta_is_byte_deterministic() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let first = applied(&base_bytes, &manifest);
    let second = applied(&base_bytes, &manifest);
    assert_eq!(first.bytes, second.bytes);
}

#[test]
fn late_delta_arriving_at_target_is_an_idempotent_skip() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    assert!(matches!(
        apply_runtime_package_delta(&target_bytes, &manifest).unwrap(),
        RuntimePackageDeltaOutcome::IdempotentSkip
    ));
}

#[test]
fn identical_packages_yield_an_empty_delta_that_still_skips() {
    let bytes = v1_bytes();
    let manifest = build_runtime_package_delta(&bytes, &bytes).unwrap();
    assert_eq!(
        manifest_value(&manifest)["operations"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert!(matches!(
        apply_runtime_package_delta(&bytes, &manifest).unwrap(),
        RuntimePackageDeltaOutcome::IdempotentSkip
    ));
}

#[test]
fn stale_delta_after_the_package_moved_on_keeps_the_old_version() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let mut v3: Value = serde_json::from_slice(&target_bytes).unwrap();
    change_scene(&mut v3);
    let v3_bytes = resealed_value(&serde_json::to_vec(&v3).unwrap());
    let (reason, message) = rejected_reason(&v3_bytes, &manifest);
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::BasePackageMismatch
    );
    assert!(message.contains("late or out of order"), "{message}");
}

#[test]
fn truncated_manifest_bytes_are_unreadable_and_keep_the_old_version() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let cut = manifest.len() / 2;
    let (reason, message) = rejected_reason(&base_bytes, &manifest[..cut]);
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::ManifestUnreadable
    );
    assert!(message.contains("truncated in transit"), "{message}");
}

#[test]
fn packet_loss_is_caught_by_count_then_by_content_address() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    // 丢最后一操作但条数声明还在:条数对不上 → 截断诊断。
    let mut lossy = manifest_value(&manifest);
    lossy["operations"].as_array_mut().unwrap().pop();
    let (reason, message) = rejected_reason(&base_bytes, &serde_json::to_vec(&lossy).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::ManifestTruncated
    );
    assert!(message.contains("truncated in transit"), "{message}");
    // 连条数一起丢(静默丢包):重建内容寻址不等于声明 → 哈希诊断。
    lossy["operationCount"] = json!(0);
    let (reason, message) = rejected_reason(&base_bytes, &serde_json::to_vec(&lossy).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::TargetHashMismatch
    );
    assert!(message.contains("incomplete or tampered"), "{message}");
}

#[test]
fn operation_count_mismatch_is_truncation() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let mut tampered = manifest_value(&manifest);
    tampered["operationCount"] = json!(99);
    let (reason, _) = rejected_reason(&base_bytes, &serde_json::to_vec(&tampered).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::ManifestTruncated
    );
}

#[test]
fn unsupported_target_schema_keeps_the_old_version() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    for version in [6, 8, 0] {
        let mut tampered = manifest_value(&manifest);
        tampered["targetSchemaVersion"] = json!(version);
        let (reason, message) =
            rejected_reason(&base_bytes, &serde_json::to_vec(&tampered).unwrap());
        assert_eq!(
            reason,
            RuntimePackageDeltaRejectionReason::TargetSchemaUnsupported,
            "schemaVersion {version}"
        );
        assert!(message.contains("schemaVersion"), "{message}");
    }
    let mut foreign = manifest_value(&manifest);
    foreign["schema"] = json!("deep-engine.runtime-package-delta-v2");
    foreign["schemaVersion"] = json!(2);
    let (reason, _) = rejected_reason(&base_bytes, &serde_json::to_vec(&foreign).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::ManifestSchemaUnsupported
    );
}

#[test]
fn dynamic_runtime_v7_delta_updates_and_reuses_its_entrypoint_dependency() {
    let (base_bytes, target_bytes) = (dynamic_v7_bytes(0), dynamic_v7_bytes(1));
    parse_and_validate_runtime_package(&base_bytes).unwrap();
    let target = parse_and_validate_runtime_package(&target_bytes).unwrap();
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let value = manifest_value(&manifest);
    assert_eq!(value["targetSchemaVersion"], json!(7));
    assert_eq!(
        value["entrypoints"]["dynamicRuntime"],
        json!("scene.dynamic")
    );
    assert_eq!(value["operations"].as_array().unwrap().len(), 1);
    let mut missing_runtime = value.clone();
    missing_runtime["entrypoints"]["dynamicRuntime"] = json!("scene.ghost");
    let (reason, message) =
        rejected_reason(&base_bytes, &serde_json::to_vec(&missing_runtime).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::MissingDependency
    );
    assert!(message.contains("scene.ghost"), "{message}");
    let delta = applied(&base_bytes, &manifest);
    assert_eq!(delta.package.package_hash, target.package_hash);
    assert_eq!(delta.package.dynamic_runtime.as_ref().unwrap().revision, 2);
    assert_eq!(
        plan_runtime_package_diff(&delta.package, &target)
            .unwrap()
            .reused,
        target.resource_index.len()
    );
}

#[test]
fn missing_dependency_names_the_absent_resource() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let mut tampered = manifest_value(&manifest);
    tampered["entrypoints"]["shaderPackages"] = json!(["scene.ghost"]);
    let (reason, message) = rejected_reason(&base_bytes, &serde_json::to_vec(&tampered).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::MissingDependency
    );
    assert!(message.contains("scene.ghost"), "{message}");
}

#[test]
fn cross_identity_delta_is_rejected_on_both_sides() {
    let base_bytes = v1_bytes();
    let mut foreign: Value = serde_json::from_slice(&base_bytes).unwrap();
    foreign["packageId"] = json!("deep.runtime.golden.two");
    let foreign_bytes = resealed_value(&serde_json::to_vec(&foreign).unwrap());
    let error = build_runtime_package_delta(&base_bytes, &foreign_bytes).unwrap_err();
    assert!(
        error.to_string().contains("cross package identities"),
        "{error}"
    );
    let target_bytes = v2_bytes();
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let mut tampered = manifest_value(&manifest);
    tampered["packageId"] = json!("deep.runtime.golden.two");
    let (reason, _) = rejected_reason(&base_bytes, &serde_json::to_vec(&tampered).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::PackageIdentityMismatch
    );
}

#[test]
fn hostile_publisher_sealing_an_invalid_target_hits_package_validation() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    // 发布侧把 scene.main 的 revision 封成 0(非法)并自洽重算目标哈希:
    // 内容寻址终检放行,重建包必须被既有 parse_and_validate 兜底拦截。
    let mut invalid_target: Value = serde_json::from_slice(&target_bytes).unwrap();
    let resource = invalid_target["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|resource| resource["id"] == json!(SCENE_ID))
        .unwrap();
    resource["revision"] = json!(0);
    let mut tampered = manifest_value(&manifest);
    tampered["operations"][0]["resource"]["revision"] = json!(0);
    tampered["targetPackageHash"] = json!(runtime_package_sha256(&invalid_target).unwrap());
    let (reason, message) = rejected_reason(&base_bytes, &serde_json::to_vec(&tampered).unwrap());
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::ReconstructedPackageInvalid
    );
    assert!(message.contains("revision"), "{message}");
}

#[test]
fn baseline_that_is_not_a_package_is_reported_separately() {
    let (base_bytes, target_bytes) = (v1_bytes(), v2_bytes());
    let manifest = build_runtime_package_delta(&base_bytes, &target_bytes).unwrap();
    let (reason, _) = rejected_reason(b"{\"unrelated\": true}", &manifest);
    assert_eq!(
        reason,
        RuntimePackageDeltaRejectionReason::BaselineUnreadable
    );
}
