//! 对象级内容寻址 delta 热同步合同。
//!
//! 两包 (base→target) 按资源对象 (render packet/document、chart/chartSim/data、
//! deep2d/layout、shader/IBL/camera/resource——同一 kind 标签机制覆盖全部域)
//! 计算内容寻址增量清单:仅携带 contentHash 变化或增删的对象,未变对象留在基线。
//! 清单由发布侧 [`build_runtime_package_delta`] 生成,消费侧
//! [`apply_runtime_package_delta`] 应用后重建出**完整 v2 等价包字节**,必须被既有
//! `parse_and_validate_runtime_package` 接受,且重算包哈希等于清单声明值。
//!
//! 失败关闭语义(调用方一律保留活动旧版):
//! - 迟到 delta(活动包已是目标)→ [`RuntimePackageDeltaOutcome::IdempotentSkip`],
//!   由调用方递增幂等跳过计数;
//! - 丢包/截断(清单 JSON 损坏、操作条数与声明不符、缺操作)→ 结构化拒绝;
//! - schema 不兼容(目标 schemaVersion 超出标准加载器支持域,含实验 X v6)→ 结构化拒绝;
//! - 依赖闭包:目标入口引用的资源必须完整存在于增量或基线,缺失即拒绝并列出缺失 id。
//!
//! 本模块只做字节级纯函数,不做 IO、不持状态;watch/LKG/present 后提交的接线
//! 复用既有 `app/package_watch` 与 `runtime_lkg` 管道,不建第二套 loader。

use std::collections::BTreeMap;
use std::fmt;

use serde_json::Value;

use super::delta_manifest::{
    RuntimePackageDeltaManifest, RuntimePackageDeltaOperation, parse_delta_manifest,
    referenced_resource_ids,
};
use super::{
    DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION, DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION,
    LoadedRuntimePackage, RuntimePackageEnvelope, RuntimePackageError, RuntimeResourceIndexEntry,
    RuntimeResourcePlanAction, RuntimeResourcePlanEntry, fail, parse_and_validate_runtime_package,
    parse_bounded_json, plan_runtime_package_resource_diff, runtime_package_sha256,
    validated_envelope,
};

pub const DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA: &str = "deep-engine.runtime-package-delta";
pub const DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA_VERSION: u32 = 1;
/// 标准 `parse_and_validate_runtime_package` 接受的包版本域;v6 属实验 X 专用
/// 加载器,与标准 delta 合同互斥。
const SUPPORTED_TARGET_SCHEMA_VERSIONS: [u32; 6] =
    [1, 2, 3, 4, 5, super::DEEP_RUNTIME_PACKAGE_DYNAMIC_VERSION];

/// delta 应用产物:完整 v2 等价包,已通过既有解析校验,可直接进入既有
/// 预热/present/提交管道。
#[derive(Debug)]
pub struct AppliedRuntimePackageDelta {
    pub bytes: Vec<u8>,
    pub package: LoadedRuntimePackage,
    pub base_package_hash: String,
    pub target_package_hash: String,
    pub upserts: usize,
    pub removes: usize,
}

#[derive(Debug)]
pub enum RuntimePackageDeltaOutcome {
    Applied(Box<AppliedRuntimePackageDelta>),
    /// 迟到 delta:活动包已是目标版本;调用方保留现状并递增幂等跳过计数。
    IdempotentSkip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimePackageDeltaRejectionReason {
    BaselineUnreadable,
    ManifestUnreadable,
    ManifestSchemaUnsupported,
    PackageIdentityMismatch,
    TargetSchemaUnsupported,
    BasePackageMismatch,
    ManifestTruncated,
    MissingDependency,
    TargetHashMismatch,
    ReconstructedPackageInvalid,
}

#[derive(Debug)]
pub struct RuntimePackageDeltaRejection {
    pub reason: RuntimePackageDeltaRejectionReason,
    pub message: String,
}

impl fmt::Display for RuntimePackageDeltaRejection {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            output,
            "runtime package delta rejected ({:?}): {}",
            self.reason, self.message
        )
    }
}

impl std::error::Error for RuntimePackageDeltaRejection {}

