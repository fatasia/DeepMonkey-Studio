//! Multi-subpath contract: `Move` starts disjoint subpaths, fills/strokes cover
//! every subpath, and degenerate authoring (empty subpath, duplicate close,
//! self-intersection, cross-subpath overlap, budget overflow) fails closed.

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, PathResource,
    prepare_display_list,
};

fn display_list(verbs: Vec<Deep2dPathVerb>, fill: bool) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "multisubpath".into(),
        revision: 1,
        logical_width: 100.0,
        logical_height: 100.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Path(PathResource {
            id: "shape".into(),
            revision: 1,
            verbs,
        })],
        commands: vec![Deep2dCommand::Path(path_command(fill))],
        atlases: Vec::new(),
    }
}

fn path_command(fill: bool) -> deep_engine_native::deep2d::PathCommand {
    deep_engine_native::deep2d::PathCommand {
        id: "draw:shape".into(),
        z_order: 0,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        path_id: "shape".into(),
        fill: fill.then_some([0.9, 0.2, 0.1, 1.0]),
        fill_rule: None,
        stroke: (!fill).then_some([0.1, 0.1, 0.1, 1.0]),
        stroke_width: Some(2.0),
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
    }
}

fn rect(x: f64, y: f64, size: f64) -> Vec<Deep2dPathVerb> {
    vec![
        Deep2dPathVerb::Move { x, y },
        Deep2dPathVerb::Line { x: x + size, y },
        Deep2dPathVerb::Line {
            x: x + size,
            y: y + size,
        },
        Deep2dPathVerb::Line { x, y: y + size },
        Deep2dPathVerb::Close,
    ]
}

#[test]
fn two_disjoint_closed_subpaths_fill_independently() {
    let mut verbs = rect(10.0, 10.0, 20.0);
    verbs.extend(rect(50.0, 10.0, 20.0));
    let prepared = prepare_display_list(&display_list(verbs, true)).expect("disjoint rects");
    // Each rect contributes 2 triangles and its 4 outline segments.
    assert_eq!(prepared.summary.fill_triangles, 4);
    assert_eq!(prepared.summary.path_segments, 8);
    assert_eq!(prepared.summary.vertices, 12);
}

#[test]
fn two_open_subpaths_stroke_independently() {
    let verbs = vec![
        Deep2dPathVerb::Move { x: 0.0, y: 10.0 },
        Deep2dPathVerb::Line { x: 30.0, y: 10.0 },
        Deep2dPathVerb::Move { x: 0.0, y: 40.0 },
        Deep2dPathVerb::Line { x: 30.0, y: 40.0 },
    ];
    let prepared = prepare_display_list(&display_list(verbs, false)).expect("open strokes");
    assert_eq!(prepared.summary.stroke_triangles, 4);
    assert_eq!(prepared.summary.path_segments, 2);
}

#[test]
fn degenerate_subpath_authoring_fails_closed() {
    // Move followed by Move: the first subpath is empty.
    let empty = vec![
        Deep2dPathVerb::Move { x: 1.0, y: 1.0 },
        Deep2dPathVerb::Move { x: 5.0, y: 5.0 },
        Deep2dPathVerb::Line { x: 9.0, y: 9.0 },
        Deep2dPathVerb::Close,
    ];
    let error = prepare_display_list(&display_list(empty, true)).expect_err("one-point subpath");
    assert!(
        error.to_string().contains("at least two distinct points"),
        "{error}"
    );

    // Close followed by Close: duplicate close.
    let duplicated = vec![
        Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 8.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 8.0, y: 8.0 },
        Deep2dPathVerb::Close,
        Deep2dPathVerb::Close,
    ];
    // Duplicate close is caught one layer earlier by the verb-sequence check.
    let error = prepare_display_list(&display_list(duplicated, true)).expect_err("duplicate close");
    assert!(
        error
            .to_string()
            .contains("Each subpath must start with move"),
        "{error}"
    );

    // Geometry after close inside a multi-subpath list stays rejected.
    let mixed = vec![
        Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 8.0, y: 0.0 },
        Deep2dPathVerb::Close,
        Deep2dPathVerb::Move { x: 20.0, y: 20.0 },
        Deep2dPathVerb::Line { x: 28.0, y: 20.0 },
        Deep2dPathVerb::Close,
        Deep2dPathVerb::Line { x: 30.0, y: 30.0 },
    ];
    // Geometry after close is caught at the verb-sequence validation layer.
    let error = prepare_display_list(&display_list(mixed, true)).expect_err("geometry after close");
    assert!(
        error
            .to_string()
            .contains("Each subpath must start with move"),
        "{error}"
    );
}

#[test]
fn self_intersecting_and_overlapping_subpaths_fail_closed() {
    // Figure-eight within one closed subpath.
    let figure_eight = vec![
        Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 40.0, y: 40.0 },
        Deep2dPathVerb::Line { x: 40.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 0.0, y: 40.0 },
        Deep2dPathVerb::Close,
    ];
    let error = prepare_display_list(&display_list(figure_eight, true)).expect_err("self crossing");
    assert!(error.to_string().contains("self-intersecting"), "{error}");

    // Two closed subpaths that properly cross each other.
    let mut crossing = rect(0.0, 0.0, 30.0);
    crossing.extend(vec![
        Deep2dPathVerb::Move { x: 20.0, y: 10.0 },
        Deep2dPathVerb::Line { x: 35.0, y: 10.0 },
        Deep2dPathVerb::Line { x: 35.0, y: 12.0 },
        Deep2dPathVerb::Line { x: 20.0, y: 12.0 },
        Deep2dPathVerb::Close,
    ]);
    let error = prepare_display_list(&display_list(crossing, true)).expect_err("overlapping");
    assert!(error.to_string().contains("disjoint"), "{error}");
}

#[test]
fn disjoint_subpaths_touching_at_vertices_still_fill() {
    // Shared corner is vertex contact, not a proper crossing.
    let mut shared_corner = rect(0.0, 0.0, 20.0);
    shared_corner.extend(rect(20.0, 20.0, 20.0));
    let prepared =
        prepare_display_list(&display_list(shared_corner, true)).expect("vertex-touching subpaths");
    assert_eq!(prepared.summary.fill_triangles, 4);
}
