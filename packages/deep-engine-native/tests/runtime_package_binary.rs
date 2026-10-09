use deep_engine_native::runtime_package::{
    parse_and_validate_runtime_package, parse_and_validate_runtime_package_owned_cooperative,
    runtime_content_sha256, runtime_package_sha256,
};
use serde_json::{Value, json};

fn fixture() -> (Value, Vec<u8>) {
    from_fixture(include_str!("fixtures/runtime-transfer-v1.json"))
}
fn from_fixture(text: &str) -> (Value, Vec<u8>) {
    let source: Value = serde_json::from_str(text).unwrap();
    let header = serde_json::from_str(source["header"].as_str().unwrap()).unwrap();
    let hex = source["bodyHex"].as_str().unwrap();
    let body = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    (header, body)
}
#[test]
fn compressed_javascript_planes_keep_exact_dimensions_and_pixels() {
    let (header, body) = from_fixture(include_str!("fixtures/runtime-transfer-deflate-v1.json"));
    let loaded = parse_and_validate_runtime_package(&wire(&header, &body)).unwrap();
    let texture = &loaded.render_packet.textures[0];
    assert_eq!((texture.width, texture.height), (256, 256));
    assert_eq!(texture.data.len(), 256 * 256 * 4);
    assert!(
        texture
            .data
            .chunks_exact(4)
            .all(|pixel| pixel == [200, 100, 220, 255])
    );
    for length in [1_u64, 262_143, 262_145, u64::MAX] {
        let mut malformed = header.clone();
        let section = malformed["sections"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|section| section["compression"] == "deflate")
            .unwrap();
        section["decodedLength"] = json!(length);
        rehash(&mut malformed);
        assert!(
            parse_and_validate_runtime_package(&wire(&malformed, &body)).is_err(),
            "decoded length {length}"
        );
    }
}
fn wire(header: &Value, body: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).unwrap();
    let mut bytes = b"DMPBIN1\n".to_vec();
    bytes.extend((header.len() as u32).to_le_bytes());
    bytes.extend(header);
    bytes.extend(body);
    bytes
}
fn rehash(header: &mut Value) {
    let id = header["envelope"]["entrypoints"]["renderPacket"]
        .as_str()
        .unwrap()
        .to_owned();
    let hash = runtime_content_sha256(
        &json!({"metadata": header["envelope"]["payloads"][&id], "sections": header["sections"]}),
    );
    for resource in header["envelope"]["resources"].as_array_mut().unwrap() {
        if resource["id"].as_str() == Some(&id) {
            resource["contentHash"]["value"] = json!(hash);
        }
    }
    header["envelope"]["packageHash"]["value"] =
        json!(runtime_package_sha256(&header["envelope"]).unwrap());
}
#[test]
fn javascript_wire_loads_exact_geometry_texture_and_mips() {
    let source: Value =
        serde_json::from_str(include_str!("fixtures/runtime-transfer-v1.json")).unwrap();
    let (header, body) = fixture();
    let bytes = wire(&header, &body);
    let loaded = parse_and_validate_runtime_package(&bytes).unwrap();
    assert_eq!(
        loaded.render_packet.textures[0].data,
        [200, 100, 220, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255]
    );
    assert_eq!(
        loaded.render_packet.textures[0].mipmaps[0].data,
        [53, 29, 60, 255]
    );
    assert_eq!(loaded.render_packet.geometries[0].vertices[0], -0.8_f32);
    assert_eq!(loaded.render_packet.geometries[0].indices.len(), 36);
    let original_header = source["header"].as_str().unwrap().as_bytes();
    let mut golden = b"DMPBIN1\n".to_vec();
    golden.extend((original_header.len() as u32).to_le_bytes());
    golden.extend(original_header);
    golden.extend(&body);
    assert!(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package_with_expected_hash(
            &golden,
            source["transportHash"].as_str().unwrap()
        )
        .is_ok()
    );
    assert!(
        deep_engine_native::runtime_package::parse_and_validate_runtime_package_with_expected_hash(
            &golden,
            &"0".repeat(64)
        )
        .is_err()
    );
    let result = pollster::block_on(parse_and_validate_runtime_package_owned_cooperative(
        golden,
        source["transportHash"].as_str(),
        || std::future::ready(false),
    ));
    assert!(result.is_ok(), "{result:?}");
}
#[test]
fn rejects_rehashed_malformed_plane_tables() {
    for edit in 0..8 {
        let (mut header, body) = fixture();
        match edit {
            0 => header["sections"][0]["offset"] = json!(1),
            1 => header["sections"][0]["length"] = json!(u64::MAX),
            2 => header["sections"][0]["path"] = json!("/materials/0/roughness"),
            3 => header["sections"][1]["path"] = header["sections"][0]["path"].clone(),
            4 => header["sections"][0]["encoding"] = json!("u32le"),
            5 => header["sections"].as_array_mut().unwrap().clear(),
            6 => header["envelope"]["payloads"]["scene"]["geometries"][0]["vertices"] = json!([0]),
            7 => header["sections"][0]["length"] = json!(0),
            _ => unreachable!(),
        }
        rehash(&mut header);
        assert!(
            parse_and_validate_runtime_package(&wire(&header, &body)).is_err(),
            "edit {edit}"
        );
    }
}
#[test]
fn rejects_corrupt_bytes_trailing_data_duplicate_json_and_cancelled_receipts() {
    let (header, mut body) = fixture();
    body[0] ^= 1;
    assert!(parse_and_validate_runtime_package(&wire(&header, &body)).is_err());
    let (header, mut body) = fixture();
    body.push(0);
    assert!(parse_and_validate_runtime_package(&wire(&header, &body)).is_err());
    let (header, body) = fixture();
    let bytes = wire(&header, &body);
    let cancelled = pollster::block_on(parse_and_validate_runtime_package_owned_cooperative(
        bytes.clone(),
        None,
        || std::future::ready(true),
    ));
    assert!(cancelled.is_err());
    let wrong = "0".repeat(64);
    let receipt = pollster::block_on(parse_and_validate_runtime_package_owned_cooperative(
        bytes,
        Some(&wrong),
        || std::future::ready(false),
    ));
    assert!(receipt.is_err());
    let mut duplicate = b"DMPBIN1\n".to_vec();
    let text = br#"{"schema":"deep-engine.runtime-transfer","version":1,"version":1,"envelope":{},"sections":[]}"#;
    duplicate.extend((text.len() as u32).to_le_bytes());
    duplicate.extend(text);
    assert!(parse_and_validate_runtime_package(&duplicate).is_err());
}
