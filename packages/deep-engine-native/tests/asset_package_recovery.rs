use std::{fs, path::PathBuf, process::Command};
struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("asset-recovery-{}-{nonce}", std::process::id()));
        fs::create_dir_all(root.join("source/blobs")).unwrap();
        let fixture =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/asset-directory-v1");
        fs::copy(
            fixture.join("manifest.json"),
            root.join("source/manifest.json"),
        )
        .unwrap();
        for entry in fs::read_dir(fixture.join("blobs")).unwrap() {
            let entry = entry.unwrap();
            fs::copy(
                entry.path(),
                root.join("source/blobs").join(entry.file_name()),
            )
            .unwrap();
        }
        Self(root)
    }
    fn run(&self, mode: &str, source: &str) -> (bool, String) {
        let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
            .arg(mode)
            .arg(self.0.join(source).join("manifest.json"))
            .env("LOCALAPPDATA", self.0.join("local"))
            .output()
            .unwrap();
        (
            output.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ),
        )
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn preflight_never_publishes_asset_recovery_state() {
    let folder = Sandbox::new();
    let (ok, text) = folder.run("--headless-asset-package", "source");
    assert!(ok, "{text}");
    assert!(!folder.0.join("local").exists());
    fs::write(folder.0.join("source/manifest.json"), b"broken").unwrap();
    assert!(!folder.run("--headless-asset-package", "source").0);
}
#[test]
#[ignore = "requires real Windows GPU"]
fn complete_asset_snapshot_recovers_manifest_and_chunk_corruption_across_processes() {
    let folder = Sandbox::new();
    let source_manifest = folder.0.join("source/manifest.json");
    let bytes = fs::read(&source_manifest).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let (ok, first) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{first}");
    assert!(first.contains("asset recovery checkpoint committed after present"));
    fs::write(&source_manifest, b"broken").unwrap();
    let (ok, second) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{second}");
    assert!(second.contains("active=last-known-good"));
    assert!(second.contains("scopes=clean callbacks=clean"));
    fs::write(&source_manifest, &bytes).unwrap();
    let chunk = manifest["blobs"][0]["hash"].as_str().unwrap();
    fs::write(folder.0.join("source/blobs").join(chunk), b"broken chunk").unwrap();
    let (ok, third) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{third}");
    assert!(third.contains("active=last-known-good"));
    assert!(third.contains("chunk-integrity"));
    fs::create_dir(folder.0.join("other")).unwrap();
    fs::write(folder.0.join("other/manifest.json"), b"broken").unwrap();
    assert!(!folder.run("--headless-asset-package", "other").0);
    let source_cache = fs::read_dir(folder.0.join("local/DeepEngineNative/asset-recovery"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let index_path = source_cache.join("active.json");
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    let cached = source_cache.join(index["snapshot"].as_str().unwrap());
    let license = manifest["blobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|blob| blob["mediaType"] == "text/plain")
        .unwrap()["hash"]
        .as_str()
        .unwrap();
    fs::write(cached.join("blobs").join(license), b"tampered license").unwrap();
    assert!(!folder.run("--headless-asset-package", "source").0);
    index["snapshot"] = serde_json::json!(format!("{}é{}", "a".repeat(63), "b".repeat(32)));
    fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
    let (ok, bad) = folder.run("--headless-asset-package", "source");
    assert!(!ok);
    assert!(bad.contains("index-identity"));
}
#[test]
#[ignore = "requires real Windows GPU"]
fn failed_asset_cache_write_preserves_successful_player() {
    let folder = Sandbox::new();
    fs::write(folder.0.join("local"), b"not a directory").unwrap();
    let (ok, text) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{text}");
    assert!(text.contains("checkpoint failed; current scene retained"));
}

#[cfg(windows)]
#[test]
#[ignore = "requires real Windows GPU"]
fn failed_index_publication_preserves_old_snapshot_and_discards_own_candidate() {
    let folder = Sandbox::new();
    let (ok, first) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{first}");
    let cache = fs::read_dir(folder.0.join("local/DeepEngineNative/asset-recovery"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let index = cache.join("active.json");
    let previous = fs::read(&index).unwrap();
    let original = fs::metadata(&index).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&index, readonly).unwrap();
    let manifest_path = folder.0.join("source/manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["manifest"]["compatibility"]["id"] = serde_json::json!("new-verified-profile-id");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let count = fs::read_dir(&cache).unwrap().count();
    let (ok, next) = folder.run("--smoke-asset-package", "source");
    fs::set_permissions(&index, original).unwrap();
    assert!(ok, "{next}");
    assert!(next.contains("asset-lkg/index-publish"));
    assert_eq!(fs::read(&index).unwrap(), previous);
    assert_eq!(fs::read_dir(cache).unwrap().count(), count);
    fs::write(&manifest_path, b"broken").unwrap();
    let (ok, restored) = folder.run("--smoke-asset-package", "source");
    assert!(ok, "{restored}");
    assert!(restored.contains("active=last-known-good"));
}
