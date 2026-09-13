use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dIssueCode, Deep2dPathVerb, Deep2dResource,
    decode_display_list, validate_display_list,
};
use serde_json::{Value, json};

fn golden_json() -> Value {
    serde_json::from_str(include_str!("../fixtures/deep2d_display_list_v1.json"))
        .expect("golden fixture")
}

fn parse(value: &Value) -> Deep2dDisplayList {
    serde_json::from_value(value.clone()).expect("typed Deep2dDisplayList")
}

fn codes(display_list: &Deep2dDisplayList) -> Vec<Deep2dIssueCode> {
    validate_display_list(display_list)
        .issues
        .into_iter()
        .map(|issue| issue.code)
        .collect()
}

#[test]
fn accepts_golden_batch_and_preserves_wire_shape() {
    let source = golden_json();
    let display_list = decode_display_list(&serde_json::to_vec(&source).expect("json"))
        .expect("valid display list");
    assert_eq!(display_list.resources.len(), 3);
    assert_eq!(display_list.commands.len(), 3);
    let encoded = serde_json::to_value(display_list).expect("serialize");
    assert!(encoded["commands"][0].get("opacity").is_none());
    assert!(decode_display_list(&serde_json::to_vec(&encoded).expect("json")).is_ok());
}

#[test]
fn strict_serde_rejects_unknown_missing_null_and_wrong_enum_fields() {
    for (label, invalid) in [
        ("envelope unknown", {
            let mut value = golden_json();
            value["extra"] = true.into();
            value
        }),
        ("required null", {
            let mut value = golden_json();
            value["commands"][0]["pathId"] = Value::Null;
            value
        }),
        ("optional null", {
            let mut value = golden_json();
            value["commands"][0]["opacity"] = Value::Null;
            value
        }),
        ("bad enum", {
            let mut value = golden_json();
            value["commands"][1]["align"] = "left".into();
            value
        }),
        ("z-order overflow", {
            let mut value = golden_json();
            value["commands"][0]["zOrder"] = 2_147_483_648_u64.into();
            value
        }),
        ("verb unknown", {
            let mut value = golden_json();
            value["resources"][0]["verbs"][1]["unexpected"] = 1.into();
            value
        }),
        ("resource unknown", {
            let mut value = golden_json();
            value["resources"][1]["unexpected"] = 1.into();
            value
        }),
        ("command unknown", {
            let mut value = golden_json();
            value["commands"][2]["unexpected"] = 1.into();
            value
        }),
    ] {
        let error = decode_display_list(&serde_json::to_vec(&invalid).expect("json"))
            .err()
            .unwrap_or_else(|| panic!("strict decoding must fail: {label}"));
        assert!(
            error.contains("invalid Deep2dDisplayList JSON"),
            "unexpected error for {label}: {error}"
        );
    }

    let source = include_str!("../fixtures/deep2d_display_list_v1.json");
    let lone_surrogate = source.replace("\"温度 / °C\"", r#""\ud800""#);
    assert!(decode_display_list(lone_surrogate.as_bytes()).is_err());
}

#[test]
fn reports_envelope_ids_revisions_and_duplicate_resource_ids() {
    let mut value = golden_json();
    value["schemaVersion"] = 2.into();
    value["logicalWidth"] = 0.into();
    value["revision"] = 9_007_199_254_740_992_u64.into();
    let duplicate = value["resources"][0].clone();
    value["resources"]
        .as_array_mut()
        .expect("resources")
        .push(duplicate);
    assert_eq!(
        codes(&parse(&value)),
        vec![
            Deep2dIssueCode::InvalidSchemaVersion,
            Deep2dIssueCode::InvalidRevision,
            Deep2dIssueCode::InvalidNumber,
            Deep2dIssueCode::DuplicateId,
        ]
    );
}

#[test]
fn validates_path_grammar_coordinates_and_resource_metadata() {
    let mut display_list = parse(&golden_json());
    let Deep2dResource::Path(path) = &mut display_list.resources[0] else {
        panic!("path resource")
    };
    path.verbs = vec![
        Deep2dPathVerb::Line { x: 0.0, y: 1.0 },
        Deep2dPathVerb::Move {
            x: f64::NAN,
            y: 0.0,
        },
        Deep2dPathVerb::Close,
        Deep2dPathVerb::Close,
    ];
    let Deep2dResource::Font(font) = &mut display_list.resources[1] else {
        panic!("font resource")
    };
    font.family = " ".into();
    font.weight = 450;
    let Deep2dResource::Image(image) = &mut display_list.resources[2] else {
        panic!("image resource")
    };
    image.width = 0;
    let result = validate_display_list(&display_list);
    assert!(!result.valid);
    for expected in [
        Deep2dIssueCode::InvalidPath,
        Deep2dIssueCode::InvalidStructure,
        Deep2dIssueCode::InvalidNumber,
    ] {
        assert!(result.issues.iter().any(|issue| issue.code == expected));
    }
}

#[test]
fn validates_typed_references_clips_paint_colors_and_dimensions() {
    let mut display_list = parse(&golden_json());
    let Deep2dCommand::Path(path) = &mut display_list.commands[0] else {
        panic!("path command")
    };
    path.path_id = "font:ui".into();
    path.clip_path_ids = Some(vec!["missing".into()]);
    path.stroke = Some([2.0, 0.0, 0.0, 1.0]);
    path.stroke_width = Some(0.0);
    let Deep2dCommand::Text(text) = &mut display_list.commands[1] else {
        panic!("text command")
    };
    text.font_id = "series:line".into();
    text.font_size = -1.0;
    let Deep2dCommand::Image(image) = &mut display_list.commands[2] else {
        panic!("image command")
    };
    image.image_id = "missing".into();
    image.width = 0.0;
    let result = validate_display_list(&display_list);
    for expected in [
        Deep2dIssueCode::MissingResource,
        Deep2dIssueCode::ResourceKindMismatch,
        Deep2dIssueCode::InvalidColor,
        Deep2dIssueCode::InvalidNumber,
    ] {
        assert!(result.issues.iter().any(|issue| issue.code == expected));
    }
}

#[test]
fn duplicate_resources_keep_the_first_resource_kind_for_reference_checks() {
    let mut value = golden_json();
    let duplicate = json!({
        "kind": "font", "id": "series:line", "revision": 0,
        "assetId": "asset:font", "family": "Inter", "weight": 400,
        "style": "normal"
    });
    value["resources"]
        .as_array_mut()
        .expect("resources")
        .push(duplicate);
    let result = validate_display_list(&parse(&value));
    assert_eq!(
        result
            .issues
            .iter()
            .map(|issue| issue.code)
            .collect::<Vec<_>>(),
        vec![Deep2dIssueCode::DuplicateId]
    );
}

#[test]
fn rejects_reserved_non_ascii_and_malformed_identifiers() {
    let mut display_list = parse(&golden_json());
    display_list.id = "__proto__".into();
    let Deep2dResource::Font(font) = &mut display_list.resources[1] else {
        panic!("font resource")
    };
    font.asset_id = "资源:font".into();
    let Deep2dCommand::Text(text) = &mut display_list.commands[1] else {
        panic!("text command")
    };
    text.hit_id = Some(":bad-first-character".into());
    assert_eq!(
        validate_display_list(&display_list)
            .issues
            .iter()
            .filter(|issue| issue.code == Deep2dIssueCode::InvalidId)
            .count(),
        3
    );
}

#[test]
fn validates_cross_field_paint_rules_and_semantic_decode_failure() {
    let mut display_list = parse(&golden_json());
    let Deep2dCommand::Path(path) = &mut display_list.commands[0] else {
        panic!("path command")
    };
    path.stroke = None;
    path.stroke_width = None;
    path.dash = None;
    path.line_join = None;
    path.fill = None;
    let result = validate_display_list(&display_list);
    assert_eq!(result.issues[0].code, Deep2dIssueCode::EmptyPaint);

    let bytes = serde_json::to_vec(&display_list).expect("semantic fixture");
    let error = decode_display_list(&bytes).expect_err("semantic validation must reject");
    assert!(error.contains("Path command requires fill or stroke"));
    assert!(error.contains("commands[0]"));
}
