use serde_json::Value;

use crate::shader_package::{
    DEEP_PBR_MESH_V1_ID, DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2_ID, DEEP_PBR_MESH_V2_SHA256,
    DEEP_SHADER_PACKAGE_SCHEMA_VERSION, DEEP_SHADER_TARGET_PROFILE, DeepShaderPackageV2,
    hash::hash_canonical, parse_and_validate_shader_package,
};

use super::types::{
    CacheIdentity, CacheIndexEntry, DEEP_SHADER_DISK_RECORD_SCHEMA,
    DEEP_SHADER_DISK_RECORD_SCHEMA_VERSION, DiskRecord, ShaderDiskCacheConfig,
    ShaderDiskCacheError, ShaderDiskCacheErrorCode, ShaderDiskCacheScope,
};

pub(crate) const MAX_INDEX_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const MAX_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const KEY_PREFIX: &str = "deep-shader-cache/v1/";

pub(crate) struct ValidatedPackage {
    pub package: DeepShaderPackageV2,
    pub value: Value,
    pub package_sha256: String,
    pub logical_key: String,
}

fn error(code: ShaderDiskCacheErrorCode, message: impl Into<String>) -> ShaderDiskCacheError {
    ShaderDiskCacheError::new(code, message)
}

pub(crate) fn validate_config(config: &ShaderDiskCacheConfig) -> Result<(), ShaderDiskCacheError> {
    if config.directory.as_os_str().is_empty()
        || !(1..=65_536).contains(&config.max_entries)
        || !(1..=1_073_741_824).contains(&config.max_bytes)
    {
        return Err(error(
            ShaderDiskCacheErrorCode::InvalidConfig,
            "cache directory and bounded maxEntries/maxBytes are required",
        ));
    }
    validate_scope(&config.scope)
}

pub(crate) fn validate_scope(scope: &ShaderDiskCacheScope) -> Result<(), ShaderDiskCacheError> {
    let namespace = scope.namespace.as_bytes();
    let namespace_valid = (1..=64).contains(&namespace.len())
        && namespace[0].is_ascii_lowercase()
        && namespace[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(byte)
        });
    let compiler_valid = (1..=64).contains(&scope.compiler_version.len())
        && scope.compiler_version.is_ascii()
        && scope
            .compiler_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte));
    let abi_hash = match scope.shader_abi_id.as_str() {
        DEEP_PBR_MESH_V1_ID => DEEP_PBR_MESH_V1_SHA256,
        DEEP_PBR_MESH_V2_ID => DEEP_PBR_MESH_V2_SHA256,
        _ => "",
    };
    if !namespace_valid
        || !compiler_valid
        || scope.package_schema_version != DEEP_SHADER_PACKAGE_SCHEMA_VERSION
        || scope.target_profile != DEEP_SHADER_TARGET_PROFILE
        || scope.shader_abi_hash != abi_hash
    {
        return Err(error(
            ShaderDiskCacheErrorCode::InvalidConfig,
            "shader cache scope is not a supported canonical v2 compiler/ABI identity",
        ));
    }
    Ok(())
}

pub(crate) fn validate_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn identity(
    scope: &ShaderDiskCacheScope,
    package_cache_key: &str,
) -> Result<CacheIdentity, ShaderDiskCacheError> {
    if !validate_hash(package_cache_key) {
        return Err(error(
            ShaderDiskCacheErrorCode::InvalidKey,
            "package cache key must be lowercase SHA-256",
        ));
    }
    Ok(CacheIdentity {
        scope: scope.clone(),
        package_cache_key: package_cache_key.to_owned(),
    })
}

pub(crate) fn logical_key(identity: &CacheIdentity) -> Result<String, ShaderDiskCacheError> {
    let value = serde_json::to_value(identity).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::Io,
            format!("cache identity serialization failed: {failure}"),
        )
    })?;
    Ok(format!("{KEY_PREFIX}{}", hash_canonical(&value)))
}

pub(crate) fn validate_logical_key(value: &str) -> bool {
    value.strip_prefix(KEY_PREFIX).is_some_and(validate_hash)
}

