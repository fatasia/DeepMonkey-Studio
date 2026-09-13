use std::path::PathBuf;

use deep_engine_native::shader_package::{
    DEEP_PBR_MESH_V1_SHA256, load_and_validate_shader_package, parse_and_validate_shader_package,
};
use serde_json::{Value, json};

type Mutation = Box<dyn Fn(&mut Value)>;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/{name}"))
}

fn fixture() -> Value {
    serde_json::from_slice(
        &std::fs::read(fixture_path("deep_shader_package_v2.json")).expect("fixture"),
    )
    .expect("fixture JSON")
}

fn validate(value: &Value) -> Result<(), String> {
    parse_and_validate_shader_package(&serde_json::to_vec(value).expect("serialize"))
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[test]
fn accepts_typescript_generated_executable_pipeline_fixture() {
    let package = load_and_validate_shader_package(fixture_path("deep_shader_package_v2.json"))
        .expect("valid package");
    assert_eq!(package.package_id, "deep.fixture.pbr");
    assert_eq!(package.schema_version, 2);
    assert_eq!(
        package.shader_abi.content_hash.value,
        DEEP_PBR_MESH_V1_SHA256
    );
    assert_eq!(package.shader_abi.contract.vertex_streams[0].slot, 0);
    assert_eq!(
        package.shader_abi.contract.vertex_streams[0].array_stride,
        40
    );
    assert_eq!(
        package.shader_abi.contract.attachment_profiles[0].sample_count,
        4
    );
    assert_eq!(package.passes[0].pipeline.pass_variant_id, "forward-plain");
    assert_eq!(
        package.passes[0].cache_key,
        "b86a753d5c18db639151f8287be0ec5d6a382fb30449ad0f0fb35d19d16fa7b1"
    );
}

#[test]
fn explicitly_rejects_unpublished_v1_instead_of_guessing() {
    let error = load_and_validate_shader_package(fixture_path("deep_shader_package_v1.json"))
        .expect_err("v1 must be rejected");
    assert!(error.to_string().contains("v1 is rejected"));
}

#[test]
fn rejects_wrong_identity_and_unknown_fields_at_every_contract_layer() {
    for (field, value) in [
        ("schema", json!("other")),
        ("schemaVersion", json!(3)),
        ("targetProfile", json!("webgl-glsl")),
    ] {
        let mut package = fixture();
        package[field] = value;
        assert!(validate(&package).is_err(), "accepted invalid {field}");
    }
    for mutate in [
        |value: &mut Value| value["unexpected"] = json!(true),
        |value: &mut Value| value["passes"][0]["reflection"] = json!({}),
        |value: &mut Value| value["passes"][0]["pipeline"]["reflection"] = json!({}),
        |value: &mut Value| {
            value["shaderAbi"]["contract"]["bindGroupLayouts"][0]["bindings"][0]["resource"]["unexpected"] =
                json!(true)
        },
    ] {
        let mut package = fixture();
        mutate(&mut package);
        assert!(
            validate(&package)
                .expect_err("unknown field")
                .contains("unknown field")
        );
    }
}

#[test]
fn rejects_any_change_to_pipeline_creation_state() {
    let mutations: Vec<Mutation> = vec![
        Box::new(|v| v["shaderAbi"]["contract"]["bindGroupLayouts"][0]["group"] = json!(2)),
        Box::new(|v| v["shaderAbi"]["contract"]["vertexStreams"][0]["slot"] = json!(3)),
        Box::new(|v| v["shaderAbi"]["contract"]["vertexStreams"][0]["arrayStride"] = json!(44)),
        Box::new(|v| {
            v["shaderAbi"]["contract"]["vertexStreams"][0]["stepMode"] = json!("instance")
        }),
        Box::new(|v| {
            v["shaderAbi"]["contract"]["vertexStreams"][0]["attributes"][0]["byteOffset"] = json!(4)
        }),
        Box::new(|v| v["shaderAbi"]["contract"]["attachmentProfiles"][0]["sampleCount"] = json!(1)),
        Box::new(|v| {
            v["shaderAbi"]["contract"]["attachmentProfiles"][0]["resolve"] = json!("none")
        }),
        Box::new(|v| {
            v["shaderAbi"]["contract"]["attachmentProfiles"][2]["depthAttachment"]["depthBias"] =
                json!(0)
        }),
        Box::new(|v| {
            v["shaderAbi"]["contract"]["passVariants"][0]["vertexStreams"] = json!(["geometry"])
        }),
    ];
    for mutate in mutations {
        let mut package = fixture();
        mutate(&mut package);
        assert!(validate(&package).is_err());
    }
}

#[test]
fn rejects_unverified_selection_entry_points_and_complete_state_cache_tampering() {
    let mut variant = fixture();
    variant["passes"][0]["pipeline"]["passVariantId"] = json!("forward-invented");
    assert!(
        validate(&variant)
            .expect_err("variant")
            .contains("pipeline selection")
    );

    let mut entry = fixture();
    entry["passes"][0]["entryPoints"]["vertex"] = json!("shadowMain");
    assert!(validate(&entry).is_err());

    let mut cache = fixture();
    cache["passes"][0]["cacheKey"] = json!("f".repeat(64));
    assert!(
        validate(&cache)
            .expect_err("pass cache")
            .contains("complete executable state")
    );

    let mut package_cache = fixture();
    package_cache["packageCacheKey"] = json!("f".repeat(64));
    assert!(
        validate(&package_cache)
            .expect_err("package cache")
            .contains("package cache")
    );
}

#[test]
fn rejects_non_wgsl_hash_tampering_and_broken_references() {
    let mut language = fixture();
    language["modules"][0]["language"] = json!("glsl");
    assert!(validate(&language).expect_err("GLSL").contains("WGSL"));

    let mut source = fixture();
    source["modules"][0]["source"] = json!("@vertex fn changed() {}");
    assert!(
        validate(&source)
            .expect_err("source hash")
            .contains("SHA-256")
    );

    let mut module = fixture();
    module["modules"][0]["id"] = json!(format!("module.{}", "f".repeat(64)));
    module["passes"][0]["moduleId"] = module["modules"][0]["id"].clone();
    assert!(
        validate(&module)
            .expect_err("module ID")
            .contains("module ID")
    );

    let mut dependency = fixture();
    dependency["modules"][0]["dependencyIds"][0] = json!("deep.missing");
    assert!(
        validate(&dependency)
            .expect_err("dependency")
            .contains("unknown dependency")
    );
}

#[test]
fn rejects_collection_and_source_budgets_before_execution() {
    let mut package = fixture();
    package["modules"][0]["source"] = json!("x".repeat(1_048_577));
    assert!(
        validate(&package)
            .expect_err("WGSL budget")
            .contains("bounded WGSL")
    );

    let mut package = fixture();
    package["dependencies"] = Value::Array(
        (0..257)
            .map(|index| {
                json!({
                    "id": format!("deep.dependency.{index:03}"),
                    "contentHash": { "algorithm": "sha256", "value": "1".repeat(64) }
                })
            })
            .collect(),
    );
    assert!(
        validate(&package)
            .expect_err("dependency budget")
            .contains("budget")
    );
}

#[test]
fn rejects_duplicate_fields_and_missing_required_nullable_fields() {
    let source =
        std::fs::read_to_string(fixture_path("deep_shader_package_v2.json")).expect("fixture");
    let duplicate = source.replacen(
        "\"schemaVersion\":2",
        "\"schemaVersion\":2,\"schemaVersion\":2",
        1,
    );
    let error = parse_and_validate_shader_package(duplicate.as_bytes()).expect_err("duplicate");
    assert!(error.to_string().contains("duplicate field"));

    let mut package = fixture();
    package["passes"][0]["entryPoints"]
        .as_object_mut()
        .expect("entry points")
        .remove("fragment");
    assert!(
        validate(&package)
            .expect_err("missing fragment")
            .contains("missing field")
    );

    let mut package = fixture();
    package["shaderAbi"]["contract"]["attachmentProfiles"][0]["colorAttachments"][0]
        .as_object_mut()
        .expect("attachment")
        .remove("blend");
    assert!(
        validate(&package)
            .expect_err("missing blend")
            .contains("missing field")
    );
}
