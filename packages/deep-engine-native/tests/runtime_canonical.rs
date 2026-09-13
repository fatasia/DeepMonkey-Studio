use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, runtime_content_sha256,
};
use serde_json::Value;

#[test]
fn matches_typescript_binary64_and_unicode_golden_vectors() {
    let vectors: Value =
        serde_json::from_str(include_str!("fixtures/runtime-canonical-v1.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        assert_eq!(
            runtime_content_sha256(&vector["input"]),
            vector["sha256"].as_str().unwrap()
        );
    }
}

#[test]
fn loads_browser_built_typed_geometry_without_decimal_hash_drift() {
    let package =
        parse_and_validate_runtime_package(include_bytes!("fixtures/runtime-package-v1.json"))
            .unwrap();
    assert_eq!(
        package.package_hash,
        "621d7355747b15ded4f0c128d10090ea4d0730a6b50f4df644a10991fb3cdb6a"
    );
    assert_eq!(package.render_packet.geometries[0].vertices[0], -0.8_f32);
    assert_eq!(
        package.render_packet.materials[0].emissive_factor,
        Some([0.3125, 0.15625, 0.078125])
    );
    assert_eq!(package.summary().geometries, 2);
    assert_eq!(package.summary().instances, 4);
    assert!(package.summary().has_deep2d);
}
