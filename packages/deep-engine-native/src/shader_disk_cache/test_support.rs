use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::AtomicU64,
    time::{SystemTime, UNIX_EPOCH},
};

use super::{ShaderDiskCacheConfig, ShaderDiskCacheScope, io::owned_file};
use crate::shader_package::{DEEP_PBR_MESH_V1_ID, DEEP_PBR_MESH_V1_SHA256};

pub(crate) const PACKAGE_A: &[u8] =
    include_bytes!("../../tests/fixtures/deep_shader_package_v2.json");
pub(crate) const PACKAGE_B: &[u8] =
    include_bytes!("../../tests/fixtures/deep_shader_package_gpu_v2.json");
static DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(1);

pub(crate) struct TestDirectory(pub(crate) PathBuf);

impl TestDirectory {
    pub(crate) fn new(name: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let sequence = DIRECTORY_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "deep-shader-cache-{name}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("test directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub(crate) fn scope() -> ShaderDiskCacheScope {
    ShaderDiskCacheScope {
        namespace: "deep.native.tests".into(),
        package_schema_version: 2,
        target_profile: "webgpu-wgsl-pipeline-2".into(),
        compiler_version: "0.2.0".into(),
        shader_abi_id: DEEP_PBR_MESH_V1_ID.into(),
        shader_abi_hash: DEEP_PBR_MESH_V1_SHA256.into(),
    }
}

pub(crate) fn config(path: &Path) -> ShaderDiskCacheConfig {
    ShaderDiskCacheConfig::new(path, scope())
}

pub(crate) fn package_key(bytes: &[u8]) -> String {
    crate::shader_package::parse_and_validate_shader_package(bytes)
        .expect("valid fixture")
        .package_cache_key
}

pub(crate) fn owned_names(path: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(path)
        .expect("list test cache")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| owned_file(name))
        .collect();
    names.sort();
    names
}
