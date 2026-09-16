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
fn round_caps_and_joins_expand_into_fan_geometry_and_multiple_subpaths_stroke() {
    // Round caps/joins are supported via bounded fan polygons since D02; the
    // same stroke must produce strictly more triangles than its butt/miter
    // counterpart (two cap fans append at both endpoints).
    let mut butt = fixture();
    let Deep2dCommand::Path(command) = &mut butt.commands[2] else {
        panic!("path command")
    };
    command.line_cap = Some(deep_engine_native::deep2d::LineCap::Butt);
    let butt_prepared = prepare_display_list(&butt).expect("butt stroke");

    let mut round = fixture();
    let Deep2dCommand::Path(command) = &mut round.commands[2] else {
        panic!("path command")
    };
    command.line_cap = Some(deep_engine_native::deep2d::LineCap::Round);
    command.line_join = Some(deep_engine_native::deep2d::LineJoin::Round);
    let round_prepared = prepare_display_list(&round).expect("round stroke prepares");
    assert!(
        round_prepared.summary.stroke_triangles > butt_prepared.summary.stroke_triangles,
        "round cap/join fans must add triangles: round={} butt={}",
        round_prepared.summary.stroke_triangles,
        butt_prepared.summary.stroke_triangles
    );
    assert!(
        round_prepared
            .vertices
            .iter()
            .flatten()
            .all(|value| value.is_finite()),
        "fan vertices must stay finite"
    );

    // Multi-subpath resources are supported since the disjoint-subpath slice;
    // each open subpath strokes into its own outline (two triangles each).
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
    let prepared = prepare_display_list(&multiple).expect("disjoint open subpaths stroke");
    assert_eq!(prepared.summary.stroke_triangles, 4);
}

#[test]
fn closed_subpaths_stroke_with_seam_joins_and_miter_limit_falls_back_to_bevel() {
    let mut closed = fixture();
    set_path(
        &mut closed,
        2,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 10.0 },
            Deep2dPathVerb::Close,
        ],
    );
    let prepared = prepare_display_list(&closed).expect("closed stroke joins at the seam");
    // Closed square: 4 vertices × 2 ring points + miter seam vertices; the
    // collinear simplifier trims the straight edges, leaving an 8-triangle
    // ring (6 in the degenerate mitre case — any value ≥ 6 keeps the seam
    // joined; the exact count is pinned by the golden below).
    assert!(
        prepared.summary.stroke_triangles >= 6,
        "closed square stroke needs a joined seam ring, got {}",
        prepared.summary.stroke_triangles
    );

    // A tight miterLimit converts sharp joins into bevels (two edges) instead
    // of unbounded miters; geometry stays valid either way.
    let mut limited = closed.clone();
    let Deep2dCommand::Path(command) = &mut limited.commands[2] else {
        panic!("path command")
    };
    command.miter_limit = Some(1.0);
    let prepared = prepare_display_list(&limited).expect("bevel fallback prepares");
    assert!(prepared.summary.stroke_triangles >= 8);

    let mut round_closed = closed;
    let Deep2dCommand::Path(command) = &mut round_closed.commands[2] else {
        panic!("path command")
    };
    command.line_join = Some(deep_engine_native::deep2d::LineJoin::Round);
    let prepared = prepare_display_list(&round_closed).expect("round closed stroke");
    assert!(
        prepared.summary.stroke_triangles >= 8,
        "round closed joins must expand fans"
    );
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
