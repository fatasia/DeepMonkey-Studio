use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use super::types::{ShaderDiskCacheCancellation, ShaderDiskCacheError, ShaderDiskCacheErrorCode};

static FILE_NONCE: AtomicU64 = AtomicU64::new(1);
const TEMP_PREFIX: &str = ".deep-shader-cache-tmp-";
const LOCK_FILE_NAME: &str = ".deep-shader-cache.lock";

#[derive(Debug)]
pub(crate) struct IndexCandidate {
    pub file_name: String,
    pub generation: u64,
}

pub(crate) fn acquire_lock(directory: &Path) -> Result<File, ShaderDiskCacheError> {
    let lock_path = directory.join(LOCK_FILE_NAME);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|error| classify_io(&error, "open shader cache lock"))?;
    file.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CacheBusy,
            "shader cache directory is already open by another instance",
        ),
        TryLockError::Error(error) => classify_io(&error, "lock shader cache directory"),
    })?;
    Ok(file)
}

pub(crate) fn check_cancel(
    cancellation: Option<&ShaderDiskCacheCancellation>,
) -> Result<(), ShaderDiskCacheError> {
    if cancellation.is_some_and(ShaderDiskCacheCancellation::is_cancelled) {
        Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::Cancelled,
            "shader disk cache operation was cancelled before its commit point",
        ))
    } else {
        Ok(())
    }
}

pub(crate) fn classify_io(error: &std::io::Error, action: &str) -> ShaderDiskCacheError {
    let raw = error.raw_os_error();
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        ShaderDiskCacheErrorCode::PermissionDenied
    } else if matches!(raw, Some(28 | 39 | 112 | 122)) {
        ShaderDiskCacheErrorCode::DiskFull
    } else {
        ShaderDiskCacheErrorCode::Io
    };
    ShaderDiskCacheError::new(code, format!("{action}: {error}"))
}

pub(crate) fn ensure_directory(directory: &Path) -> Result<(), ShaderDiskCacheError> {
    fs::create_dir_all(directory).map_err(|error| classify_io(&error, "create cache directory"))?;
    let metadata =
        fs::metadata(directory).map_err(|error| classify_io(&error, "inspect cache directory"))?;
    if !metadata.is_dir() {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::InvalidConfig,
            "shader cache path is not a directory",
        ));
    }
    Ok(())
}

pub(crate) fn read_owned_file(
    path: &Path,
    max_bytes: u64,
    cancellation: Option<&ShaderDiskCacheCancellation>,
) -> Result<Vec<u8>, ShaderDiskCacheError> {
    check_cancel(cancellation)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| classify_io(&error, "inspect cache file"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptRecord,
            "cache file is not a bounded regular file",
        ));
    }
    let mut file = File::open(path).map_err(|error| classify_io(&error, "open cache file"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        check_cancel(cancellation)?;
        let read = file
            .read(&mut buffer)
            .map_err(|error| classify_io(&error, "read cache file"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() as u64 > max_bytes {
            return Err(ShaderDiskCacheError::new(
                ShaderDiskCacheErrorCode::CorruptRecord,
                "cache file exceeded its byte budget while reading",
            ));
        }
    }
    if bytes.len() as u64 != metadata.len() {
        return Err(ShaderDiskCacheError::new(
            ShaderDiskCacheErrorCode::CorruptRecord,
            "cache file changed while it was being read",
        ));
    }
    Ok(bytes)
}

pub(crate) fn atomic_write(
    directory: &Path,
    final_name: &str,
    bytes: &[u8],
    cancellation: Option<&ShaderDiskCacheCancellation>,
) -> Result<(), ShaderDiskCacheError> {
    check_cancel(cancellation)?;
    let temporary = directory.join(format!("{TEMP_PREFIX}{}", unique_suffix()));
    let destination = directory.join(final_name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| classify_io(&error, "create cache temporary file"))?;
        for chunk in bytes.chunks(64 * 1024) {
            check_cancel(cancellation)?;
            file.write_all(chunk)
                .map_err(|error| classify_io(&error, "write cache temporary file"))?;
        }
        file.flush()
            .map_err(|error| classify_io(&error, "flush cache temporary file"))?;
        file.sync_all()
            .map_err(|error| classify_io(&error, "sync cache temporary file"))?;
        drop(file);
        check_cancel(cancellation)?;
        fs::hard_link(&temporary, &destination)
            .map_err(|error| classify_io(&error, "atomically publish cache file"))?;
        let _ = fs::remove_file(&temporary);
        if let Err(error) = sync_directory(directory) {
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
fn sync_directory(directory: &Path) -> Result<(), ShaderDiskCacheError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|error| classify_io(&error, "sync cache directory"))
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) -> Result<(), ShaderDiskCacheError> {
    // The immutable-name hard-link publish is atomic and no-clobber on Windows;
    // the file itself was sync_all'ed above. A directory fsync is not portable.
    Ok(())
}

pub(crate) fn discover_index_candidates(
    directory: &Path,
) -> Result<Vec<IndexCandidate>, ShaderDiskCacheError> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| classify_io(&error, "list shader cache directory"))?
    {
        let entry = entry.map_err(|error| classify_io(&error, "read shader cache directory"))?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if let Some(generation) = parse_index_file_name(&name) {
            candidates.push(IndexCandidate {
                file_name: name,
                generation,
            });
        }
    }
    candidates.sort_by(|a, b| (a.generation, &a.file_name).cmp(&(b.generation, &b.file_name)));
    Ok(candidates)
}

pub(crate) fn index_file_name(generation: u64) -> String {
    format!("index-{generation:020}-{}.json", unique_suffix())
}

pub(crate) fn record_file_name(logical_key: &str, package_sha256: &str, generation: u64) -> String {
    let key_hash = logical_key
        .rsplit('/')
        .next()
        .expect("validated logical key");
    format!(
        "record-{key_hash}-{package_sha256}-{generation:020}-{}.json",
        unique_suffix()
    )
}

pub(crate) fn valid_record_file_name(value: &str) -> bool {
    let Some(core) = value
        .strip_prefix("record-")
        .and_then(|value| value.strip_suffix(".json"))
    else {
        return false;
    };
    let mut parts = core.splitn(4, '-');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some(key), Some(package), Some(generation), Some(suffix))
            if hash(key) && hash(package) && decimal(generation, 20) && safe_suffix(suffix)
    )
}

pub(crate) fn owned_file(value: &str) -> bool {
    parse_index_file_name(value).is_some()
        || valid_record_file_name(value)
        || value.starts_with(TEMP_PREFIX)
}

pub(crate) fn remove_file(path: &Path) -> Result<(), ShaderDiskCacheError> {
    fs::remove_file(path).map_err(|error| classify_io(&error, "remove stale cache file"))
}

pub(crate) fn list_files(directory: &Path) -> Result<Vec<(String, PathBuf)>, ShaderDiskCacheError> {
    let mut files = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| classify_io(&error, "list shader cache directory"))?
    {
        let entry = entry.map_err(|error| classify_io(&error, "read shader cache directory"))?;
        if let Some(name) = entry.file_name().to_str().map(str::to_owned) {
            files.push((name, entry.path()));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn parse_index_file_name(value: &str) -> Option<u64> {
    let core = value.strip_prefix("index-")?.strip_suffix(".json")?;
    let (generation, suffix) = core.split_once('-')?;
    (decimal(generation, 20) && safe_suffix(suffix))
        .then(|| generation.parse().ok())
        .flatten()
}

fn unique_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    format!(
        "{}-{nanos}-{}",
        std::process::id(),
        FILE_NONCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn decimal(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn safe_suffix(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'-')
}
