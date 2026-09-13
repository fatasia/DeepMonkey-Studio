use deep_engine_native::runtime_package::parse_and_validate_runtime_package;

const GOLDEN: &str = include_str!("fixtures/runtime-package-v1.json");

#[test]
fn rejects_duplicate_payload_members_before_hash_or_schema_validation() {
    let duplicate = GOLDEN.replacen("\"metallic\":", "\"metallic\":0.9,\"metallic\":", 1);
    assert!(
        duplicate != GOLDEN,
        "fixture must exercise an actual material"
    );
    let error = parse_and_validate_runtime_package(duplicate.as_bytes()).unwrap_err();
    assert!(
        error.to_string().contains("duplicate JSON field: metallic"),
        "{error}"
    );
}

#[test]
fn rejects_equivalent_escaped_keys_and_trailing_json() {
    for (invalid, message) in [
        (
            r#"{"payloads":{"id":1,"\u0069d":1}}"#,
            "duplicate JSON field: id",
        ),
        (r#"{} {}"#, "trailing characters"),
    ] {
        let error = parse_and_validate_runtime_package(invalid.as_bytes()).unwrap_err();
        assert!(error.to_string().contains(message), "{error}");
    }
    assert!(parse_and_validate_runtime_package(GOLDEN.as_bytes()).is_ok());
}

#[test]
fn enforces_depth_while_decoding_the_json_tree() {
    let nested = format!("{}0{}", "[".repeat(34), "]".repeat(34));
    let error = parse_and_validate_runtime_package(nested.as_bytes()).unwrap_err();
    assert!(
        error.to_string().contains("JSON node or depth budget"),
        "{error}"
    );
}
