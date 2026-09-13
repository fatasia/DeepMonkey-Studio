use std::{
    fmt,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEEP_SHADER_DISK_CACHE_SCHEMA: &str = "deep.shader-disk-cache";
pub const DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION: u32 = 1;
pub const DEEP_SHADER_DISK_RECORD_SCHEMA: &str = "deep.shader-disk-cache-record";
pub const DEEP_SHADER_DISK_RECORD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ShaderDiskCacheScope {
    pub namespace: String,
    pub package_schema_version: u32,
    pub target_profile: String,
    pub compiler_version: String,
    pub shader_abi_id: String,
    pub shader_abi_hash: String,
}

#[derive(Debug, Clone)]
pub struct ShaderDiskCacheConfig {
    pub directory: PathBuf,
    pub scope: ShaderDiskCacheScope,
    pub max_entries: usize,
    pub max_bytes: u64,
}

impl ShaderDiskCacheConfig {
    pub fn new(directory: impl Into<PathBuf>, scope: ShaderDiskCacheScope) -> Self {
        Self {
            directory: directory.into(),
            scope,
            max_entries: 64,
            max_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ShaderDiskCacheCancellation(Arc<AtomicBool>);

impl ShaderDiskCacheCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShaderDiskCacheErrorCode {
    InvalidConfig,
    InvalidKey,
    InvalidPackage,
    ScopeMismatch,
    VersionUnsupported,
    CorruptIndex,
    CorruptRecord,
    CapacityExceeded,
    PermissionDenied,
    DiskFull,
    Cancelled,
    CacheBusy,
    Io,
    LockPoisoned,
}

impl ShaderDiskCacheErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalid-config",
            Self::InvalidKey => "invalid-key",
            Self::InvalidPackage => "invalid-package",
            Self::ScopeMismatch => "scope-mismatch",
            Self::VersionUnsupported => "version-unsupported",
            Self::CorruptIndex => "corrupt-index",
            Self::CorruptRecord => "corrupt-record",
            Self::CapacityExceeded => "capacity-exceeded",
            Self::PermissionDenied => "permission-denied",
            Self::DiskFull => "disk-full",
            Self::Cancelled => "cancelled",
            Self::CacheBusy => "cache-busy",
            Self::Io => "io",
            Self::LockPoisoned => "lock-poisoned",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShaderDiskCacheError {
    pub code: ShaderDiskCacheErrorCode,
    pub message: String,
}

impl ShaderDiskCacheError {
    pub(crate) fn new(code: ShaderDiskCacheErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for ShaderDiskCacheError {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(output, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for ShaderDiskCacheError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShaderDiskCacheStats {
    pub entries: usize,
    pub bytes: u64,
    pub generation: u64,
    pub access_sequence: u64,
    pub physical_record_writes: u64,
    pub coalesced_writes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CacheIdentity {
    #[serde(flatten)]
    pub scope: ShaderDiskCacheScope,
    pub package_cache_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct DiskRecord {
    pub schema: String,
    pub schema_version: u32,
    pub logical_key: String,
    pub identity: CacheIdentity,
    pub package_sha256: String,
    pub package: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct CacheIndexEntry {
    pub record_file: String,
    pub byte_length: u64,
    pub access_sequence: u64,
    pub package_cache_key: String,
    pub package_sha256: String,
}
