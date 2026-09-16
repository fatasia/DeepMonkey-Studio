use super::{GeometryResource, RenderPacket, validate_packet};
use serde_json::json;

fn packet_json(geometry: serde_json::Value) -> serde_json::Value {
    json!({
        "schema": "deep-engine.render-packet",
        "version": 1,
        "geometries": [geometry],
        "materials": [{ "id": "m", "baseColor": [1.0, 1.0, 1.0], "metallic": 0.0, "roughness": 1.0 }],
        "instances": [{
            "id": "i", "geometry": "g", "material": "m",
            "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
        }],
    })
}

fn triangle_geometry(colors: Option<serde_json::Value>) -> serde_json::Value {
    let mut geometry = json!({
        "id": "g", "revision": 0,
        "vertices": [
            0.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 1.0, 0.0, 1.0, 0.0,
        ],
        "indices": [0, 1, 2],
    });
    if let Some(colors) = colors {
        geometry["colors"] = colors;
    }
    geometry
}

fn parse(packet: serde_json::Value) -> Result<RenderPacket, String> {
    serde_json::from_value(packet).map_err(|error| format!("invalid RenderPacket JSON: {error}"))
}

fn colors(geometry: &GeometryResource) -> Option<&Vec<f32>> {
    geometry.colors.as_ref()
}

#[test]
fn legacy_packet_without_colors_parses_and_validates_unchanged() {
    let packet = parse(packet_json(triangle_geometry(None))).expect("legacy packet must parse");
    assert!(colors(&packet.geometries[0]).is_none());
    assert!(validate_packet(&packet).is_ok());
}

#[test]
fn color_stream_deserializes_and_validates() {
    let linear_rgba = [0.0, 0.25, 0.5, 1.0, 1.0, 0.0, 0.0, 0.5, 0.5, 1.0, 0.0, 0.25];
    let packet = parse(packet_json(triangle_geometry(Some(json!(linear_rgba)))))
        .expect("colored packet must parse");
    assert_eq!(
        colors(&packet.geometries[0]).map(Vec::as_slice),
        Some(&linear_rgba[..])
    );
    assert!(validate_packet(&packet).is_ok());
}

#[test]
fn rejects_color_stream_with_wrong_length() {
    let packet = parse(packet_json(triangle_geometry(Some(json!([
        0.0, 0.0, 0.0, 1.0
    ])))))
    .expect("deserialization accepts any numeric array");
    assert!(
        validate_packet(&packet)
            .unwrap_err()
            .contains("invalid color layout")
    );
}

#[test]
fn rejects_non_finite_color_stream() {
    // 1e40 超出 f32 范围，float_roundtrip 反序列化为 inf，合同校验必须拒绝。
    let packet = parse(packet_json(triangle_geometry(Some(json!([
        0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.5, 0.0, 1.0, 0.0, 1e40,
    ])))))
    .expect("finite-range json numbers must parse");
    assert!(
        validate_packet(&packet)
            .unwrap_err()
            .contains("invalid color layout")
    );
}
