use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, parse_and_validate_runtime_package_cooperative,
    parse_and_validate_runtime_package_owned_cooperative, runtime_content_sha256,
    runtime_package_sha256,
};
use serde_json::{Value, json};

fn fixture(texture: Value) -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("fixtures/runtime-package-v1.json")).unwrap();
    value["payloads"]["scene.main"]["textures"] = json!([texture]);
    rehash(&mut value);
    value
}
fn rehash(value: &mut Value) {
    let resources = value["resources"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    for (index, id) in resources.iter().enumerate() {
        value["resources"][index]["contentHash"]["value"] =
            json!(runtime_content_sha256(&value["payloads"][id]));
    }
    value["packageHash"]["value"] = json!(runtime_package_sha256(value).unwrap());
}
fn texture(data: Value) -> Value {
    json!({"id":"texture","revision":1,"semantic":"baseColor","width":1,"height":1,"data":data,
        "mipmaps":[]})
}
fn load(
    value: &Value,
) -> Result<
    deep_engine_native::runtime_package::LoadedRuntimePackage,
    deep_engine_native::runtime_package::RuntimePackageError,
> {
    pollster::block_on(parse_and_validate_runtime_package_cooperative(
        &serde_json::to_vec(value).unwrap(),
        None,
        || std::future::ready(false),
    ))
}

#[test]
fn legacy_arrays_and_compact_bytes_preserve_all_render_content() {
    for data in [json!([128, 64, 255, 255]), json!("gED//w==")] {
        let value = fixture(texture(data));
        let normal =
            parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).unwrap();
        let cooperative = load(&value).unwrap();
        assert_eq!(
            format!("{:?}", normal.render_packet),
            format!("{:?}", cooperative.render_packet)
        );
        assert_eq!(normal.package_hash, cooperative.package_hash);
        assert_eq!(normal.summary(), cooperative.summary());
        let owned = pollster::block_on(parse_and_validate_runtime_package_owned_cooperative(
            serde_json::to_vec(&value).unwrap(),
            None,
            || std::future::ready(false),
        ))
        .unwrap();
        assert_eq!(owned.package_hash, normal.package_hash);
        assert_eq!(
            owned.render_packet.textures[0].data,
            normal.render_packet.textures[0].data
        );
    }
}

#[test]
fn malformed_bytes_schema_and_hashes_are_rejected_by_both_loaders() {
    for data in [
        json!("AB=="),
        json!("AQJ="),
        json!("AA=A"),
        json!(""),
        json!([256]),
        json!(null),
    ] {
        let value = fixture(texture(data));
        assert!(load(&value).is_err());
        assert!(parse_and_validate_runtime_package(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    let mut value = fixture(texture(json!("gED//w==")));
    value["payloads"]["scene.main"]["textures"][0]["height"] = json!(2);
    assert!(
        load(&value)
            .unwrap_err()
            .to_string()
            .contains("hash mismatch")
    );
    rehash(&mut value);
    assert!(load(&value).is_err());
}

#[test]
fn cancellation_is_checked_before_allocating_or_publishing() {
    let value = fixture(texture(json!("gED//w==")));
    let bytes = serde_json::to_vec(&value).unwrap();
    let error = pollster::block_on(parse_and_validate_runtime_package_cooperative(
        &bytes,
        None,
        || std::future::ready(true),
    ))
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    let mut tasks = 0;
    let error = pollster::block_on(parse_and_validate_runtime_package_cooperative(
        &bytes,
        None,
        || {
            tasks += 1;
            std::future::ready(tasks >= 3)
        },
    ))
    .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
}

#[test]
fn chunked_large_texture_and_mips_keep_exact_pixels_and_padding() {
    let mut value = texture(json!("AAAA".repeat(32_768)));
    value["width"] = json!(96);
    value["height"] = json!(256);
    let (mut width, mut height) = (96usize, 256usize);
    let mut mips = Vec::new();
    while width > 1 || height > 1 {
        width = (width / 2).max(1);
        height = (height / 2).max(1);
        let count = width * height * 4;
        let text = format!(
            "{}{}",
            "AAAA".repeat(count / 3),
            match count % 3 {
                1 => "AA==",
                2 => "AAA=",
                _ => "",
            }
        );
        mips.push(json!({"width":width,"height":height,"data":text}));
    }
    value["mipmaps"] = json!(mips);
    let source = fixture(value);
    let full = parse_and_validate_runtime_package(&serde_json::to_vec(&source).unwrap()).unwrap();
    let cooperative = load(&source).unwrap();
    assert_eq!(
        full.render_packet.textures[0].data,
        cooperative.render_packet.textures[0].data
    );
    assert_eq!(
        full.render_packet.textures[0].mipmaps[0].data,
        cooperative.render_packet.textures[0].mipmaps[0].data
    );
    let mut invalid = source.clone();
    invalid["payloads"]["scene.main"]["textures"][0]["data"] =
        json!(format!("{}AA==AAAA", "AAAA".repeat(8191)));
    rehash(&mut invalid);
    assert!(load(&invalid).is_err());
}

#[test]
fn duplicate_fields_and_foreign_entrypoints_still_fail_closed() {
    let raw = br#"{"schema":"deep-engine.runtime-package","schema":"forged"}"#;
    assert!(
        pollster::block_on(parse_and_validate_runtime_package_cooperative(
            raw,
            None,
            || std::future::ready(false)
        ))
        .unwrap_err()
        .to_string()
        .contains("duplicate")
    );
    let mut value = fixture(texture(json!("gED//w==")));
    value["entrypoints"]["renderPacket"] = json!("missing");
    rehash(&mut value);
    assert!(load(&value).is_err());
}
