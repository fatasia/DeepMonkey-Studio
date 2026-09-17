//! delta 清单线格式与解析:消费侧对不可信字节的唯一入口。
//!
//! 解析走与包体同一套字节/节点/深度预算;结构不合 v1 即
//! [`RuntimePackageDeltaRejectionReason::ManifestUnreadable`],由调用方
//! 保留活动旧版并给出诊断。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    RuntimePackageDeltaRejection, RuntimePackageDeltaRejectionReason, RuntimeResourceIndexEntry,
    RuntimeResourceKind, parse_bounded_json, validate,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct RuntimePackageDeltaManifest {
    pub schema: String,
    pub schema_version: u32,
    pub package_id: String,
    pub base_package_hash: String,
    pub target_package_hash: String,
    pub base_package_version: String,
    pub target_package_version: String,
    pub target_schema_version: u32,
    pub entrypoints: Value,
    pub material_bindings: Value,
    pub operations: Vec<RuntimePackageDeltaOperation>,
    pub operation_count: usize,
}

/// 内部标签枚举容忍条目内未知字段:任何注入物要么改变重建哈希(被
/// `TargetHashMismatch` 拦截),要么被重建后的完整包校验拦截。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub(super) enum RuntimePackageDeltaOperation {
    Upsert {
        resource: RuntimeResourceIndexEntry,
        payload: Value,
    },
    Remove {
        id: String,
        kind: RuntimeResourceKind,
    },
}

const ENTRYPOINT_ID_KEYS: [&str; 8] = [
    "renderPacket",
    "deep2d",
    "environment",
    "camera",
    "chart",
    "chartSim",
    "dashboard",
    "experimentalX",
];

pub(super) fn parse_delta_manifest(
    bytes: &[u8],
) -> Result<RuntimePackageDeltaManifest, RuntimePackageDeltaRejection> {
    let unreadable = |message: String| {
        rejection(
            RuntimePackageDeltaRejectionReason::ManifestUnreadable,
            message,
        )
    };
    validate::input_size(bytes).map_err(|error| unreadable(error.to_string()))?;
    let value = parse_bounded_json(bytes).map_err(|error| {
        unreadable(format!(
            "delta manifest is unreadable, possibly truncated in transit: {error}"
        ))
    })?;
    serde_json::from_value(value).map_err(|error| {
        unreadable(format!(
            "delta manifest does not match the v1 schema: {error}"
        ))
    })
}

/// 入口引用是本包格式唯一的对象间依赖边;空值入口(如 deep2d:null)不构成引用。
pub(super) fn referenced_resource_ids(entrypoints: &Value) -> Vec<String> {
    let Some(entries) = entrypoints.as_object() else {
        return Vec::new();
    };
    let mut ids: Vec<String> = ENTRYPOINT_ID_KEYS
        .iter()
        .filter_map(|key| entries.get(*key).and_then(Value::as_str))
        .map(str::to_owned)
        .collect();
    if let Some(packages) = entries.get("shaderPackages").and_then(Value::as_array) {
        ids.extend(packages.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    ids.sort();
    ids.dedup();
    ids
}

fn rejection(
    reason: RuntimePackageDeltaRejectionReason,
    message: impl std::fmt::Display,
) -> RuntimePackageDeltaRejection {
    RuntimePackageDeltaRejection {
        reason,
        message: message.to_string(),
    }
}
