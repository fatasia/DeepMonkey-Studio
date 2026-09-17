use std::collections::HashMap;

use serde_json::Value;

use super::hash::hash_canonical;
use super::{
    DEEP_RUNTIME_PACKAGE_SCHEMA, DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
    DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION, RuntimePackageEnvelope, RuntimePackageError,
    RuntimeResourceIndexEntry, fail,
};

pub(super) const MAX_INPUT_BYTES: usize = 256 * 1024 * 1024;
pub(super) const MAX_JSON_NODES: usize = 2_000_000;
pub(super) const MAX_JSON_DEPTH: usize = 32;
const MAX_RESOURCES: usize = 132;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) fn input_size(bytes: &[u8]) -> Result<(), RuntimePackageError> {
    if bytes.len() > MAX_INPUT_BYTES {
        fail("Deep Runtime Package exceeds the 256 MiB input limit")
    } else {
        Ok(())
    }
}

pub(super) fn tree_budget(value: &Value) -> Result<(), RuntimePackageError> {
    fn inspect(value: &Value, depth: usize, nodes: &mut usize) -> Result<(), RuntimePackageError> {
        *nodes += 1;
        if *nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH {
            return fail("Deep Runtime Package exceeds its JSON node or depth budget");
        }
        match value {
            Value::Array(items) => items
                .iter()
                .try_for_each(|item| inspect(item, depth + 1, nodes)),
            Value::Object(items) => items
                .values()
                .try_for_each(|item| inspect(item, depth + 1, nodes)),
            _ => Ok(()),
        }
    }
    inspect(value, 0, &mut 0)
}

pub(super) fn envelope(
    package: &RuntimePackageEnvelope,
    value: &Value,
) -> Result<(), RuntimePackageError> {
    if package.schema != DEEP_RUNTIME_PACKAGE_SCHEMA
        || ![
            DEEP_RUNTIME_PACKAGE_SCHEMA_VERSION,
            DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION,
            super::DEEP_RUNTIME_PACKAGE_CAMERA_VERSION,
            super::DEEP_RUNTIME_PACKAGE_CHART_VERSION,
            super::DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION,
            super::DEEP_RUNTIME_PACKAGE_EXPERIMENTAL_X_VERSION,
        ]
        .contains(&package.schema_version)
    {
        return fail("unsupported Deep Runtime Package schema or version");
    }
    let has_bindings = value.get("materialBindings").is_some();
    if has_bindings != (package.schema_version >= DEEP_RUNTIME_PACKAGE_SHADER_BINDINGS_VERSION) {
        return fail("materialBindings is required in runtime package v2 and forbidden in v1");
    }
    super::entrypoints::version(package, value)?;
    if !package_id(&package.package_id) || !semantic_version(&package.package_version) {
        return fail("invalid runtime package identifier or semantic version");
    }
    if !valid_hash(&package.package_hash) {
        return fail("runtime package hash must be lowercase SHA-256");
    }
    let root = value
        .as_object()
        .ok_or_else(|| RuntimePackageError("runtime package root must be an object".into()))?;
    let mut core = root.clone();
    core.remove("packageHash");
    if package.package_hash.value != hash_canonical(&Value::Object(core)) {
        return fail("runtime package hash mismatch");
    }
    let by_id = resource_index(package)?;
    validate_payloads(package, &by_id)?;
    super::entrypoints::validate_entrypoints(package, &by_id)
}

fn resource_index(
    package: &RuntimePackageEnvelope,
) -> Result<HashMap<&str, &RuntimeResourceIndexEntry>, RuntimePackageError> {
    if package.resources.len() < 2 || package.resources.len() > MAX_RESOURCES {
        return fail("runtime resource index must contain 2..=132 entries");
    }
    if package
        .resources
        .windows(2)
        .any(|pair| pair[0].id >= pair[1].id)
    {
        return fail("runtime resource index must be sorted by unique id");
    }
    let mut by_id = HashMap::new();
    for resource in &package.resources {
        if !resource_id(&resource.id)
            || resource.revision == 0
            || resource.revision > MAX_SAFE_INTEGER
            || !valid_hash(&resource.content_hash)
        {
            return fail("invalid runtime resource id, revision, or content hash");
        }
        by_id.insert(resource.id.as_str(), resource);
    }
    Ok(by_id)
}

fn validate_payloads(
    package: &RuntimePackageEnvelope,
    index: &HashMap<&str, &RuntimeResourceIndexEntry>,
) -> Result<(), RuntimePackageError> {
    if package.payloads.len() != index.len()
        || package
            .payloads
            .keys()
            .any(|id| !index.contains_key(id.as_str()))
    {
        return fail("runtime payload keys must exactly match the resource index");
    }
    for (id, payload) in &package.payloads {
        if index[id.as_str()].content_hash.value != hash_canonical(payload) {
            return fail(format!("runtime resource {id} content hash mismatch"));
        }
    }
    Ok(())
}

fn valid_hash(value: &super::RuntimeContentHash) -> bool {
    value.algorithm == "sha256"
        && value.value.len() == 64
        && value
            .value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(super) fn resource_id(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase() || byte.is_ascii_digit()
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._:/-".contains(&byte)
            }
        })
}

fn package_id(value: &str) -> bool {
    value.len() <= 128 && resource_id(value) && !value.contains('/') && !value.contains(':')
}

fn semantic_version(value: &str) -> bool {
    let (base, suffix) = value
        .split_once('-')
        .map_or((value, None), |pair| (pair.0, Some(pair.1)));
    let parts: Vec<_> = base.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && suffix.is_none_or(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
        })
}

pub fn runtime_package_sha256(value: &Value) -> Result<String, RuntimePackageError> {
    let mut root = value
        .as_object()
        .ok_or_else(|| RuntimePackageError("runtime package root must be an object".into()))?
        .clone();
    root.remove("packageHash");
    Ok(hash_canonical(&Value::Object(root)))
}

pub fn runtime_content_sha256(value: &Value) -> String {
    hash_canonical(value)
}
