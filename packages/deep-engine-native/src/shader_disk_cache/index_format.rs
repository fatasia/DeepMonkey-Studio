use std::collections::HashSet;

use serde_json::Value;

use crate::shader_package::hash::hash_canonical;

use super::{
    format::{MAX_RECORD_BYTES, identity, logical_key, validate_hash, validate_logical_key},
    index_types::CacheIndex,
    types::{
        DEEP_SHADER_DISK_CACHE_SCHEMA, DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION, ShaderDiskCacheError,
        ShaderDiskCacheErrorCode,
    },
};

fn error(code: ShaderDiskCacheErrorCode, message: impl Into<String>) -> ShaderDiskCacheError {
    ShaderDiskCacheError::new(code, message)
}

pub(crate) fn encode_index(index: &mut CacheIndex) -> Result<Vec<u8>, ShaderDiskCacheError> {
    index.index_sha256.clear();
    let mut value = serde_json::to_value(&*index).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::Io,
            format!("shader cache index serialization failed: {failure}"),
        )
    })?;
    value
        .as_object_mut()
        .expect("cache index serializes as an object")
        .remove("indexSha256");
    index.index_sha256 = hash_canonical(&value);
    serde_json::to_vec(index).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::Io,
            format!("shader cache index serialization failed: {failure}"),
        )
    })
}

pub(crate) fn decode_index(bytes: &[u8]) -> Result<CacheIndex, ShaderDiskCacheError> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::CorruptIndex,
            format!("shader cache index JSON is invalid: {failure}"),
        )
    })?;
    match raw.get("schemaVersion").and_then(Value::as_u64) {
        Some(version) if version != DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION as u64 => {
            return Err(error(
                ShaderDiskCacheErrorCode::VersionUnsupported,
                "shader cache index version is unsupported",
            ));
        }
        None => {
            return Err(error(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache index has no valid schema version",
            ));
        }
        Some(_) => {}
    }
    let index: CacheIndex = serde_json::from_value(raw).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::CorruptIndex,
            format!("shader cache index schema is invalid: {failure}"),
        )
    })?;
    let mut core = serde_json::to_value(&index).expect("cache index serialization");
    core.as_object_mut()
        .expect("cache index object")
        .remove("indexSha256");
    if index.schema != DEEP_SHADER_DISK_CACHE_SCHEMA
        || !validate_hash(&index.index_sha256)
        || index.index_sha256 != hash_canonical(&core)
    {
        return Err(error(
            ShaderDiskCacheErrorCode::CorruptIndex,
            "shader cache index schema or SHA-256 is invalid",
        ));
    }
    validate_entries(&index)?;
    Ok(index)
}

fn validate_entries(index: &CacheIndex) -> Result<(), ShaderDiskCacheError> {
    let mut total = 0_u64;
    let mut sequences = HashSet::new();
    let mut files = HashSet::new();
    for (key, entry) in &index.entries {
        total = total.checked_add(entry.byte_length).ok_or_else(|| {
            error(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache byte accounting overflowed",
            )
        })?;
        let expected = logical_key(&identity(&index.scope, &entry.package_cache_key)?)?;
        if key != &expected
            || !validate_logical_key(key)
            || !validate_hash(&entry.package_sha256)
            || entry.byte_length == 0
            || entry.byte_length > MAX_RECORD_BYTES
            || entry.access_sequence == 0
            || entry.access_sequence > index.access_sequence
            || !sequences.insert(entry.access_sequence)
            || !files.insert(entry.record_file.as_str())
            || !super::io::valid_record_file_name(&entry.record_file)
        {
            return Err(error(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache index contains an invalid or duplicate record identity",
            ));
        }
    }
    if total != index.total_bytes {
        return Err(error(
            ShaderDiskCacheErrorCode::CorruptIndex,
            "shader cache index byte accounting is inconsistent",
        ));
    }
    Ok(())
}