/// 从两个已验证包计算确定性增量清单;与 `plan_runtime_package_resource_diff`
/// 同一归并实现,added/changed→upsert、removed→remove,未变对象不出现在清单中。
pub fn build_runtime_package_delta(
    base_bytes: &[u8],
    target_bytes: &[u8],
) -> Result<Vec<u8>, RuntimePackageError> {
    let base = validated_envelope(base_bytes)?;
    let target = validated_envelope(target_bytes)?;
    for (role, package) in [("base", &base), ("target", &target)] {
        if package.schema_version == DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION {
            return fail(format!(
                "runtime package delta {role} uses the experimental X loader; X packages are outside the standard delta contract"
            ));
        }
    }
    if base.package_id != target.package_id {
        return fail(format!(
            "runtime package delta cannot cross package identities: {:?} -> {:?}",
            base.package_id, target.package_id
        ));
    }
    let target_value = parse_bounded_json(target_bytes).map_err(|error| {
        RuntimePackageError(format!("runtime package target re-read failed: {error}"))
    })?;
    let plan = plan_runtime_package_resource_diff(&base.resources, &target.resources)?;
    let operations = plan
        .entries
        .iter()
        .map(|entry| delta_operation(&target_value, entry))
        .collect::<Result<Vec<_>, _>>()?;
    let manifest = RuntimePackageDeltaManifest {
        schema: DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA.to_owned(),
        schema_version: DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA_VERSION,
        package_id: base.package_id,
        base_package_hash: base.package_hash.value,
        target_package_hash: target.package_hash.value,
        base_package_version: base.package_version,
        target_package_version: target.package_version,
        target_schema_version: target.schema_version,
        entrypoints: target_value
            .get("entrypoints")
            .cloned()
            .ok_or_else(|| RuntimePackageError("runtime package entrypoints are missing".into()))?,
        material_bindings: target_value
            .get("materialBindings")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        operation_count: operations.len(),
        operations,
    };
    serde_json::to_vec(&manifest).map_err(|error| {
        RuntimePackageError(format!("runtime package delta encoding failed: {error}"))
    })
}

fn delta_operation(
    target: &Value,
    entry: &RuntimeResourcePlanEntry,
) -> Result<RuntimePackageDeltaOperation, RuntimePackageError> {
    match entry.action {
        RuntimeResourcePlanAction::Remove => Ok(RuntimePackageDeltaOperation::Remove {
            id: entry.id.clone(),
            kind: entry.kind,
        }),
        RuntimeResourcePlanAction::Add | RuntimeResourcePlanAction::Replace => {
            let payload = target
                .get("payloads")
                .and_then(|payloads| payloads.get(&entry.id))
                .ok_or_else(|| {
                    RuntimePackageError(format!(
                        "runtime resource {:?} payload is missing from its package",
                        entry.id
                    ))
                })?
                .clone();
            Ok(RuntimePackageDeltaOperation::Upsert {
                resource: RuntimeResourceIndexEntry {
                    id: entry.id.clone(),
                    kind: entry.kind,
                    revision: entry.revision,
                    content_hash: entry.content_hash.clone(),
                },
                payload,
            })
        }
    }
}

/// 把清单应用到基线字节:成功即 [`RuntimePackageDeltaOutcome::Applied`](完整 v2
/// 等价字节 + 已验证包);迟到即 [`RuntimePackageDeltaOutcome::IdempotentSkip`];
/// 其余一律结构化拒绝,调用方保留活动旧版。纯函数,不改动任何输入。
pub fn apply_runtime_package_delta(
    baseline_bytes: &[u8],
    manifest_bytes: &[u8],
) -> Result<RuntimePackageDeltaOutcome, RuntimePackageDeltaRejection> {
    let baseline = validated_envelope(baseline_bytes).map_err(|error| {
        rejection(
            RuntimePackageDeltaRejectionReason::BaselineUnreadable,
            error,
        )
    })?;
    let manifest = parse_delta_manifest(manifest_bytes)?;
    if manifest.schema != DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA
        || manifest.schema_version != DEEP_RUNTIME_PACKAGE_DELTA_SCHEMA_VERSION
    {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::ManifestSchemaUnsupported,
            format!(
                "unsupported delta manifest schema {:?} version {}",
                manifest.schema, manifest.schema_version
            ),
        ));
    }
    if manifest.package_id != baseline.package_id {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::PackageIdentityMismatch,
            format!(
                "delta targets package {:?} but the active package is {:?}",
                manifest.package_id, baseline.package_id
            ),
        ));
    }
    // 迟到 delta:活动包已是目标;在其余检查之前短路,保证幂等语义不受清单
    // 其余字段(可能来自更旧的发布侧)影响。
    if baseline.package_hash.value == manifest.target_package_hash {
        return Ok(RuntimePackageDeltaOutcome::IdempotentSkip);
    }
    if baseline.package_hash.value != manifest.base_package_hash {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::BasePackageMismatch,
            format!(
                "delta bases on package hash {} but the active package is {}; the delta arrived late or out of order",
                manifest.base_package_hash, baseline.package_hash.value
            ),
        ));
    }
    if !SUPPORTED_TARGET_SCHEMA_VERSIONS.contains(&manifest.target_schema_version) {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::TargetSchemaUnsupported,
            format!(
                "delta target schemaVersion {} is outside the standard loader support range {SUPPORTED_TARGET_SCHEMA_VERSIONS:?}",
                manifest.target_schema_version
            ),
        ));
    }
    if manifest.operation_count != manifest.operations.len() {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::ManifestTruncated,
            format!(
                "manifest declares {} operations but carries {}; the manifest was truncated in transit",
                manifest.operation_count,
                manifest.operations.len()
            ),
        ));
    }
    let ops = apply_operations(&baseline, &manifest)?;
    reject_missing_dependencies(&manifest.entrypoints, &ops.resources)?;
    let (bytes, target_hash) = reconstruct(baseline_bytes, &manifest, ops.resources, ops.payloads)?;
    let package = parse_and_validate_runtime_package(&bytes).map_err(|error| {
        rejection(
            RuntimePackageDeltaRejectionReason::ReconstructedPackageInvalid,
            format!("reconstructed delta target failed its own package validation: {error}"),
        )
    })?;
    Ok(RuntimePackageDeltaOutcome::Applied(Box::new(
        AppliedRuntimePackageDelta {
            bytes,
            package,
            base_package_hash: manifest.base_package_hash,
            target_package_hash: target_hash,
            upserts: ops.upserts,
            removes: ops.removes,
        },
    )))
}

