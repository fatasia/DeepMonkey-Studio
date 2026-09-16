mod format;
mod index_format;
mod index_types;
mod io;
mod operations;
mod state_ops;
mod types;

use std::{
    collections::BTreeSet,
    fs::File,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use format::{MAX_INDEX_BYTES, MAX_RECORD_BYTES, decode_record, validate_config};
use index_format::decode_index;
use index_types::CacheState;

pub use types::{
    DEEP_SHADER_DISK_CACHE_SCHEMA, DEEP_SHADER_DISK_CACHE_SCHEMA_VERSION,
    DEEP_SHADER_DISK_RECORD_SCHEMA, DEEP_SHADER_DISK_RECORD_SCHEMA_VERSION,
    ShaderDiskCacheCancellation, ShaderDiskCacheConfig, ShaderDiskCacheError,
    ShaderDiskCacheErrorCode, ShaderDiskCacheScope, ShaderDiskCacheStartupDisposition,
    ShaderDiskCacheStats,
};

#[derive(Clone)]
pub struct ShaderDiskCache {
    pub(crate) inner: Arc<CacheInner>,
}

pub(crate) struct CacheInner {
    pub config: ShaderDiskCacheConfig,
    pub state: Mutex<CacheState>,
    pub _directory_lock: File,
    pub physical_record_writes: AtomicU64,
    pub coalesced_writes: AtomicU64,
}

impl ShaderDiskCache {
    /// Explicitly opens and validates the complete reachable cache. Importing the crate does no I/O.
    pub fn open(config: ShaderDiskCacheConfig) -> Result<Self, ShaderDiskCacheError> {
        validate_config(&config)?;
        io::ensure_directory(&config.directory)?;
        let directory_lock = io::acquire_lock(&config.directory)?;
        let state = load_state(&config)?;
        let cache = Self {
            inner: Arc::new(CacheInner {
                config,
                state: Mutex::new(state),
                _directory_lock: directory_lock,
                physical_record_writes: AtomicU64::new(0),
                coalesced_writes: AtomicU64::new(0),
            }),
        };
        cache.cleanup(None)?;
        cache.enforce_limits()?;
        Ok(cache)
    }

    /// Opens a validated snapshot or rebuilds only when every owned snapshot is corrupt.
    /// Compatibility, locking, permission and capacity errors remain fatal and untouched.
    pub fn open_for_startup(
        config: ShaderDiskCacheConfig,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<(Self, ShaderDiskCacheStartupDisposition), ShaderDiskCacheError> {
        match Self::open(config.clone()) {
            Ok(cache) => Ok((cache, ShaderDiskCacheStartupDisposition::Opened)),
            Err(error)
                if matches!(
                    error.code,
                    ShaderDiskCacheErrorCode::CorruptIndex
                        | ShaderDiskCacheErrorCode::CorruptRecord
                ) =>
            {
                let disposition = match error.code {
                    ShaderDiskCacheErrorCode::CorruptIndex => {
                        ShaderDiskCacheStartupDisposition::RebuiltCorruptIndex
                    }
                    ShaderDiskCacheErrorCode::CorruptRecord => {
                        ShaderDiskCacheStartupDisposition::RebuiltCorruptRecord
                    }
                    _ => unreachable!("guarded corrupt-cache error"),
                };
                Self::rebuild(config, cancellation).map(|cache| (cache, disposition))
            }
            Err(error) => Err(error),
        }
    }

    /// Removes only files owned by this cache format, then creates an empty cache.
    pub fn rebuild(
        config: ShaderDiskCacheConfig,
        cancellation: Option<&ShaderDiskCacheCancellation>,
    ) -> Result<Self, ShaderDiskCacheError> {
        validate_config(&config)?;
        io::ensure_directory(&config.directory)?;
        let directory_lock = io::acquire_lock(&config.directory)?;
        for (name, path) in io::list_files(&config.directory)? {
            io::check_cancel(cancellation)?;
            if io::owned_file(&name) {
                io::remove_file(&path)?;
            }
        }
        io::check_cancel(cancellation)?;
        Ok(Self {
            inner: Arc::new(CacheInner {
                config,
                state: Mutex::new(CacheState::empty()),
                _directory_lock: directory_lock,
                physical_record_writes: AtomicU64::new(0),
                coalesced_writes: AtomicU64::new(0),
            }),
        })
    }

    pub fn stats(&self) -> Result<ShaderDiskCacheStats, ShaderDiskCacheError> {
        let state = self.inner.state.lock().map_err(|_| {
            ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::LockPoisoned,
                "shader disk cache state lock is poisoned",
            )
        })?;
        Ok(ShaderDiskCacheStats {
            entries: state.entries.len(),
            bytes: state.total_bytes,
            generation: state.generation,
            access_sequence: state.access_sequence,
            physical_record_writes: self.inner.physical_record_writes.load(Ordering::Acquire),
            coalesced_writes: self.inner.coalesced_writes.load(Ordering::Acquire),
        })
    }
}

fn load_state(config: &ShaderDiskCacheConfig) -> Result<CacheState, ShaderDiskCacheError> {
    let candidates = io::discover_index_candidates(&config.directory)?;
    if candidates.is_empty() {
        return Ok(CacheState::empty());
    }
    if candidates
        .windows(2)
        .any(|pair| pair[0].generation == pair[1].generation)
    {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptIndex,
            "multiple cache indexes claim the same generation",
        ));
    }
    let mut selected = None;
    let mut newest_failure = None;
    for candidate in candidates.iter().rev() {
        match load_candidate(config, candidate) {
            Ok(candidate_state) if selected.is_none() => selected = Some(candidate_state),
            Ok(fallback) => {
                let selected = selected.as_mut().expect("selected cache state");
                selected.fallback_index_file = fallback.active_index_file;
                selected.fallback_record_files = fallback
                    .entries
                    .values()
                    .map(|entry| entry.record_file.clone())
                    .collect();
                break;
            }
            Err(_) if selected.is_some() => continue,
            Err(error) if strict_open_error(error.code) => return Err(error),
            Err(error) => {
                if newest_failure.is_none() {
                    newest_failure = Some(error);
                }
            }
        }
    }
    if let Some(state) = selected {
        Ok(state)
    } else {
        Err(newest_failure.unwrap_or_else(|| {
            ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptIndex,
                "shader cache has no recoverable index generation",
            )
        }))
    }
}

