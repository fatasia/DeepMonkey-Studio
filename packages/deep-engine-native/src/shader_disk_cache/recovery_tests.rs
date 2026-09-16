use std::fs;

use super::{
    ShaderDiskCache, ShaderDiskCacheErrorCode, ShaderDiskCacheStartupDisposition,
    test_support::{PACKAGE_A, PACKAGE_B, TestDirectory, config, owned_names, package_key},
};

#[test]
fn hot_gets_stay_in_memory_until_explicit_flush() {
    let directory = TestDirectory::new("hot-get");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    let key = package_key(PACKAGE_A);
    cache.put(PACKAGE_A, None).expect("put");
    let before = cache.stats().expect("before stats");
    let files_before = owned_names(&directory.0);

    for _ in 0..32 {
        assert!(cache.get(&key, None).expect("hot get").is_some());
    }

    let after_reads = cache.stats().expect("after reads");
    assert_eq!(after_reads.generation, before.generation);
    assert_eq!(after_reads.access_sequence, before.access_sequence + 32);
    assert_eq!(owned_names(&directory.0), files_before);

    cache.flush(None).expect("flush access order");
    let flushed = cache.stats().expect("flushed stats");
    assert_eq!(flushed.generation, before.generation + 1);
    drop(cache);
    let reopened = ShaderDiskCache::open(config(&directory.0)).expect("reopen");
    assert_eq!(
        reopened.stats().expect("restored stats").access_sequence,
        after_reads.access_sequence
    );
}

#[test]
fn directory_lock_rejects_a_second_live_instance() {
    let directory = TestDirectory::new("exclusive");
    let first = ShaderDiskCache::open(config(&directory.0)).expect("first open");
    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("second live instance must not open the same cache"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::CacheBusy);
    drop(first);
    ShaderDiskCache::open(config(&directory.0)).expect("lock released after drop");
}

#[test]
fn directory_lock_follows_cloned_cache_lifetime() {
    let directory = TestDirectory::new("exclusive-clone");
    let first = ShaderDiskCache::open(config(&directory.0)).expect("first open");
    let clone = first.clone();
    drop(first);

    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("clone must keep the directory lock held"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::CacheBusy);

    drop(clone);
    ShaderDiskCache::open(config(&directory.0)).expect("lock released after final clone drop");
}

#[test]
fn corrupt_latest_generation_rolls_back_to_last_known_good() {
    let directory = TestDirectory::new("last-known-good");
    let key_a = package_key(PACKAGE_A);
    let key_b = package_key(PACKAGE_B);
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("first generation");
    cache.put(PACKAGE_B, None).expect("second generation");
    drop(cache);

    let latest = index_names(&directory).pop().expect("latest index");
    fs::write(directory.0.join(latest), b"{\"partial\":true}").expect("corrupt latest");

    let recovered = ShaderDiskCache::open(config(&directory.0)).expect("recover previous index");
    assert!(recovered.get(&key_a, None).expect("old package").is_some());
    assert!(
        recovered
            .get(&key_b, None)
            .expect("rolled-back package")
            .is_none()
    );
    assert_eq!(index_names(&directory).len(), 1);
}

#[test]
fn corrupt_record_in_latest_generation_rolls_back_as_one_snapshot() {
    let directory = TestDirectory::new("record-rollback");
    let key_a = package_key(PACKAGE_A);
    let key_b = package_key(PACKAGE_B);
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("first generation");
    cache.put(PACKAGE_B, None).expect("second generation");
    drop(cache);

    let latest = index_names(&directory).pop().expect("latest index");
    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.0.join(latest)).expect("read latest index"))
            .expect("index JSON");
    let record = index["entries"]
        .as_object()
        .expect("entries")
        .values()
        .find(|entry| entry["packageCacheKey"] == key_b)
        .and_then(|entry| entry["recordFile"].as_str())
        .expect("new record");
    let mut bytes = fs::read(directory.0.join(record)).expect("read record");
    let last = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .expect("record content");
    bytes[last] = b']';
    fs::write(directory.0.join(record), bytes).expect("corrupt record");

    let recovered = ShaderDiskCache::open(config(&directory.0)).expect("recover snapshot");
    assert!(recovered.get(&key_a, None).expect("old package").is_some());
    assert!(
        recovered
            .get(&key_b, None)
            .expect("rolled-back package")
            .is_none()
    );
}

