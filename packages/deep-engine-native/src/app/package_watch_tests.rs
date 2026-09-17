use deep_engine_native::runtime_package::{
    RuntimeResourcePlanAction, parse_and_validate_runtime_package, runtime_content_sha256,
    runtime_package_sha256,
};
use serde_json::{Value, json};

use super::{PackageIdentity, PackageUpdate, decode_candidate, load_update, ordinary_decoder};
use crate::player_content::RuntimePackageSnapshot;

fn fixture() -> Vec<u8> {
    include_bytes!("../../tests/fixtures/runtime-package-v1.json").to_vec()
}

fn reseal(value: &mut Value, id: &str, bump_revision: bool) {
    let hash = runtime_content_sha256(&value["payloads"][id]);
    let resource = value["resources"]
        .as_array_mut()
        .expect("resources")
        .iter_mut()
        .find(|resource| resource["id"] == id)
        .expect("resource");
    resource["contentHash"]["value"] = json!(hash);
    if bump_revision {
        resource["revision"] = json!(resource["revision"].as_u64().unwrap() + 1);
    }
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).unwrap());
}

fn published_snapshot() -> RuntimePackageSnapshot {
    let package = parse_and_validate_runtime_package(&fixture()).expect("fixture package");
    RuntimePackageSnapshot::from_loaded(&package)
}

#[test]
fn package_candidate_carries_the_validated_diff_and_complete_content() {
    let mut value: Value = serde_json::from_slice(&fixture()).unwrap();
    value["payloads"]["scene.main"]["instances"][0]["transform"][12] = json!(-0.25);
    reseal(&mut value, "scene.main", true);

    let candidate = decode_candidate(&serde_json::to_vec(&value).unwrap(), &published_snapshot())
        .expect("candidate validates")
        .expect("content differs");
    assert_eq!(candidate.plan.entries.len(), 1);
    assert_eq!(
        candidate.plan.entries[0].action,
        RuntimeResourcePlanAction::Replace
    );
    assert_eq!(candidate.plan.entries[0].id, "scene.main");
    assert_eq!(candidate.plan.reused, 2);
    assert_ne!(candidate.content.scene_content_key(), 0);
    assert_eq!(candidate.snapshot.package_id, "deep.runtime.golden");
}

#[test]
fn unchanged_revision_with_changed_content_fails_before_publication() {
    let mut value: Value = serde_json::from_slice(&fixture()).unwrap();
    value["payloads"]["scene.main"]["instances"][0]["transform"][12] = json!(-0.25);
    reseal(&mut value, "scene.main", false);

    let error = decode_candidate(&serde_json::to_vec(&value).unwrap(), &published_snapshot())
        .err()
        .expect("revision/hash mismatch rejected");
    assert!(error.contains("revision bump"), "{error}");
}

#[test]
fn identical_package_is_an_explicit_noop() {
    assert!(
        decode_candidate(&fixture(), &published_snapshot())
            .expect("fixture validates")
            .is_none()
    );
}

#[test]
fn first_poll_checks_content_and_a_missing_source_can_return() {
    let path = std::env::temp_dir().join(format!("package-first-poll-{}.json", std::process::id()));
    let snapshot = published_snapshot();
    assert!(matches!(
        load_update(&path, None, &snapshot, ordinary_decoder),
        PackageUpdate::Rejected { identity: None, .. }
    ));
    let mut value: Value = serde_json::from_slice(&fixture()).unwrap();
    value["payloads"]["scene.main"]["instances"][0]["transform"][12] = json!(-0.25);
    reseal(&mut value, "scene.main", true);
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    let PackageUpdate::Ready { identity, package } =
        load_update(&path, None, &snapshot, ordinary_decoder)
    else {
        panic!("first poll must detect a source changed since initial load");
    };
    assert!(matches!(
        load_update(&path, Some(&identity), &package.snapshot, ordinary_decoder),
        PackageUpdate::Unchanged
    ));
    std::fs::remove_file(&path).unwrap();
    assert!(matches!(
        load_update(&path, Some(&identity), &package.snapshot, ordinary_decoder),
        PackageUpdate::Rejected { identity: None, .. }
    ));
    std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(matches!(
        load_update(&path, None, &package.snapshot, ordinary_decoder),
        PackageUpdate::Equivalent { .. }
    ));
    std::fs::remove_file(path).unwrap();
}

#[test]
#[cfg(windows)]
fn x_candidate_identity_and_noop_are_checked_before_worker_execution() {
    let bytes =
        include_bytes!("../../../deep-engine/fixtures/experimental-x-display-runtime-v6.json");
    let loaded =
        deep_engine_native::runtime_package::parse_and_validate_x_runtime_package(bytes).unwrap();
    let mut snapshot = RuntimePackageSnapshot::from_loaded(&loaded.base);
    let path = std::path::Path::new("missing-x-package.json");
    assert!(super::x_decoder(bytes, path, &snapshot).unwrap().is_none());
    snapshot.package_id = "different-id".into();
    assert!(
        super::x_decoder(bytes, path, &snapshot)
            .err()
            .unwrap()
            .contains("identity changed")
    );
    assert!(super::x_decoder(&fixture(), path, &snapshot).is_err());
    assert!(ordinary_decoder(bytes, path, &snapshot).is_err());
}

#[test]
fn oversized_watched_package_fails_before_an_unbounded_read() {
    let path = std::env::temp_dir().join(format!(
        "deep-engine-native-oversized-package-{}.json",
        std::process::id()
    ));
    let file = std::fs::File::create(&path).expect("create sparse oversized package");
    file.set_len(256 * 1024 * 1024 + 1)
        .expect("size sparse package");
    drop(file);
    let unseen = PackageIdentity {
        modified: None,
        len: 0,
    };
    let PackageUpdate::Rejected { reason, .. } = load_update(
        &path,
        Some(&unseen),
        &published_snapshot(),
        ordinary_decoder,
    ) else {
        panic!("oversized package must be rejected");
    };
    assert!(reason.contains("256 MiB input limit"), "{reason}");
    std::fs::remove_file(path).ok();
}