fn load_candidate(
    config: &ShaderDiskCacheConfig,
    candidate: &io::IndexCandidate,
) -> Result<CacheState, ShaderDiskCacheError> {
    let bytes = io::read_owned_file(
        &config.directory.join(&candidate.file_name),
        MAX_INDEX_BYTES,
        None,
    )
    .map_err(as_corrupt_index)?;
    let index = decode_index(&bytes)?;
    if index.generation != candidate.generation {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptIndex,
            "cache index filename generation differs from its content",
        ));
    }
    if index.scope != config.scope {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::ScopeMismatch,
            "cache directory belongs to a different shader compiler/ABI scope",
        ));
    }
    for (key, entry) in &index.entries {
        let path = config.directory.join(&entry.record_file);
        let record =
            io::read_owned_file(&path, MAX_RECORD_BYTES, None).map_err(as_corrupt_record)?;
        if record.len() as u64 != entry.byte_length {
            return Err(ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptRecord,
                "cache record byte length differs from its index",
            ));
        }
        decode_record(&record, &config.scope, key, entry)?;
    }
    Ok(CacheState {
        generation: index.generation,
        active_index_file: Some(candidate.file_name.clone()),
        fallback_index_file: None,
        fallback_record_files: BTreeSet::new(),
        access_sequence: index.access_sequence,
        total_bytes: index.total_bytes,
        entries: index.entries,
        dirty_access: false,
    })
}

fn strict_open_error(code: ShaderDiskCacheErrorCode) -> bool {
    matches!(
        code,
        ShaderDiskCacheErrorCode::VersionUnsupported
            | ShaderDiskCacheErrorCode::ScopeMismatch
            | ShaderDiskCacheErrorCode::PermissionDenied
            | ShaderDiskCacheErrorCode::DiskFull
    )
}

fn as_corrupt_index(error: ShaderDiskCacheError) -> ShaderDiskCacheError {
    match error.code {
        ShaderDiskCacheErrorCode::PermissionDenied | ShaderDiskCacheErrorCode::DiskFull => error,
        _ => ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptIndex,
            format!("cache index cannot be read safely: {}", error.message),
        ),
    }
}

fn as_corrupt_record(error: ShaderDiskCacheError) -> ShaderDiskCacheError {
    match error.code {
        ShaderDiskCacheErrorCode::PermissionDenied | ShaderDiskCacheErrorCode::DiskFull => error,
        _ => ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptRecord,
            format!("cache record cannot be read safely: {}", error.message),
        ),
    }
}

#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
