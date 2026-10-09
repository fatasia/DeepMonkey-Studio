use super::{RenderPacket, validate_packet};
use serde_json::{Value, json};

fn packet(layer: Value) -> RenderPacket {
    let mut value: Value =
        serde_json::from_str(include_str!("../../fixtures/render_packet_v1.json")).unwrap();
    value["materials"][0]["layered"] = json!({"layers":[layer]});
    serde_json::from_value(value).unwrap()
}
fn metal() -> Value {
    json!({"responseModel":"microfacet-metal-reflection","coverage":0.75,
      "surface":{"metallic":1,"baseColor":[0.8,0.4,0.1],"roughness":0.35},
      "params":{"anisotropy":{"strength":0.8,"rotation":0.3}}})
}
#[test]
fn explicit_metal_response_preserves_typed_json_and_reserved_flag() {
    let input = packet(metal());
    validate_packet(&input).unwrap();
    let rows =
        crate::pbr_layered::layered_block_rows(&input.materials[0], |_| unreachable!()).unwrap();
    let block = crate::pbr_layered::pack_layered_surface_block(&rows);
    assert_eq!(block.len() * 4, 304);
    assert_eq!(block[0].to_bits(), 1);
    assert_eq!(block[1].to_bits(), 1);
    assert_eq!(block[19], 15.0);
    assert_eq!(block[7], 0.8);
    assert_eq!(block[8], 0.3);
    for strength in [0.0, 1e-7, 0.01, 1.0] {
        let mut layer = metal();
        layer["params"]["anisotropy"]["strength"] = json!(strength);
        validate_packet(&packet(layer)).unwrap();
    }
}
#[test]
fn unsupported_active_domain_and_old_native_anisotropy_remain_closed() {
    let mut cases = vec![];
    let mut layer = metal();
    layer["surface"]["metallic"] = json!(0.999);
    cases.push(layer);
    let mut layer = metal();
    layer["surface"] = json!({});
    cases.push(layer);
    let mut layer = metal();
    layer["surface"]["metallicRoughnessTexture"] = json!({"texture":"mr"});
    cases.push(layer);
    for field in ["clearcoat", "transmission"] {
        let mut layer = metal();
        layer["params"][field] = json!({"factor":0.1});
        cases.push(layer);
    }
    let mut layer = metal();
    layer["params"]["anisotropy"]["rotation"] = json!(4);
    cases.push(layer);
    for layer in cases {
        assert!(
            validate_packet(&packet(layer))
                .unwrap_err()
                .contains("microfacet-metal-reflection")
        );
    }
    let mut layer = metal();
    layer.as_object_mut().unwrap().remove("responseModel");
    assert!(
        validate_packet(&packet(layer))
            .unwrap_err()
            .contains("anisotropy.strength")
    );
}
#[test]
fn pruning_keeps_numeric_guard_and_model_enum_validation() {
    let mut layer = metal();
    layer["coverage"] = json!(0);
    layer["surface"] = json!({});
    let input = packet(layer.clone());
    validate_packet(&input).unwrap();
    assert!(
        crate::pbr_layered::layered_block_rows(&input.materials[0], |_| unreachable!())
            .unwrap()
            .is_empty()
    );
    layer["params"]["anisotropy"]["strength"] = json!(2);
    assert!(
        validate_packet(&packet(layer.clone()))
            .unwrap_err()
            .contains("strength")
    );
    layer["responseModel"] = json!("unknown");
    assert!(serde_json::from_value::<super::MaterialLayer>(layer).is_err());
}
#[test]
fn canonical_half_turn_is_stable_in_the_packed_float32_contract() {
    for angle in [-std::f32::consts::PI, std::f32::consts::PI, -1.2, 0.0, 1.2] {
        let mut layer = metal();
        layer["params"]["anisotropy"]["rotation"] = json!(angle);
        let input = packet(layer);
        validate_packet(&input).unwrap();
        let rows = crate::pbr_layered::layered_block_rows(&input.materials[0], |_| unreachable!())
            .unwrap();
        assert_eq!(
            rows[0].params[4],
            if angle == -std::f32::consts::PI {
                std::f32::consts::PI
            } else {
                angle
            }
        );
    }
}
