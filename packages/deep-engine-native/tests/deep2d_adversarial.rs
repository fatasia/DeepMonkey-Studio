use std::fs;

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPainterIssueCode, Deep2dPathVerb, Deep2dResource,
    decode_display_list, default_display_list_fixture_path, prepare_display_list,
};

fn fixture() -> Deep2dDisplayList {
    let bytes = fs::read(default_display_list_fixture_path()).expect("fixture");
    decode_display_list(&bytes).expect("valid fixture")
}

#[test]
fn rejects_near_collinear_fill_and_near_reversing_stroke() {
    let mut near_collinear = fixture();
    set_path(
        &mut near_collinear,
        0,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 1_000.0, y: 0.0 },
            Deep2dPathVerb::Line {
                x: 1_000.0,
                y: 1e-10,
            },
            Deep2dPathVerb::Line { x: 0.0, y: 100.0 },
            Deep2dPathVerb::Close,
        ],
    );
    assert_rejected(&near_collinear, Deep2dPainterIssueCode::UnsupportedGeometry);

    let mut reversal = fixture();
    set_path(
        &mut reversal,
        2,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 1e-13 },
        ],
    );
    assert_rejected(&reversal, Deep2dPainterIssueCode::UnsupportedGeometry);
}

#[test]
fn extreme_valid_coordinates_and_transform_remain_finite_and_deterministic() {
    let mut display_list = fixture();
    let Deep2dCommand::Path(command) = &mut display_list.commands[0] else {
        panic!("path command")
    };
    command.transform = [
        16_000_000.0,
        0.0,
        0.0,
        -16_000_000.0,
        16_000_000.0,
        -16_000_000.0,
    ];
    let first = prepare_display_list(&display_list).expect("extreme transform");
    let second = prepare_display_list(&display_list).expect("repeat extreme transform");
    assert_eq!(first.vertices, second.vertices);
    assert!(
        first
            .vertices
            .iter()
            .flatten()
            .all(|value| value.is_finite())
    );
}

#[test]
fn curve_tessellation_budget_fails_closed_under_extreme_scale() {
    let mut display_list = fixture();
    set_path(
        &mut display_list,
        2,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Cubic {
                c1x: 0.0,
                c1y: 16_000_000.0,
                c2x: 16_000_000.0,
                c2y: -16_000_000.0,
                x: 16_000_000.0,
                y: 0.0,
            },
        ],
    );
    let Deep2dCommand::Path(command) = &mut display_list.commands[2] else {
        panic!("path command")
    };
    command.transform = [16_000_000.0, 0.0, 0.0, 16_000_000.0, 0.0, 0.0];
    assert_rejected(
        &display_list,
        Deep2dPainterIssueCode::TessellationBudgetExceeded,
    );
}

#[test]
fn rejects_round_style_and_multiple_subpaths_explicitly() {
    let mut round = fixture();
    let Deep2dCommand::Path(command) = &mut round.commands[2] else {
        panic!("path command")
    };
    command.line_cap = Some(deep_engine_native::deep2d::LineCap::Round);
    assert_rejected(&round, Deep2dPainterIssueCode::UnsupportedStyle);

    let mut multiple = fixture();
    set_path(
        &mut multiple,
        2,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            Deep2dPathVerb::Move { x: 20.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 30.0, y: 0.0 },
        ],
    );
    assert_rejected(&multiple, Deep2dPainterIssueCode::UnsupportedGeometry);
}

fn set_path(display_list: &mut Deep2dDisplayList, index: usize, verbs: Vec<Deep2dPathVerb>) {
    let Deep2dResource::Path(resource) = &mut display_list.resources[index] else {
        panic!("path resource")
    };
    resource.verbs = verbs;
}

fn assert_rejected(display_list: &Deep2dDisplayList, code: Deep2dPainterIssueCode) {
    let error = prepare_display_list(display_list).expect_err("painter must reject");
    assert_eq!(error.issues[0].code, code, "{error:?}");
}
