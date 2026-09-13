use std::{
    fs,
    sync::{Arc, Barrier},
    thread,
};

use super::{
    ShaderDiskCache, ShaderDiskCacheCancellation, ShaderDiskCacheErrorCode,
    io::classify_io,
    test_support::{PACKAGE_A, PACKAGE_B, TestDirectory, config, owned_names, package_key},
};

#[test]
fn persists_across_restart_and_rebuilds_after_record_corruption() {
    let directory = TestDirectory::new("restart");
    let key = package_key(PACKAGE_A);
    {
        let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
        cache.put(PACKAGE_A, None).expect("put");
        assert_eq!(
            cache.get(&key, None).expect("get").unwrap().package_id,
            "deep.fixture.pbr"
        );
    }
    let reopened = ShaderDiskCache::open(config(&directory.0)).expect("restart");
    assert!(reopened.get(&key, None).expect("restored").is_some());
    drop(reopened);

    let record = owned_names(&directory.0)
        .into_iter()
        .find(|name| name.starts_with("record-"))
        .expect("record file");
    fs::write(directory.0.join(record), b"{\"partial\":true}").expect("corrupt record");
    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("corrupt record must fail closed"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::CorruptRecord);

    fs::write(directory.0.join("keep.txt"), b"unrelated").expect("unrelated file");
    let rebuilt = ShaderDiskCache::rebuild(config(&directory.0), None).expect("rebuild");
    assert!(rebuilt.get(&key, None).expect("empty cache").is_none());
    assert!(directory.0.join("keep.txt").is_file());
}

#[test]
fn failed_new_record_never_replaces_the_published_index() {
    let directory = TestDirectory::new("atomic");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    let old_key = package_key(PACKAGE_A);
    let candidate_key = package_key(PACKAGE_B);
    cache.put(PACKAGE_A, None).expect("old record");
    let before = cache.stats().expect("stats");

    let error = cache
        .put_failing_before_publish(PACKAGE_B)
        .expect_err("injected write failure");
    assert_eq!(error.code, ShaderDiskCacheErrorCode::Io);
    assert_eq!(
        cache.stats().expect("unchanged").generation,
        before.generation
    );
    assert!(
        cache
            .get(&old_key, None)
            .expect("old record survives")
            .is_some()
    );
    assert!(
        cache
            .get(&candidate_key, None)
            .expect("candidate absent")
            .is_none()
    );
    assert!(cache.cleanup(None).expect("remove orphan") >= 1);
    drop(cache);

    let reopened = ShaderDiskCache::open(config(&directory.0)).expect("restart");
    assert!(
        reopened
            .get(&old_key, None)
            .expect("old record restored")
            .is_some()
    );
    assert!(
        reopened
            .get(&candidate_key, None)
            .expect("failed candidate absent")
            .is_none()
    );
}

#[test]
fn concurrent_same_key_puts_share_one_physical_record() {
    let directory = TestDirectory::new("concurrent");
    let cache = Arc::new(ShaderDiskCache::open(config(&directory.0)).expect("open"));
    let barrier = Arc::new(Barrier::new(12));
    let workers: Vec<_> = (0..12)
        .map(|_| {
            let cache = Arc::clone(&cache);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                cache
                    .put(PACKAGE_A, None)
                    .expect("coalesced put")
                    .package_cache_key
            })
        })
        .collect();
    let keys: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker"))
        .collect();
    assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
    let stats = cache.stats().expect("stats");
    assert_eq!(stats.entries, 1);
    assert_eq!(stats.physical_record_writes, 1);
    assert_eq!(stats.coalesced_writes, 11);
}

#[test]
fn deterministic_lru_and_cleanup_keep_only_reachable_files() {
    let directory = TestDirectory::new("lru");
    let mut limits = config(&directory.0);
    limits.max_entries = 1;
    let cache = ShaderDiskCache::open(limits.clone()).expect("open");
    let key_a = package_key(PACKAGE_A);
    let key_b = package_key(PACKAGE_B);
    cache.put(PACKAGE_A, None).expect("first");
    cache.put(PACKAGE_B, None).expect("second");
    assert!(cache.get(&key_a, None).expect("evicted").is_none());
    assert!(cache.get(&key_b, None).expect("retained").is_some());
    assert_eq!(owned_names(&directory.0).len(), 4);

    fs::write(
        directory.0.join(".deep-shader-cache-tmp-interrupted"),
        b"partial",
    )
    .expect("partial file");
    drop(cache);
    let reopened = ShaderDiskCache::open(limits).expect("restart cleanup");
    assert_eq!(reopened.stats().expect("stats").entries, 1);
    assert_eq!(owned_names(&directory.0).len(), 4);
    assert!(reopened.remove(&key_b, None).expect("remove"));
    assert_eq!(reopened.stats().expect("empty").entries, 0);
    reopened.clear(None).expect("idempotent clear");
}

#[test]
fn rejects_unsupported_index_version_without_falling_back() {
    let directory = TestDirectory::new("version");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    cache.put(PACKAGE_A, None).expect("put");
    drop(cache);
    let index = owned_names(&directory.0)
        .into_iter()
        .find(|name| name.starts_with("index-"))
        .expect("index");
    let path = directory.0.join(index);
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&path).expect("read index")).expect("index JSON");
    value["schemaVersion"] = serde_json::json!(99);
    fs::write(path, serde_json::to_vec(&value).unwrap()).expect("write incompatible index");
    let error = match ShaderDiskCache::open(config(&directory.0)) {
        Ok(_) => panic!("newer cache version must not fall back"),
        Err(error) => error,
    };
    assert_eq!(error.code, ShaderDiskCacheErrorCode::VersionUnsupported);
}

#[test]
fn exposes_machine_readable_cancel_permission_disk_full_and_capacity_errors() {
    let directory = TestDirectory::new("errors");
    let cache = ShaderDiskCache::open(config(&directory.0)).expect("open");
    let cancellation = ShaderDiskCacheCancellation::default();
    cancellation.cancel();
    assert_eq!(
        cache.put(PACKAGE_A, Some(&cancellation)).unwrap_err().code,
        ShaderDiskCacheErrorCode::Cancelled
    );
    assert_eq!(
        classify_io(&std::io::Error::from_raw_os_error(112), "write").code,
        ShaderDiskCacheErrorCode::DiskFull
    );
    assert_eq!(
        classify_io(
            &std::io::Error::from(std::io::ErrorKind::PermissionDenied),
            "write"
        )
        .code,
        ShaderDiskCacheErrorCode::PermissionDenied
    );
    let mut tiny = config(&directory.0.join("tiny"));
    tiny.max_bytes = 1;
    let tiny_cache = ShaderDiskCache::open(tiny).expect("tiny cache");
    assert_eq!(
        tiny_cache.put(PACKAGE_A, None).unwrap_err().code,
        ShaderDiskCacheErrorCode::CapacityExceeded
    );
}
