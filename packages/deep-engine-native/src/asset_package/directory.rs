//! Directory profile v1: digest-only blobs, Runtime Package scene, explicit license evidence.
use super::*;
use crate::runtime_package::{
    LoadedRuntimePackage, parse_and_validate_runtime_package, read_runtime_package_bytes,
};
use crate::shader_package::hash::sha256;
use std::{collections::BTreeMap, fs, path::Path};
pub struct LoadedAssetDirectory {
    pub snapshot: Snapshot,
    pub manifest_hash: String,
    pub package_id: String,
    pub resource_order: Vec<String>,
    pub chunk_count: usize,
    pub chunk_bytes: u64,
    pub runtime: LoadedRuntimePackage,
}
pub struct Snapshot {
    pub manifest: Vec<u8>,
    pub chunks: Vec<(String, Vec<u8>)>,
}
pub fn load(path: &Path) -> Result<LoadedAssetDirectory, String> {
    let path = std::path::absolute(path).map_err(|_| "asset-directory/path")?;
    safe_path(&path)?;
    let is_manifest = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name == "manifest.json" || (cfg!(windows) && name.eq_ignore_ascii_case("manifest.json"))
        });
    if !is_manifest {
        return Err("asset-directory/expected-manifest-json".into());
    }
    let root = path.parent().ok_or("asset-directory/root")?;
    let bytes = read_runtime_package_bytes(&path).map_err(|e| e.to_string())?;
    let validated = parse(&bytes)?;
    let manifest_hash = sha256(&bytes);
    let package = validated.package;
    let mut chunks = BTreeMap::new();
    let mut total = 0u64;
    for blob in &package.blobs {
        total = total
            .checked_add(blob.byte_length)
            .ok_or("asset-directory/byte-budget")?;
        if total > 256 * 1024 * 1024 {
            return Err("asset-directory/byte-budget".into());
        }
        let path = root.join("blobs").join(&blob.hash);
        safe_path(&path)?;
        let data = read_runtime_package_bytes(path).map_err(|e| e.to_string())?;
        if data.len() as u64 != blob.byte_length || sha256(&data) != blob.hash {
            return Err("asset-directory/chunk-integrity".into());
        }
        chunks.insert(blob.hash.as_str(), data);
    }
    license::validate(&package, &chunks)?;
    let scene = package
        .manifest
        .resources
        .iter()
        .find(|resource| resource.id == package.manifest.entry_scene)
        .ok_or("asset-directory/scene")?;
    let blob = package
        .blobs
        .iter()
        .find(|blob| blob.hash == scene.blob_hash)
        .ok_or("asset-directory/scene-blob")?;
    if blob.media_type != "application/vnd.deep.runtime-package+json" {
        return Err("asset-directory/unsupported-scene-encoding".into());
    }
    let runtime = parse_and_validate_runtime_package(&chunks[scene.blob_hash.as_str()])
        .map_err(|e| e.to_string())?;
    Ok(LoadedAssetDirectory {
        snapshot: Snapshot {
            manifest: bytes,
            chunks: chunks
                .into_iter()
                .map(|(hash, data)| (hash.to_owned(), data))
                .collect(),
        },
        manifest_hash,
        package_id: package.manifest.package_id,
        resource_order: validated.resource_order,
        chunk_count: package.blobs.len(),
        chunk_bytes: total,
        runtime,
    })
}

pub(super) fn safe_path(path: &Path) -> Result<(), String> {
    use std::path::{Component, PathBuf};
    let mut current = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => return Err("asset-directory/traversal".into()),
            Component::Normal(name) if name.to_string_lossy().contains(':') => {
                return Err("asset-directory/alternate-stream".into());
            }
            #[cfg(windows)]
            Component::Prefix(prefix)
                if !matches!(
                    prefix.kind(),
                    std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)
                ) =>
            {
                return Err("asset-directory/nonlocal-path".into());
            }
            _ => {}
        }
        current.push(part);
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "asset-directory/missing-path")?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("asset-directory/reparse-path".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("asset-directory/symlink-path".into());
        }
    }
    Ok(())
}

#[path = "license.rs"]
mod license;
