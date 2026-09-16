//! Source-scoped complete directory recovery. Index publication follows verified GPU present.
use super::{
    directory::{self, LoadedAssetDirectory, Snapshot},
    names::hash,
};
use crate::shader_package::hash::sha256;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
#[path = "recovery_retirement.rs"]
mod retirement;

pub struct Pending {
    store: Store,
    snapshot: Snapshot,
    manifest_hash: String,
}
struct Store {
    directory: PathBuf,
    source: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u32,
    source: String,
    snapshot: String,
    manifest_hash: String,
}
pub struct Startup {
    pub loaded: LoadedAssetDirectory,
    pub pending: Option<Pending>,
    pub notice: Option<String>,
}

pub fn load_auto(path: &Path) -> Result<Startup, String> {
    let store = Store::local(path);
    match directory::load(path) {
        Ok(mut loaded) => {
            let mut notice = None;
            let pending = match store {
                Ok(store) => Some(Pending {
                    store,
                    manifest_hash: loaded.manifest_hash.clone(),
                    snapshot: std::mem::replace(
                        &mut loaded.snapshot,
                        Snapshot {
                            manifest: vec![],
                            chunks: vec![],
                        },
                    ),
                }),
                Err(error) => {
                    notice = Some(format!("asset recovery unavailable: {error}"));
                    None
                }
            };
            Ok(Startup {
                loaded,
                pending,
                notice,
            })
        }
        Err(primary) => {
            let store = store.map_err(|error| format!("{primary}; {error}"))?;
            let (_, loaded) = store
                .restore()
                .map_err(|error| format!("{primary}; {error}"))?;
            println!(
                "Deep Asset Package recovery: active=last-known-good manifest_hash={} primary_rejection={primary}",
                loaded.manifest_hash
            );
            Ok(Startup {
                loaded,
                pending: None,
                notice: Some("asset package recovered last-known-good; source rejected".into()),
            })
        }
    }
}

impl Store {
    fn local(path: &Path) -> Result<Self, String> {
        let source = std::path::absolute(path).map_err(|_| "asset-lkg/source-path")?;
        let is_manifest = source
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name == "manifest.json"
                    || (cfg!(windows) && name.eq_ignore_ascii_case("manifest.json"))
            });
        if !is_manifest {
            return Err("asset-lkg/source-name".into());
        }
        directory::safe_path(source.parent().ok_or("asset-lkg/source-parent")?)?;
        if source.exists() {
            directory::safe_path(&source)?;
        }
        let source = source
            .to_str()
            .ok_or("asset-lkg/source-unicode")?
            .to_lowercase();
        let root =
            PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("asset-lkg/local-app-data")?);
        if !root.is_absolute()
            || root
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("asset-lkg/cache-root".into());
        }
        Ok(Self {
            directory: root
                .join("DeepEngineNative/asset-recovery")
                .join(sha256(source.as_bytes())),
            source,
        })
    }
    fn index(&self) -> Result<Index, String> {
        let path = self.directory.join("active.json");
        directory::safe_path(&path)?;
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|_| "asset-lkg/index-open")?
            .take(16_385)
            .read_to_end(&mut bytes)
            .map_err(|_| "asset-lkg/index-read")?;
        if bytes.len() > 16_384 {
            return Err("asset-lkg/index-budget".into());
        }
        let index: Index = serde_json::from_slice(&bytes).map_err(|_| "asset-lkg/index-schema")?;
        if index.version != 1
            || index.source != self.source
            || !hash(&index.manifest_hash)
            || !snapshot_name(&index.snapshot)
            || !index.snapshot.starts_with(&index.manifest_hash)
        {
            return Err("asset-lkg/index-identity".into());
        }
        Ok(index)
    }
    fn restore(&self) -> Result<(Index, LoadedAssetDirectory), String> {
        let index = self.index()?;
        let loaded = directory::load(&self.directory.join(&index.snapshot).join("manifest.json"))?;
        if loaded.manifest_hash != index.manifest_hash {
            return Err("asset-lkg/manifest-integrity".into());
        }
        Ok((index, loaded))
    }
}

impl Pending {
    pub fn commit(self) -> Result<(), String> {
        // Validate the closest existing ancestor before creating owned cache directories.
        let ancestor = self
            .store
            .directory
            .ancestors()
            .find(|path| path.exists())
            .ok_or("asset-lkg/cache-parent")?;
        directory::safe_path(ancestor)?;
        fs::create_dir_all(&self.store.directory).map_err(|_| "asset-lkg/cache-create")?;
        directory::safe_path(&self.store.directory)?;
        let lock_path = self.store.directory.join("writer.lock");
        if lock_path.exists() {
            directory::safe_path(&lock_path)?;
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|_| "asset-lkg/lock-open")?;
        lock.try_lock().map_err(|_| "asset-lkg/writer-busy")?;
        let previous = self.store.index().ok();
        if let Ok((active, loaded)) = self.store.restore()
            && loaded.manifest_hash == self.manifest_hash
        {
            retirement::retire(&self.store, &active.snapshot, None);
            return Ok(());
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "asset-lkg/clock")?
            .as_nanos();
        let name = format!("{}-{nonce:032x}", self.manifest_hash);
        let target = self.store.directory.join(&name);
        fs::create_dir(&target).map_err(|_| "asset-lkg/snapshot-create")?;
        let mut staged = retirement::Staged {
            target: &target,
            snapshot: &self.snapshot,
            published: false,
        };
        fs::create_dir(target.join("blobs")).map_err(|_| "asset-lkg/chunk-directory")?;
        write_new(&target.join("manifest.json"), &self.snapshot.manifest)?;
        for (hash, bytes) in &self.snapshot.chunks {
            if !super::names::hash(hash) {
                return Err("asset-lkg/chunk-name".into());
            }
            write_new(&target.join("blobs").join(hash), bytes)?;
        }
        let loaded = directory::load(&target.join("manifest.json"))?;
        if loaded.manifest_hash != self.manifest_hash {
            return Err("asset-lkg/staged-identity".into());
        }
        let bytes = serde_json::to_vec(&Index {
            version: 1,
            source: self.store.source.clone(),
            snapshot: name.clone(),
            manifest_hash: self.manifest_hash,
        })
        .map_err(|_| "asset-lkg/index-encode")?;
        let temporary = self.store.directory.join(format!("index-{nonce:032x}.tmp"));
        write_new(&temporary, &bytes)?;
        let active = self.store.directory.join("active.json");
        if active.exists() {
            directory::safe_path(&active)?;
        }
        if fs::rename(&temporary, active).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err("asset-lkg/index-publish".into());
        }
        staged.published = true;
        retirement::retire(
            &self.store,
            &name,
            previous.as_ref().map(|old| old.snapshot.as_str()),
        );
        Ok(())
    }
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    directory::safe_path(path.parent().ok_or("asset-lkg/write-parent")?)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "asset-lkg/file-create")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "asset-lkg/file-write".into())
}
fn snapshot_name(name: &str) -> bool {
    name.is_ascii()
        && name.len() == 97
        && hash(&name[..64])
        && name.as_bytes()[64] == b'-'
        && name.as_bytes()[65..]
            .iter()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
