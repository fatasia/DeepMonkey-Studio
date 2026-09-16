use super::*;

fn fixture() -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/runtime-package-v1.json"))
        .unwrap()
}
fn root() -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("deep-lkg-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).unwrap();
    root
}

#[test]
fn fresh_store_reopens_valid_snapshot_and_rejects_corrupt_or_foreign_index() {
    let root = root();
    let source = root.join("project.json");
    let store = Store::new(root.join("cache"), &source).unwrap();
    assert!(store.restore().is_err());
    let bytes = fixture();
    let hash = parse_and_validate_runtime_package(&bytes)
        .unwrap()
        .package_hash;
    store.commit(&bytes, &hash).unwrap();
    // A new Store represents another process; the original source is now broken.
    fs::write(&source, b"broken").unwrap();
    let reopened = Store::new(root.join("cache"), &source).unwrap();
    assert_eq!(reopened.restore().unwrap(), bytes);
    assert!(
        Store::new(root.join("cache"), &root.join("other.json"))
            .unwrap()
            .restore()
            .is_err()
    );
    assert!(store.commit(b"broken", &hash).is_err());
    assert_eq!(store.restore().unwrap(), bytes);
    let index = store.directory().join("active.json");
    fs::write(
        &index,
        br#"{"version":1,"source":"foreign","hash":"../../outside"}"#,
    )
    .unwrap();
    assert!(store.restore().is_err());
    fs::write(&index, b"{").unwrap();
    assert!(store.restore().is_err());
    store.commit(&bytes, &hash).unwrap();
    fs::write(store.directory().join(format!("{hash}.json")), b"broken").unwrap();
    assert!(store.restore().is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn publication_failure_keeps_old_index_and_source_boundaries_are_rejected() {
    let root = root();
    let store = Store::new(root.join("cache"), &root.join("project.json")).unwrap();
    let bytes = fixture();
    let hash = parse_and_validate_runtime_package(&bytes)
        .unwrap()
        .package_hash;
    store.commit(&bytes, &hash).unwrap();
    let index = store.directory().join("active.json");
    let previous = fs::read(&index).unwrap();
    let original_permissions = fs::metadata(&index).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&index, permissions).unwrap();
    #[cfg(windows)]
    assert!(store.commit(&bytes, &hash).is_err());
    assert_eq!(fs::read(&index).unwrap(), previous);
    #[cfg(windows)]
    {
        assert!(Store::new(root.clone(), Path::new(r"\\server\share\scene.json")).is_err());
        assert!(Store::new(root.clone(), &root.join("scene.json:stream")).is_err());
        fs::set_permissions(&index, original_permissions).unwrap();
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn competing_writer_keeps_last_good_readable() {
    let root = root();
    let store = Store::new(root.join("cache"), &root.join("source.json")).unwrap();
    let bytes = fixture();
    let hash = parse_and_validate_runtime_package(&bytes)
        .unwrap()
        .package_hash;
    store.commit(&bytes, &hash).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(store.directory().join("writer.lock"))
        .unwrap();
    lock.lock().unwrap();
    assert_eq!(store.commit(&bytes, &hash).unwrap_err(), "lkg/writer-busy");
    assert_eq!(store.restore().unwrap(), bytes);
    drop(lock);
    store.commit(&bytes, &hash).unwrap();
    fs::remove_dir_all(root).unwrap();
}

fn version(number: usize) -> (Vec<u8>, String) {
    let mut value: serde_json::Value = serde_json::from_slice(&fixture()).unwrap();
    value["packageVersion"] = serde_json::json!(format!("1.0.{number}"));
    let hash = deep_engine_native::runtime_package::runtime_package_sha256(&value).unwrap();
    value["packageHash"]["value"] = serde_json::json!(hash);
    (serde_json::to_vec(&value).unwrap(), hash)
}

#[test]
fn full_legacy_cache_retires_only_verified_versions_after_successful_publication() {
    let root = root();
    let source = root.join("source.json");
    fs::write(&source, b"user source must remain untouched").unwrap();
    let store = Store::new(root.join("cache"), &source).unwrap();
    let (first, first_hash) = version(0);
    store.commit(&first, &first_hash).unwrap();
    for number in 1..130 {
        let (bytes, hash) = version(number);
        fs::write(store.directory().join(format!("{hash}.json")), bytes).unwrap();
    }
    let foreign = store.directory().join(format!("{}.json", "a".repeat(64)));
    fs::write(&foreign, b"not a generated snapshot").unwrap();
    let index = store.directory().join("active.json");
    let original = fs::metadata(&index).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&index, readonly).unwrap();
    let (next, next_hash) = version(130);
    #[cfg(windows)]
    assert!(store.commit(&next, &next_hash).is_err());
    assert_eq!(store.restore().unwrap(), first);
    assert!(fs::read_dir(store.directory()).unwrap().count() > 128);
    fs::set_permissions(&index, original).unwrap();
    store.commit(&next, &next_hash).unwrap();
    assert_eq!(store.restore().unwrap(), next);
    assert!(
        store
            .directory()
            .join(format!("{first_hash}.json"))
            .is_file()
    );
    assert_eq!(fs::read_dir(store.directory()).unwrap().count(), 5); // two snapshots/index/lock/foreign
    assert_eq!(fs::read(&foreign).unwrap(), b"not a generated snapshot");
    assert_eq!(
        fs::read(&source).unwrap(),
        b"user source must remain untouched"
    );
    // A valid read-only candidate proves that identical content is reused, not rewritten.
    let snapshot = store.directory().join(format!("{next_hash}.json"));
    let original = fs::metadata(&snapshot).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&snapshot, readonly).unwrap();
    store.commit(&next, &next_hash).unwrap();
    fs::set_permissions(&snapshot, original).unwrap();
    fs::remove_dir_all(root).unwrap();
}