#[test]
fn duplicate_generation_is_a_closed_conflict() {
    let directory = TestDirectory::new("generation-conflict");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let index = index_names(&directory).pop().expect("index");
    let generation = index.split('-').nth(1).expect("generation");
    let duplicate = format!("index-{generation}-999-999-999.json");
    fs::copy(directory.0.join(index), directory.0.join(duplicate)).expect("duplicate index");

    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("duplicate generation must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::CorruptIndex);
}

#[test]
fn latest_scope_mismatch_never_falls_back() {
    let directory = TestDirectory::new("scope");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let mut incompatible = config(&directory.0);
    incompatible.scope.compiler_version = "0.2.1".into();
    let error = match ShaderDiskCache::open(incompatible) {
        Ok(_) => panic!("scope mismatch must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::ScopeMismatch);
}

#[test]
fn explicit_newer_schema_never_falls_back() {
    let directory = TestDirectory::new("schema");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("first generation");
    cache.put(PACKAGE_B, None).expect("second generation");
    drop(cache);
    let latest = index_names(&directory).pop().expect("latest index");
    let path = directory.0.join(latest);
    let mut index: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read index")).expect("index JSON");
    index["schemaVersion"] = serde_json::json!(99);
    fs::write(path, serde_json::to_vec(&index).expect("serialize index"))
        .expect("write incompatible index");

    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("explicit newer schema must not roll back"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::VersionUnsupported);
}

#[test]
fn startup_rebuilds_an_unrecoverable_corrupt_index_without_touching_unowned_files() {
    let directory = TestDirectory::new("startup-rebuild");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let index = index_names(&directory).pop().expect("index");
    fs::write(directory.0.join(index), b"{\"partial\":true}").expect("corrupt index");
    let sentinel = directory.0.join("runtime-package.last-known-good.json");
    fs::write(&sentinel, b"do-not-touch").expect("write sentinel");

    let (recovered, disposition) =
        ShaderDiskCache::open_for_startup(config(&directory.0), None).expect("rebuild cache");
    assert_eq!(
        disposition,
        ShaderDiskCacheStartupDisposition::RebuiltCorruptIndex
    );
    assert_eq!(recovered.stats().expect("stats").entries, 0);
    assert_eq!(fs::read(sentinel).expect("sentinel"), b"do-not-touch");
}

#[test]
fn startup_reports_an_unrecoverable_corrupt_record_rebuild() {
    let directory = TestDirectory::new("startup-record");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let record = owned_names(&directory.0)
        .into_iter()
        .find(|name| name.starts_with("record-"))
        .expect("record");
    fs::write(directory.0.join(record), b"{\"partial\":true}").expect("corrupt record");

    let (recovered, disposition) =
        ShaderDiskCache::open_for_startup(config(&directory.0), None).expect("rebuild cache");
    assert_eq!(
        disposition,
        ShaderDiskCacheStartupDisposition::RebuiltCorruptRecord
    );
    assert_eq!(recovered.stats().expect("stats").entries, 0);
}

#[test]
fn startup_never_rebuilds_an_incompatible_cache() {
    let directory = TestDirectory::new("startup-scope");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let before = owned_names(&directory.0);
    let mut incompatible = config(&directory.0);
    incompatible.scope.compiler_version = "next".into();

    let error = match ShaderDiskCache::open_for_startup(incompatible, None) {
        Ok(_) => panic!("scope mismatch must remain fatal"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::ScopeMismatch);
    assert_eq!(owned_names(&directory.0), before);
}

fn index_names(directory: &TestDirectory) -> Vec<String> {
    owned_names(&directory.0)
        .into_iter()
        .filter(|name| name.starts_with("index-"))
        .collect()
}
