use deep_engine_native::contract::{
    DEFAULT_LOD_HYSTERESIS_RATIO, RenderLodProfile, RenderPacket, validate_packet,
};
use serde_json::{Value, json};

fn packet(level_count: usize) -> Value {
    let mut value: Value =
        serde_json::from_str(include_str!("../fixtures/render_packet_textured_v1.json"))
            .expect("textured fixture");
    let source = value["geometries"][0].clone();
    value["geometries"] = Value::Array(
        (0..level_count)
            .map(|index| {
                let mut geometry = source.clone();
                geometry["id"] = json!(format!("lod-{index}"));
                geometry["indices"] = json!([0, 1, 2].repeat(level_count - index));
                geometry
            })
            .collect(),
    );
    value["instances"]
        .as_array_mut()
        .expect("instances")
        .truncate(1);
    value["instances"][0]["geometry"] = json!("lod-0");
    value["instances"][0]["lod"] = json!({
        "levels": (0..level_count).map(|index| json!({
            "geometry": format!("lod-{index}"),
            "minProjectedDiameterPixels": (level_count - index - 1) * 80,
            "geometricError": index as f64 * 0.1
        })).collect::<Vec<_>>()
    });
    value
}

fn parse(value: &Value) -> Result<RenderPacket, String> {
    let packet: RenderPacket = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    validate_packet(&packet)?;
    Ok(packet)
}

fn rejects(value: &Value, expected: &str) {
    let error = parse(value).expect_err("invalid LOD contract");
    assert!(
        error.contains(expected),
        "expected {expected:?}, received {error:?}"
    );
}

#[test]
fn accepts_two_through_eight_levels_and_preserves_absent_defaults() {
    for count in 2..=8 {
        let loaded = parse(&packet(count)).expect("valid LOD");
        let lod = loaded.instances[0].lod.as_ref().expect("LOD");
        assert_eq!(lod.levels.len(), count);
        assert_eq!(lod.hysteresis_ratio(), DEFAULT_LOD_HYSTERESIS_RATIO);
        assert!(lod.levels.iter().all(|level| level.is_resident()));
        let encoded = serde_json::to_value(lod).expect("encode LOD");
        assert!(encoded.get("hysteresisRatio").is_none());
        assert!(encoded["levels"][0].get("resident").is_none());
        let roundtrip: RenderLodProfile = serde_json::from_value(encoded).expect("roundtrip");
        assert_eq!(roundtrip.hysteresis_ratio(), 0.12);
    }
    let mut legacy = packet(2);
    legacy["instances"][0]
        .as_object_mut()
        .unwrap()
        .remove("lod");
    assert!(
        parse(&legacy).expect("legacy contract").instances[0]
            .lod
            .is_none()
    );
}

#[test]
fn accepts_numeric_boundaries_and_nonresident_middle_level() {
    for hysteresis in [0.0, 0.49] {
        let mut value = packet(3);
        let lod = &mut value["instances"][0]["lod"];
        lod["hysteresisRatio"] = json!(hysteresis);
        lod["levels"][0]["minProjectedDiameterPixels"] = json!(1e9);
        lod["levels"][2]["geometricError"] = json!(1e15);
        lod["levels"][1]["resident"] = json!(false);
        let loaded = parse(&value).expect("inclusive boundaries");
        let lod = loaded.instances[0].lod.as_ref().unwrap();
        assert_eq!(lod.hysteresis_ratio(), hysteresis);
        assert!(!lod.levels[1].is_resident());
    }
}

#[test]
fn rejects_invalid_level_counts_missing_resources_and_primary_mismatch() {
    for count in [0, 1, 9] {
        let mut value = packet(2);
        let level = value["instances"][0]["lod"]["levels"][0].clone();
        value["instances"][0]["lod"]["levels"] = json!(vec![level; count]);
        rejects(&value, "must have 2-8 levels");
    }
    let mut missing = packet(2);
    missing["instances"][0]["lod"]["levels"][1]["geometry"] = json!("missing");
    rejects(&missing, "missing LOD geometry");
    missing["instances"][0]["lod"]["levels"][0]["geometry"] = json!("lod-1");
    rejects(&missing, "primary geometry");
}

#[test]
fn rejects_non_descending_thresholds_and_triangle_counts() {
    for threshold in [160, 161] {
        let mut value = packet(3);
        value["instances"][0]["lod"]["levels"][1]["minProjectedDiameterPixels"] = json!(threshold);
        rejects(&value, "thresholds must strictly decrease");
    }
    for triangles in [3, 4] {
        let mut value = packet(3);
        value["geometries"][1]["indices"] = json!([0, 1, 2].repeat(triangles));
        rejects(&value, "triangle counts must strictly decrease");
    }
    let mut value = packet(3);
    value["instances"][0]["lod"]["levels"][2]["minProjectedDiameterPixels"] = json!(1);
    rejects(&value, "coarsest LOD threshold must be zero");
    value = packet(3);
    value["instances"][0]["lod"]["levels"][2]["geometricError"] = json!(0);
    rejects(&value, "geometric errors must not decrease");
}