pub(crate) fn validate_package(
    bytes: &[u8],
    scope: &ShaderDiskCacheScope,
) -> Result<ValidatedPackage, ShaderDiskCacheError> {
    let package = parse_and_validate_shader_package(bytes).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::InvalidPackage,
            format!("shader package validation failed: {failure}"),
        )
    })?;
    if package.schema_version != scope.package_schema_version
        || package.target_profile != scope.target_profile
        || package.compiler_version != scope.compiler_version
        || package.shader_abi.id != scope.shader_abi_id
        || package.shader_abi.content_hash.value != scope.shader_abi_hash
    {
        return Err(error(
            ShaderDiskCacheErrorCode::ScopeMismatch,
            "shader package compiler, target, or ABI differs from cache scope",
        ));
    }
    let value = serde_json::to_value(&package).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::InvalidPackage,
            format!("shader package serialization failed: {failure}"),
        )
    })?;
    let package_sha256 = hash_canonical(&value);
    let identity = identity(scope, &package.package_cache_key)?;
    Ok(ValidatedPackage {
        package,
        value,
        package_sha256,
        logical_key: logical_key(&identity)?,
    })
}

pub(crate) fn encode_record(
    package: &ValidatedPackage,
    scope: &ShaderDiskCacheScope,
) -> Result<Vec<u8>, ShaderDiskCacheError> {
    let record = DiskRecord {
        schema: DEEP_SHADER_DISK_RECORD_SCHEMA.to_owned(),
        schema_version: DEEP_SHADER_DISK_RECORD_SCHEMA_VERSION,
        logical_key: package.logical_key.clone(),
        identity: identity(scope, &package.package.package_cache_key)?,
        package_sha256: package.package_sha256.clone(),
        package: package.value.clone(),
    };
    serde_json::to_vec(&record).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::Io,
            format!("shader cache record serialization failed: {failure}"),
        )
    })
}

pub(crate) fn decode_record(
    bytes: &[u8],
    scope: &ShaderDiskCacheScope,
    logical_key_expected: &str,
    entry: &CacheIndexEntry,
) -> Result<DeepShaderPackageV2, ShaderDiskCacheError> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::CorruptRecord,
            format!("shader cache record JSON is invalid: {failure}"),
        )
    })?;
    match raw.get("schemaVersion").and_then(Value::as_u64) {
        Some(version) if version != DEEP_SHADER_DISK_RECORD_SCHEMA_VERSION as u64 => {
            return Err(error(
                ShaderDiskCacheErrorCode::VersionUnsupported,
                "shader cache record version is unsupported",
            ));
        }
        None => {
            return Err(error(
                ShaderDiskCacheErrorCode::CorruptRecord,
                "shader cache record has no valid schema version",
            ));
        }
        Some(_) => {}
    }
    let record: DiskRecord = serde_json::from_value(raw).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::CorruptRecord,
            format!("shader cache record schema is invalid: {failure}"),
        )
    })?;
    if record.schema != DEEP_SHADER_DISK_RECORD_SCHEMA
        || record.logical_key != logical_key_expected
        || record.identity.scope != *scope
        || record.identity.package_cache_key != entry.package_cache_key
        || record.package_sha256 != entry.package_sha256
        || hash_canonical(&record.package) != record.package_sha256
    {
        return Err(error(
            ShaderDiskCacheErrorCode::CorruptRecord,
            "shader cache record identity, package SHA, or content differs from its index",
        ));
    }
    let package_bytes = serde_json::to_vec(&record.package).map_err(|failure| {
        error(
            ShaderDiskCacheErrorCode::CorruptRecord,
            format!("cached shader package serialization failed: {failure}"),
        )
    })?;
    let package = validate_package(&package_bytes, scope)?;
    if package.logical_key != logical_key_expected
        || package.package_sha256 != entry.package_sha256
        || package.package.package_cache_key != entry.package_cache_key
    {
        return Err(error(
            ShaderDiskCacheErrorCode::CorruptRecord,
            "cached package content-address identity does not match the index",
        ));
    }
    Ok(package.package)
}
