use deep_engine_native::runtime_package::{
    compute_runtime_package_canonical_hash, parse_and_validate_runtime_package,
    parse_and_validate_runtime_package_with_expected_hash, runtime_package_sha256,
};
use serde_json::{Value, json};

fn package_bytes() -> Vec<u8> {
    let mut package: Value =
        serde_json::from_str(include_str!("fixtures/runtime-package-v1.json")).unwrap();
    package["packageHash"]["value"] =
        json!(runtime_package_sha256(&package).expect("runtime package hash"));
    serde_json::to_vec(&package).unwrap()
}

#[test]
fn computed_canonical_hash_matches_the_full_validation_path() {
    let bytes = package_bytes();
    let computed = compute_runtime_package_canonical_hash(&bytes).expect("compute");
    let package = parse_and_validate_runtime_package(&bytes).expect("full validation");
    assert_eq!(package.package_hash, computed);
}

#[test]
fn prevalidated_path_accepts_the_worker_hash_and_matches_full_validation() {
    let bytes = package_bytes();
    let expected = compute_runtime_package_canonical_hash(&bytes).expect("compute");
    let full = parse_and_validate_runtime_package(&bytes).expect("full validation");
    let prevalidated = parse_and_validate_runtime_package_with_expected_hash(&bytes, &expected)
        .expect("prevalidated");
    assert_eq!(full.package_hash, prevalidated.package_hash);
    assert_eq!(full.resource_index.len(), prevalidated.resource_index.len());
}

#[test]
fn prevalidated_path_rejects_a_stale_or_forged_expected_hash() {
    let bytes = package_bytes();
    let error = parse_and_validate_runtime_package_with_expected_hash(
        &bytes,
        "0000000000000000000000000000000000000000000000000000000000000000",
    )
    .expect_err("stale hash must be rejected");
    assert!(error.to_string().contains("hash mismatch"), "{error}");

    let tampered = package_bytes();
    let mut tweaked = tampered.clone();
    let position = tweaked
        .iter()
        .position(|byte| *byte == b':')
        .expect("colon");
    tweaked[position + 1] = b' ';
    let stale = compute_runtime_package_canonical_hash(&tampered).unwrap();
    assert!(parse_and_validate_runtime_package_with_expected_hash(&tweaked, &stale).is_err());
}

#[test]
fn prevalidated_path_rejects_malformed_expected_hash_before_parsing() {
    let bytes = package_bytes();
    for forged in ["", "ABCDEF", "zz", "a8f5f167f44f4964e6c998dee827110c3c2c"].iter() {
        let error = parse_and_validate_runtime_package_with_expected_hash(&bytes, forged)
            .expect_err("malformed expected hash must be rejected");
        assert!(
            error
                .to_string()
                .contains("expected runtime package hash must be lowercase SHA-256"),
            "{error}"
        );
    }
}