#[test]
fn rejects_thresholds_that_collapse_after_float32_conversion() {
    for thresholds in [[180.0000001, 180.0, 0.0], [180.0, 1e-50, 0.0]] {
        let mut value = packet(3);
        for (index, threshold) in thresholds.into_iter().enumerate() {
            value["instances"][0]["lod"]["levels"][index]["minProjectedDiameterPixels"] =
                json!(threshold);
        }
        rejects(&value, "strictly decrease after float32 conversion");
    }
}

#[test]
fn rejects_numeric_outliers_and_nonfinite_values_in_direct_contracts() {
    for (field, number, error) in [
        ("minProjectedDiameterPixels", -1.0, "invalid LOD threshold"),
        (
            "minProjectedDiameterPixels",
            1e9 + 1.0,
            "invalid LOD threshold",
        ),
        ("geometricError", -0.1, "invalid LOD geometric error"),
        ("geometricError", 1e15 + 1.0, "invalid LOD geometric error"),
    ] {
        let mut value = packet(2);
        value["instances"][0]["lod"]["levels"][0][field] = json!(number);
        rejects(&value, error);
    }
    for ratio in [-0.001, 0.491] {
        let mut value = packet(2);
        value["instances"][0]["lod"]["hysteresisRatio"] = json!(ratio);
        rejects(&value, "hysteresis ratio");
    }
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for field in 0..3 {
            let mut value = parse(&packet(2)).unwrap();
            let lod = value.instances[0].lod.as_mut().unwrap();
            match field {
                0 => lod.hysteresis_ratio = Some(invalid),
                1 => lod.levels[0].min_projected_diameter_pixels = invalid,
                _ => lod.levels[0].geometric_error = invalid,
            }
            assert!(validate_packet(&value).is_err());
        }
    }
}

#[test]
fn rejects_null_wrong_types_missing_required_fields_and_unknown_fields() {
    for path in [
        "/instances/0/lod",
        "/instances/0/lod/levels",
        "/instances/0/lod/hysteresisRatio",
        "/instances/0/lod/levels/0/resident",
        "/instances/0/lod/levels/0/geometry",
        "/instances/0/lod/levels/0/geometricError",
        "/instances/0/lod/levels/0/minProjectedDiameterPixels",
    ] {
        let mut value = packet(2);
        value["instances"][0]["lod"]["hysteresisRatio"] = json!(0.12);
        value["instances"][0]["lod"]["levels"][0]["resident"] = json!(true);
        *value.pointer_mut(path).unwrap() = Value::Null;
        rejects(&value, "invalid type");
    }
    for path in ["/instances/0/lod", "/instances/0/lod/levels/0"] {
        let mut value = packet(2);
        value.pointer_mut(path).unwrap()["unexpected"] = json!(true);
        rejects(&value, "unknown field");
    }
    for field in ["geometry", "geometricError", "minProjectedDiameterPixels"] {
        let mut value = packet(2);
        value["instances"][0]["lod"]["levels"][0]
            .as_object_mut()
            .unwrap()
            .remove(field);
        rejects(&value, "missing field");
    }
    let mut value = packet(2);
    value["instances"][0]["lod"]["levels"][0]["resident"] = json!(1);
    rejects(&value, "invalid type");
}

#[test]
fn requires_resident_primary_and_coarsest_geometry() {
    for (index, error) in [(0, "primary LOD geometry"), (2, "coarsest LOD geometry")] {
        let mut value = packet(3);
        value["instances"][0]["lod"]["levels"][index]["resident"] = json!(false);
        rejects(&value, error);
    }
}

#[test]
fn checks_material_uv_and_tangent_requirements_on_every_lod_including_nonresident() {
    for level in 0..3 {
        for (attribute, error) in [
            ("uv0", "requires UV0"),
            ("uv1", "requires UV1"),
            ("tangents", "tangent basis"),
        ] {
            let mut value = packet(3);
            value["instances"][0]["lod"]["levels"][1]["resident"] = json!(false);
            value["geometries"][level]
                .as_object_mut()
                .unwrap()
                .remove(attribute);
            rejects(&value, error);
        }
    }
}

#[test]
fn out_of_range_indices_with_tangents_fail_without_panicking() {
    let mut value = packet(2);
    value["geometries"][1]["indices"][0] = json!(999);
    rejects(&value, "out-of-range index");
}

#[test]
fn consumes_the_shared_browser_lod_runtime_package_without_losing_profiles() {
    use deep_engine_native::runtime_package::parse_and_validate_runtime_package;

    let loaded =
        parse_and_validate_runtime_package(include_bytes!("fixtures/runtime-package-lod-v1.json"))
            .expect("shared browser LOD package");
    assert_eq!(loaded.render_packet.geometries.len(), 3);
    assert_eq!(loaded.render_packet.instances.len(), 7);
    for instance in &loaded.render_packet.instances {
        let profile = instance.lod.as_ref().expect("authored LOD preserved");
        assert_eq!(profile.hysteresis_ratio(), 0.12);
        assert_eq!(profile.levels.len(), 3);
        assert_eq!(profile.levels[0].geometry, instance.geometry);
        assert_eq!(
            profile
                .levels
                .iter()
                .map(|level| level.min_projected_diameter_pixels)
                .collect::<Vec<_>>(),
            [180.0, 80.0, 0.0]
        );
        assert!(profile.levels[0].is_resident());
        assert!(!profile.levels[1].is_resident());
        assert!(profile.levels[2].is_resident());
    }
}
