use super::*;
use deep_engine_native::runtime_package::{
    build_runtime_package_delta, runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

pub(crate) fn fixture(revision: u64) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(include_bytes!(
        "../../tests/fixtures/runtime-package-v1.json"
    ))
    .unwrap();
    value["packageVersion"] = json!(format!("1.0.{revision}"));
    value["payloads"]["scene.main"]["instances"][0]["transform"][12] = json!(revision as f64);
    let hash = runtime_content_sha256(&value["payloads"]["scene.main"]);
    let resource = value["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == "scene.main")
        .unwrap();
    resource["revision"] = json!(revision + 1);
    resource["contentHash"]["value"] = json!(hash);
    value["packageHash"]["value"] = json!(runtime_package_sha256(&value).unwrap());
    serde_json::to_vec(&value).unwrap()
}

pub(crate) fn source() -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("deep-delta-{}-{nonce}.json", std::process::id()))
}

#[cfg(windows)]
pub(crate) fn deep2d_fixture(revision: u64) -> Vec<u8> {
    let mut value: Value = serde_json::from_slice(&fixture(0)).unwrap();
    let id = "native:deep2d:atlas-smoke";
    value["packageVersion"] = json!(format!("2.0.{revision}"));
    value["payloads"][id]["displayList"]["commands"][0]["fill"][0] = json!(0.1 * revision as f64);
    value["payloads"][id]["revision"] = json!(revision + 1);
    let hash = runtime_content_sha256(&value["payloads"][id]);
    let resource = value["resources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["id"] == id)
        .unwrap();
    resource["revision"] = json!(revision + 1);
    resource["contentHash"]["value"] = json!(hash);
    value["packageHash"]["value"] = json!(runtime_package_sha256(&value).unwrap());
    serde_json::to_vec(&value).unwrap()
}

pub(crate) fn snapshot(bytes: &[u8]) -> RuntimePackageSnapshot {
    RuntimePackageSnapshot::from_loaded(&parse_and_validate_runtime_package(bytes).unwrap())
}

#[test]
fn full_update_and_delta_only_commit_complete_bytes_after_presentation() {
    let path = source();
    let base = fixture(0);
    let target = fixture(1);
    let store = crate::runtime_lkg::Store::local(&path).unwrap();
    let mut full = ordinary_decoder(&base, &path, &snapshot(&fixture(2)))
        .unwrap()
        .unwrap();
    assert!(store.restore().is_err());
    crate::runtime_package_startup::presented(&mut full.content);
    assert_eq!(store.restore().unwrap(), base);
    let delta = build_runtime_package_delta(&base, &target).unwrap();
    let mut candidate = ordinary_decoder(&delta, &path, &snapshot(&base))
        .unwrap()
        .unwrap();
    assert_eq!(store.restore().unwrap(), base);
    assert_eq!(
        candidate.snapshot.package_hash,
        snapshot(&target).package_hash
    );
    assert_eq!(candidate.plan.entries.len(), 1);
    assert_eq!(candidate.plan.reused, 2);
    crate::runtime_package_startup::presented(&mut candidate.content);
    assert_eq!(
        snapshot(&store.restore().unwrap()).package_hash,
        snapshot(&target).package_hash
    );
    assert!(
        ordinary_decoder(&delta, &path, &snapshot(&target))
            .unwrap()
            .is_none()
    );
    std::fs::write(&path, delta).unwrap();
    let recovered = crate::runtime_package_startup::load_auto(&path)
        .unwrap()
        .into_content();
    assert_eq!(
        recovered.runtime_package().unwrap().package_hash,
        snapshot(&target).package_hash
    );
    std::fs::remove_file(path).unwrap();
}

#[test]
fn broken_schema_hash_truncation_and_late_delta_preserve_checkpoint() {
    let path = source();
    let base = fixture(0);
    let target = fixture(1);
    let store = crate::runtime_lkg::Store::local(&path).unwrap();
    store.commit(&base, &snapshot(&base).package_hash).unwrap();
    let delta = build_runtime_package_delta(&base, &target).unwrap();
    let valid: Value = serde_json::from_slice(&delta).unwrap();
    let mut schema = valid.clone();
    schema["targetSchemaVersion"] = json!(99);
    let mut missing = valid.clone();
    missing["operations"] = json!([]);
    let mut hash = valid;
    hash["targetPackageHash"] = json!("0".repeat(64));
    for bytes in [
        serde_json::to_vec(&schema).unwrap(),
        serde_json::to_vec(&missing).unwrap(),
        serde_json::to_vec(&hash).unwrap(),
        delta[..delta.len() / 2].to_vec(),
        build_runtime_package_delta(&target, &fixture(2)).unwrap(),
    ] {
        assert!(ordinary_decoder(&bytes, &path, &snapshot(&base)).is_err());
        assert_eq!(store.restore().unwrap(), base);
    }
}

#[test]
fn delta_rejects_missing_or_unpresented_baseline_and_recovers_after_commit() {
    let path = source();
    let base = fixture(0);
    let target = fixture(1);
    let next = fixture(2);
    let delta = build_runtime_package_delta(&target, &next).unwrap();
    let store = crate::runtime_lkg::Store::local(&path).unwrap();
    assert!(ordinary_decoder(&delta, &path, &snapshot(&target)).is_err());
    store.commit(&base, &snapshot(&base).package_hash).unwrap();
    assert!(
        ordinary_decoder(&delta, &path, &snapshot(&target))
            .err()
            .unwrap()
            .contains("checkpoint differs")
    );
    std::fs::write(&path, &delta).unwrap();
    let PackageUpdate::Rejected {
        identity: Some(identity),
        ..
    } = load_update(&path, None, &snapshot(&base), ordinary_decoder)
    else {
        panic!("out of order")
    };
    store
        .commit(&target, &snapshot(&target).package_hash)
        .unwrap();
    assert_eq!(file_identity(&path).unwrap(), identity);
    // watcher clears observed whenever the published hash changes.
    assert!(matches!(
        load_update(&path, None, &snapshot(&target), ordinary_decoder),
        PackageUpdate::Ready { .. }
    ));
    std::fs::remove_file(path).unwrap();
}