/// 先删后插:同 id 换 kind 时与清单内条目顺序无关,最终状态确定。
struct AppliedOperations {
    resources: BTreeMap<String, RuntimeResourceIndexEntry>,
    payloads: BTreeMap<String, Value>,
    upserts: usize,
    removes: usize,
}

fn apply_operations(
    baseline: &RuntimePackageEnvelope,
    manifest: &RuntimePackageDeltaManifest,
) -> Result<AppliedOperations, RuntimePackageDeltaRejection> {
    let mut outcome = AppliedOperations {
        resources: baseline
            .resources
            .iter()
            .map(|resource| (resource.id.clone(), resource.clone()))
            .collect(),
        payloads: baseline.payloads.clone(),
        upserts: 0,
        removes: 0,
    };
    for operation in &manifest.operations {
        match operation {
            RuntimePackageDeltaOperation::Remove { id, .. } => {
                outcome.resources.remove(id);
                outcome.payloads.remove(id);
                outcome.removes += 1;
            }
            RuntimePackageDeltaOperation::Upsert { resource, payload } => {
                outcome
                    .resources
                    .insert(resource.id.clone(), resource.clone());
                outcome
                    .payloads
                    .insert(resource.id.clone(), payload.clone());
                outcome.upserts += 1;
            }
        }
    }
    Ok(outcome)
}

fn reject_missing_dependencies(
    entrypoints: &Value,
    resources: &BTreeMap<String, RuntimeResourceIndexEntry>,
) -> Result<(), RuntimePackageDeltaRejection> {
    let missing = referenced_resource_ids(entrypoints)
        .into_iter()
        .filter(|id| !resources.contains_key(id))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(rejection(
        RuntimePackageDeltaRejectionReason::MissingDependency,
        format!(
            "delta target references resources absent from both the delta and the baseline: {}",
            missing.join(", ")
        ),
    ))
}

fn reconstruct(
    baseline_bytes: &[u8],
    manifest: &RuntimePackageDeltaManifest,
    resources: BTreeMap<String, RuntimeResourceIndexEntry>,
    payloads: BTreeMap<String, Value>,
) -> Result<(Vec<u8>, String), RuntimePackageDeltaRejection> {
    let invalid = |message: String| {
        rejection(
            RuntimePackageDeltaRejectionReason::ReconstructedPackageInvalid,
            message,
        )
    };
    let mut root = parse_bounded_json(baseline_bytes)
        .map_err(|error| invalid(format!("baseline package re-read failed: {error}")))?;
    {
        let object = root
            .as_object_mut()
            .ok_or_else(|| invalid("baseline package root is not an object".to_owned()))?;
        object.insert(
            "packageVersion".into(),
            Value::String(manifest.target_package_version.clone()),
        );
        object.insert(
            "schemaVersion".into(),
            Value::from(manifest.target_schema_version),
        );
        object.insert("entrypoints".into(), manifest.entrypoints.clone());
        if manifest.target_schema_version >= DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION {
            object.insert(
                "materialBindings".into(),
                manifest.material_bindings.clone(),
            );
        } else {
            object.remove("materialBindings");
        }
        let indexed = resources
            .values()
            .map(|resource| {
                serde_json::to_value(resource).map_err(|error| {
                    invalid(format!("delta resource index encoding failed: {error}"))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        object.insert("resources".into(), Value::Array(indexed));
        object.insert(
            "payloads".into(),
            Value::Object(payloads.into_iter().collect()),
        );
        object.remove("packageHash");
    }
    let hash = runtime_package_sha256(&root)
        .map_err(|error| invalid(format!("reconstructed package hashing failed: {error}")))?;
    // 内容寻址终检:清单缺失任一操作、被篡改或与基线错位,都会在这里现形。
    if hash != manifest.target_package_hash {
        return Err(rejection(
            RuntimePackageDeltaRejectionReason::TargetHashMismatch,
            format!(
                "reconstructed package hashes to {hash} but the manifest declares {}; the manifest is incomplete or tampered",
                manifest.target_package_hash
            ),
        ));
    }
    root.as_object_mut()
        .ok_or_else(|| invalid("baseline package root is not an object".to_owned()))?
        .insert(
            "packageHash".into(),
            serde_json::json!({"algorithm": "sha256", "value": hash}),
        );
    let bytes = serde_json::to_vec(&root)
        .map_err(|error| invalid(format!("reconstructed package encoding failed: {error}")))?;
    Ok((bytes, hash))
}

fn rejection(
    reason: RuntimePackageDeltaRejectionReason,
    message: impl fmt::Display,
) -> RuntimePackageDeltaRejection {
    RuntimePackageDeltaRejection {
        reason,
        message: message.to_string(),
    }
}
