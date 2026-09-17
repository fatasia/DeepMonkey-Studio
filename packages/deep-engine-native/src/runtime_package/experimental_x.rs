use super::*;
use crate::compat_x::{
    CompatibilityLane, X_COMPATIBILITY_SCHEMA_VERSION, XBudget, XCompatibilityHost,
    XDynamicContent, XExecutionContext, XRequest,
};
use serde::{Deserialize, Serialize};

const X_RESOURCE_SCHEMA: &str = "deep-engine.experimental-x-resource";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct XResourcePayload {
    schema: String,
    schema_version: u32,
    id: String,
    revision: u64,
    content: XDynamicContent,
}

#[derive(Debug)]
pub struct LoadedXRuntimePackage {
    pub base: LoadedRuntimePackage,
    pub resource_id: String,
    pub revision: u64,
    pub content: XDynamicContent,
}

/// 作者侧封闭IR冻结：只生成索引与值，不启动worker，不接收源码或路径。
pub fn freeze_x_resource(
    id: &str,
    revision: u64,
    request: XRequest,
) -> Result<(RuntimeResourceIndexEntry, Value), RuntimePackageError> {
    if !validate::resource_id(id) || revision == 0 || revision > 9_007_199_254_740_991 {
        return fail("invalid X resource identity or revision");
    }
    let hash = request_hash(&request)?;
    let payload = XResourcePayload {
        schema: X_RESOURCE_SCHEMA.into(),
        schema_version: 1,
        id: id.into(),
        revision,
        content: XDynamicContent {
            schema_version: X_COMPATIBILITY_SCHEMA_VERSION,
            lane: CompatibilityLane::ExperimentalX,
            request,
            content_hash: RuntimeContentHash {
                algorithm: "sha256".into(),
                value: hash,
            },
        },
    };
    let value = serde_json::to_value(payload).map_err(|e| RuntimePackageError(e.to_string()))?;
    Ok((
        RuntimeResourceIndexEntry {
            id: id.into(),
            kind: RuntimeResourceKind::ExperimentalX,
            revision,
            content_hash: RuntimeContentHash {
                algorithm: "sha256".into(),
                value: runtime_content_sha256(&value),
            },
        },
        value,
    ))
}

/// 显式加载不代表启用。调用者必须另行提供默认关闭的XContentScheduler。
pub fn parse_and_validate_x_runtime_package(
    bytes: &[u8],
) -> Result<LoadedXRuntimePackage, RuntimePackageError> {
    let package = validated_envelope(bytes)?;
    if package.schema_version != DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION {
        return fail("experimental X loader requires runtime package v6");
    }
    let id = package
        .entrypoints
        .experimental_x
        .as_deref()
        .ok_or_else(|| RuntimePackageError("missing experimentalX entrypoint".into()))?;
    let entry = payloads::descriptor(&package, id, RuntimeResourceKind::ExperimentalX)?;
    let resource: XResourcePayload =
        serde_json::from_value(payloads::payload(&package, id)?.clone())
            .map_err(|error| RuntimePackageError(format!("invalid X resource: {error}")))?;
    if resource.schema != X_RESOURCE_SCHEMA
        || resource.schema_version != 1
        || resource.id != entry.id
        || resource.revision != entry.revision
        || resource.content.schema_version != X_COMPATIBILITY_SCHEMA_VERSION
        || resource.content.lane != CompatibilityLane::ExperimentalX
    {
        return fail("X resource schema, lane, or index identity mismatch");
    }
    if resource.content.content_hash.algorithm != "sha256"
        || resource.content.content_hash.value != request_hash(&resource.content.request)?
    {
        return fail("frozen X request hash mismatch");
    }
    Ok(LoadedXRuntimePackage {
        base: payloads::decode(package)?,
        resource_id: resource.id,
        revision: resource.revision,
        content: resource.content,
    })
}

fn request_hash(request: &XRequest) -> Result<String, RuntimePackageError> {
    // runtime canonical将数字映射到binary64；冻结的整数必须保持精确可表示。
    if [
        request.expected_epoch,
        request.started_at_ms,
        request.random_seed,
    ]
    .iter()
    .any(|value| *value > 9_007_199_254_740_991)
    {
        return fail("frozen X epoch, time, and random seed must be safe JSON integers");
    }
    let budget = XBudget::default();
    let bytes = crate::compat_x::process::encode_bounded_request(request, budget)
        .map_err(|e| RuntimePackageError(format!("X freeze budget: {e:?}")))?;
    // 编译期校验封闭IR的资源引用/有限数/预算，不是求值失败后的运行时回退。
    XCompatibilityHost::new(true, budget)
        .unwrap()
        .evaluate(
            CompatibilityLane::ExperimentalX,
            request,
            XExecutionContext {
                current_epoch: request.expected_epoch,
                now_ms: request.started_at_ms,
                cancelled: false,
            },
        )
        .map_err(|e| RuntimePackageError(format!("invalid frozen X request: {e:?}")))?;
    let value = parse_bounded_json(&bytes).map_err(|e| RuntimePackageError(e.to_string()))?;
    Ok(runtime_content_sha256(&value))
}
