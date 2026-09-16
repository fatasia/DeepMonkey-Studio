//! Source-scoped snapshots; only a successfully presented package may commit.
use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, read_runtime_package_bytes, runtime_content_sha256,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
#[path = "runtime_lkg_retirement.rs"]
mod retirement;

#[derive(Clone)]
pub struct Store {
    root: PathBuf,
    source: String,
    key: String,
}
pub struct Pending {
    pub store: Store,
    pub bytes: Vec<u8>,
    pub hash: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u32,
    source: String,
    hash: String,
}

impl Store {
    pub fn local(source: &Path) -> Result<Self, String> {
        let root = std::env::var_os("LOCALAPPDATA").ok_or("lkg/local-app-data-unavailable")?;
        Self::new(
            PathBuf::from(root).join("DeepEngineNative/package-recovery"),
            source,
        )
    }

    pub fn new(root: PathBuf, source: &Path) -> Result<Self, String> {
        let absolute = std::path::absolute(source).map_err(|_| "lkg/source-path-invalid")?;
        // Do not resolve the file itself: a missing/replaced source must retain its key.
        check_components(&absolute)?;
        let source = absolute
            .to_str()
            .ok_or("lkg/source-path-unicode")?
            .to_lowercase();
        let key = runtime_content_sha256(&serde_json::json!(source));
        Ok(Self { root, source, key })
    }

    fn directory(&self) -> PathBuf {
        self.root.join(&self.key)
    }

    pub fn restore(&self) -> Result<Vec<u8>, String> {
        let hash = self.active_hash()?;
        let path = self.directory().join(format!("{hash}.json"));
        check_components(&path)?;
        let bytes = read_runtime_package_bytes(path).map_err(|_| "lkg/snapshot-read")?;
        let package =
            parse_and_validate_runtime_package(&bytes).map_err(|_| "lkg/snapshot-invalid")?;
        if package.package_hash != hash {
            return Err("lkg/snapshot-identity".into());
        }
        Ok(bytes)
    }

    fn active_hash(&self) -> Result<String, String> {
        let directory = self.directory();
        check_components(&directory)?;
        let path = directory.join("active.json");
        check_components(&path)?;
        let file = fs::File::open(path).map_err(|_| "lkg/index-unavailable")?;
        if !file.metadata().map_err(|_| "lkg/index-metadata")?.is_file() {
            return Err("lkg/index-not-file".into());
        }
        let mut bytes = Vec::new();
        file.take(16_385)
            .read_to_end(&mut bytes)
            .map_err(|_| "lkg/index-read")?;
        if bytes.len() > 16_384 {
            return Err("lkg/index-budget".into());
        }
        let index: Index = serde_json::from_slice(&bytes).map_err(|_| "lkg/index-invalid")?;
        if index.version != 1 || index.source != self.source || !valid_hash(&index.hash) {
            return Err("lkg/index-identity".into());
        }
        Ok(index.hash)
    }

    pub fn commit(&self, bytes: &[u8], hash: &str) -> Result<(), String> {
        if !valid_hash(hash) {
            return Err("lkg/hash-invalid".into());
        }
        let package =
            parse_and_validate_runtime_package(bytes).map_err(|_| "lkg/snapshot-invalid")?;
        if package.package_hash != hash {
            return Err("lkg/snapshot-identity".into());
        }
        let directory = self.directory();
        check_components(&directory)?;
        fs::create_dir_all(&directory).map_err(|_| "lkg/directory-write")?;
        check_components(&directory)?;
        let lock_path = directory.join("writer.lock");
        check_components(&lock_path)?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "lkg/lock-open")?;
        lock.try_lock().map_err(|_| "lkg/writer-busy")?;
        let previous = self.active_hash().ok();
        let snapshot = directory.join(format!("{hash}.json"));
        let reusable = retirement::verified_size(&snapshot, hash);
        retirement::budget(
            reusable,
            bytes.len() as u64,
            previous
                .as_deref()
                .filter(|old| *old != hash)
                .and_then(|old| {
                    retirement::verified_size(&directory.join(format!("{old}.json")), old)
                }),
        )?;
        if reusable.is_none() {
            atomic_write(&snapshot, bytes)?;
        }
        let index = serde_json::to_vec(&Index {
            version: 1,
            source: self.source.clone(),
            hash: hash.into(),
        })
        .map_err(|_| "lkg/index-encode")?;
        atomic_write(&directory.join("active.json"), &index)?;
        // The lock remains held; publication failure never reaches retirement.
        retirement::retire(self, hash, previous.as_deref());
        Ok(())
    }
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn check_components(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("lkg/path-not-absolute".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => return Err("lkg/parent-path-rejected".into()),
            Component::Normal(name) if name.to_string_lossy().contains(':') => {
                return Err("lkg/alternate-stream-rejected".into());
            }
            #[cfg(windows)]
            Component::Prefix(prefix)
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                ) =>
            {
                return Err("lkg/network-device-path-rejected".into());
            }
            _ => {}
        }
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err("lkg/reparse-path-rejected".into());
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err("lkg/symlink-path-rejected".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("lkg/path-unavailable".into()),
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    check_components(path)?;
    let temporary = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "lkg/temp-create")?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "lkg/temp-write")?;
        drop(file);
        check_components(path)?;
        fs::rename(&temporary, path).map_err(|_| "lkg/atomic-publish".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
#[path = "runtime_lkg_tests.rs"]
mod tests;
