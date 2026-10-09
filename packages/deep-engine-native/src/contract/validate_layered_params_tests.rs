use super::{LayerMaterialParams, RenderPacket, validate_packet};
use serde_json::{Value, json};

fn packet(layered: Value) -> RenderPacket {
    let mut input: Value =
        serde_json::from_str(include_str!("../../fixtures/render_packet_v1.json")).unwrap();
    input["materials"][0]["layered"] = layered;
    serde_json::from_value(input).unwrap()
}

fn params() -> LayerMaterialParams {
    serde_json::from_value(json!({"ior":1.5,"clearcoat":{"factor":0,"roughness":0},
        "anisotropy":{"strength":0,"rotation":0},"transmission":{"factor":0}}))
    .unwrap()
}

fn set(params: &mut LayerMaterialParams, field: &str, value: f32) {
    match field {
        "ior" => params.ior = Some(value),
        "clearcoat.factor" => params.clearcoat.as_mut().unwrap().factor = Some(value),
        "clearcoat.roughness" => params.clearcoat.as_mut().unwrap().roughness = Some(value),
        "anisotropy.strength" => params.anisotropy.as_mut().unwrap().strength = Some(value),
        "anisotropy.rotation" => params.anisotropy.as_mut().unwrap().rotation = Some(value),
        "transmission.factor" => params.transmission.as_mut().unwrap().factor = Some(value),
        _ => unreachable!(),
    }
}

#[test]
fn native_layered_parameter_guard_rejects_each_active_lobe_at_both_layer_indices() {
    for (field, extension) in [
        (
            "anisotropy.strength",
            json!({"anisotropy":{"strength":0.8}}),
        ),
        (
            "transmission.factor",
            json!({"transmission":{"factor":0.6}}),
        ),
    ] {
        for index in 0..2 {
            let mut input = json!({"layers":[{"coverage":0.5},{"coverage":0.5}]});
            input["layers"][index]["params"] = extension.clone();
            let p = packet(input);
            let message = validate_packet(&p).unwrap_err();
            assert!(
                message.contains(&format!("layered.layers[{index}].params.{field}")),
                "{message}"
            );
            assert!(
                message.contains(&format!(
                    "Native layered materials do not support nonzero {field}."
                )),
                "{message}"
            );
        }
    }
}

#[test]
fn native_layered_parameter_guard_rejects_active_base_lobes() {
    for (field, base) in [
        ("clearcoat.factor", json!({"clearcoat":{"factor":0.7}})),
        (
            "anisotropy.strength",
            json!({"anisotropy":{"strength":0.8}}),
        ),
        (
            "transmission.factor",
            json!({"transmission":{"factor":0.6}}),
        ),
    ] {
        let p = packet(json!({"base":base,"layers":[{"coverage":0},{"coverage":0.5}]}));
        assert!(
            validate_packet(&p)
                .unwrap_err()
                .contains(&format!("layered.base.{field}"))
        );
    }
}

#[test]
fn native_layered_parameter_guard_keeps_zero_coverage_and_zero_factor_carriers() {
    for coverage in [Value::Null, json!(0)] {
        let mut layer = json!({"params":{"clearcoat":{"factor":0.7,"roughness":0.9},
            "anisotropy":{"strength":0.8,"rotation":10000},"transmission":{"factor":0.6}}});
        if coverage != Value::Null {
            layer["coverage"] = coverage;
        }
        let p = packet(json!({"base":{"clearcoat":{"factor":0.7}},"layers":[layer]}));
        validate_packet(&p).unwrap();
    }
    let p = packet(
        json!({"base":{"ior":1.5,"clearcoat":{"roughness":1},"anisotropy":{"rotation":-10000}},
        "layers":[{"coverage":1,"mode":"overlay","params":{"ior":1.2,
            "clearcoat":{"factor":0,"roughness":0.7},"anisotropy":{"strength":0,"rotation":10000},
            "transmission":{"factor":0}}}]}),
    );
    validate_packet(&p).unwrap();
}

