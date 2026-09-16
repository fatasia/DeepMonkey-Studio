use deep_engine_native::asset_package::{directory::load, parse};
use std::{fs, path::PathBuf, process::Command};
fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/asset-directory-v1")
}
fn manifest() -> serde_json::Value {
    serde_json::from_slice(&fs::read(fixture().join("manifest.json")).unwrap()).unwrap()
}
#[test]
fn ts_rust_manifest_golden_has_identical_dependency_order_and_verified_chunks() {
    let value = manifest();
    let result = parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    assert_eq!(
        result.resource_order,
        ["metadata/license-text", "metadata/license", "scene/main"]
    );
    let loaded = load(&fixture().join("manifest.json")).unwrap();
    assert_eq!(loaded.chunk_count, 3);
    assert_eq!(loaded.package_id, "deep.asset.native-fixture");
    assert!(!loaded.runtime.render_packet.instances.is_empty());
    let bytes = serde_json::to_string(&value)
        .unwrap()
        .replace("\"schemaVersion\":1", "\"schemaVersion\":1.0");
    assert!(parse(bytes.as_bytes()).is_ok());
}
#[test]
fn shared_invalid_variants_and_native_path_evidence_rules_fail_closed() {
    let value = manifest();
    for mutate in [
        |v: &mut serde_json::Value| {
            v["manifest"]["resources"][0]["dependencies"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("scene/main"))
        },
        |v: &mut serde_json::Value| v["blobs"][0]["hash"] = serde_json::json!("A".repeat(64)),
        |v: &mut serde_json::Value| {
            v["manifest"]["source"]["logicalName"] = serde_json::json!("../outside.json")
        },
        |v: &mut serde_json::Value| {
            v["manifest"]["resources"][2]["logicalPath"] =
                v["manifest"]["resources"][0]["logicalPath"].clone()
        },
        |v: &mut serde_json::Value| {
            v["manifest"]["compatibility"]["facets"]["geometry"]["evidenceIds"] =
                serde_json::json!([])
        },
        |v: &mut serde_json::Value| {
            v["manifest"]["source"]["logicalName"] = serde_json::json!("dir/CON.txt")
        },
        |v: &mut serde_json::Value| {
            v["manifest"]["source"]["logicalName"] = serde_json::json!("dir/e\u{301}.json")
        },
    ] {
        let mut bad = value.clone();
        mutate(&mut bad);
        assert!(parse(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
    let mut unicode = value;
    unicode["manifest"]["source"]["logicalName"] = serde_json::json!("导入/机器人-é.json");
    #[cfg(windows)]
    assert!(parse(&serde_json::to_vec(&unicode).unwrap()).is_ok());
}
struct Folder(PathBuf);
impl Folder {
    fn new() -> Self {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("asset-directory-{}-{nonce}", std::process::id()));
        fs::create_dir_all(path.join("blobs")).unwrap();
        fs::copy(fixture().join("manifest.json"), path.join("manifest.json")).unwrap();
        for item in fs::read_dir(fixture().join("blobs")).unwrap() {
            let item = item.unwrap();
            fs::copy(item.path(), path.join("blobs").join(item.file_name())).unwrap();
        }
        Self(path)
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn corrupt_missing_chunk_and_actual_size_mismatch_never_reach_player() {
    let folder = Folder::new();
    let path = folder.0.join("manifest.json");
    let mut value = manifest();
    let hash = value["blobs"][0]["hash"].as_str().unwrap();
    let chunk = folder.0.join("blobs").join(hash);
    let original = fs::read(&chunk).unwrap();
    fs::write(&chunk, b"broken").unwrap();
    assert!(load(&path).is_err());
    fs::remove_file(&chunk).unwrap();
    assert!(load(&path).is_err());
    fs::write(&chunk, original).unwrap();
    value["blobs"][0]["byteLength"] = serde_json::json!(0);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(load(&path).is_err());
    value["blobs"][0]["byteLength"] = serde_json::json!(268435457);
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(load(&path).err().unwrap().contains("byte-budget"));
}

#[cfg(windows)]
#[test]
fn junction_blob_directory_is_rejected_before_any_chunk_is_consumed() {
    use std::os::windows::process::CommandExt;
    let folder = Folder::new();
    let blobs = folder.0.join("blobs");
    let target = folder.0.join("payloads");
    fs::rename(&blobs, &target).unwrap();
    let output = Command::new("powershell.exe").creation_flags(0x08000000)
        .args(["-NoProfile", "-Command", "New-Item -ItemType Junction -Path $env:ASSET_TEST_LINK -Target $env:ASSET_TEST_TARGET -ErrorAction Stop | Out-Null"])
        .env("ASSET_TEST_LINK", &blobs).env("ASSET_TEST_TARGET", &target).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = load(&folder.0.join("manifest.json"));
    fs::remove_dir(&blobs).unwrap();
    assert!(result.err().unwrap().contains("reparse-path"));
    assert!(target.is_dir());
}
#[test]
#[ignore = "requires Windows GPU surface"]
fn directory_asset_scene_reaches_real_player_submission() {
    let folder = Folder::new();
    let output = Command::new(env!("CARGO_BIN_EXE_deep-engine-native"))
        .env("LOCALAPPDATA", folder.0.join("local"))
        .arg("--smoke-asset-package")
        .arg(fixture().join("manifest.json"))
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{text}");
    assert!(text.contains("Deep Asset Package directory OK:"));
    assert!(text.contains("scopes=clean callbacks=clean"));
    assert!(text.contains("native Deep2d smoke frame presented"));
}