#[test]
fn native_layered_parameter_guard_checks_all_numeric_domains_even_when_pruned() {
    for field in [
        "ior",
        "clearcoat.factor",
        "clearcoat.roughness",
        "anisotropy.strength",
        "anisotropy.rotation",
        "transmission.factor",
    ] {
        let invalid: &[f32] = match field {
            "ior" => &[0.5, f32::NAN, f32::INFINITY, f32::NEG_INFINITY],
            "anisotropy.rotation" => &[f32::NAN, f32::INFINITY, f32::NEG_INFINITY],
            _ => &[-0.1, 1.1, f32::NAN, f32::INFINITY, f32::NEG_INFINITY],
        };
        for &value in invalid {
            for location in 0..4 {
                let mut p = packet(json!({"layers":[{"coverage":0.5},{"coverage":0}]}));
                let layered = p.materials[0].layered.as_mut().unwrap();
                let mut bad = params();
                set(&mut bad, field, value);
                let expected = match location {
                    0 | 3 => {
                        layered.base = Some(bad);
                        if location == 3 {
                            layered.layers.clear();
                        }
                        format!("layered.base.{field}")
                    }
                    _ => {
                        let index = location - 1;
                        layered.layers[index].params = Some(bad);
                        format!("layered.layers[{index}].params.{field}")
                    }
                };
                let message = validate_packet(&p).unwrap_err();
                assert!(
                    message.contains(&expected),
                    "{field}={value} location={location}: {message}"
                );
            }
        }
    }
}

#[test]
fn native_layered_parameter_guard_matches_active_base_ior_to_stock_ior() {
    let mut p = packet(json!({"base":{"ior":1.2},"layers":[{"coverage":0.5}]}));
    assert!(
        validate_packet(&p)
            .unwrap_err()
            .contains("Layer base IOR must match")
    );
    p.materials[0].ior = Some(1.2);
    validate_packet(&p).unwrap();
    p.materials[0].layered.as_mut().unwrap().base = None;
    assert!(
        validate_packet(&p)
            .unwrap_err()
            .contains("Layer base IOR must match")
    );
    p.materials[0].layered.as_mut().unwrap().layers[0].coverage = Some(0.0);
    validate_packet(&p).unwrap();
}

#[test]
fn native_layered_parameter_guard_keeps_stock_and_valid_layer_ior_without_mutation() {
    let mut p = packet(json!({"layers":[{"coverage":1,"params":{"ior":2}}]}));
    let before = p.materials[0].layered.clone();
    validate_packet(&p).unwrap();
    assert_eq!(p.materials[0].layered, before);
    p.materials[0].layered = None;
    validate_packet(&p).unwrap();
}

#[test]
fn native_layered_parameter_guard_keeps_existing_coverage_and_surface_rejection() {
    for layered in [
        json!({"layers":[{"coverage":1.1}]}),
        json!({"layers":[{"coverage":0.5,"surface":{"roughness":1.1}}]}),
        json!({"layers":[{}, {}, {}]}),
    ] {
        assert!(validate_packet(&packet(layered)).is_err());
    }
}

#[test]
fn native_layered_parameter_guard_keeps_serde_unknown_and_null_fields_closed() {
    for layered in [
        json!({"base":{"ior":null},"layers":[]}),
        json!({"layers":[{"params":{"clearcoat":{"factor":"0"}}}]}),
        json!({"layers":[{"params":{"unknown":1}}]}),
        json!({"layers":[{"mode":"screen"}]}),
    ] {
        let mut input: Value =
            serde_json::from_str(include_str!("../../fixtures/render_packet_v1.json")).unwrap();
        input["materials"][0]["layered"] = layered;
        assert!(serde_json::from_value::<RenderPacket>(input).is_err());
    }
}

#[test]
fn native_layered_parameter_guard_accepts_active_layer_clearcoat_without_mutation() {
    for index in 0..2 {
        let mut input = json!({"layers":[{"coverage":0.75},{"coverage":0.75}]});
        input["layers"][index]["params"] = json!({"clearcoat":{"factor":0.7,"roughness":0.3}});
        let p = packet(input);
        let before = p.materials[0].layered.clone();
        validate_packet(&p).unwrap();
        assert_eq!(p.materials[0].layered, before);
    }
}
