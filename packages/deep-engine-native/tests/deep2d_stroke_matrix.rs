//! D02 combination matrix: stroke geometry under negative/nonuniform scales,
//! DPI tiers and dash interactions. Each case pins the failure-or-geometry
//! outcome so painter behavior stays deterministic across the matrix.

use std::fs;

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPainterIssueCode, Deep2dPathVerb, Deep2dResource,
    decode_display_list, default_display_list_fixture_path, prepare_display_list,
};

fn fixture() -> Deep2dDisplayList {
    let bytes = fs::read(default_display_list_fixture_path()).expect("fixture");
    decode_display_list(&bytes).expect("valid fixture")
}

fn set_stroke_path(list: &mut Deep2dDisplayList, verbs: Vec<Deep2dPathVerb>) {
    let Deep2dResource::Path(resource) = &mut list.resources[2] else {
        panic!("path resource")
    };
    resource.verbs = verbs;
}

fn open_l() -> Vec<Deep2dPathVerb> {
    vec![
        Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
        Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
    ]
}

#[test]
fn negative_and_nonuniform_scales_produce_finite_deterministic_geometry() {
    let matrices: Vec<[f64; 6]> = vec![
        [-1.0, 0.0, 0.0, 1.0, 10.0, 0.0], // mirror X
        [1.0, 0.0, 0.0, -1.0, 0.0, 10.0], // mirror Y
        [-1.0, 0.0, 0.0, -1.0, 0.0, 0.0], // 180° rotation
        [2.0, 0.0, 0.0, 0.5, 0.0, 0.0],   // nonuniform 2x/0.5x
        [-2.0, 0.0, 0.0, 0.5, 5.0, 5.0],  // mirror + nonuniform + translate
        [
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
            -std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
            0.0,
            0.0,
        ], // 45° rotation
    ];
    for matrix in matrices {
        let mut list = fixture();
        set_stroke_path(&mut list, open_l());
        let Deep2dCommand::Path(command) = &mut list.commands[2] else {
            panic!("path command")
        };
        command.transform = matrix;
        command.line_join = Some(deep_engine_native::deep2d::LineJoin::Round);
        command.line_cap = Some(deep_engine_native::deep2d::LineCap::Round);
        let prepared = prepare_display_list(&list)
            .unwrap_or_else(|error| panic!("matrix {matrix:?} rejected: {error:?}"));
        assert!(
            prepared
                .vertices
                .iter()
                .flatten()
                .all(|value| value.is_finite()),
            "matrix {matrix:?} produced non-finite vertices"
        );
        let repeat = prepare_display_list(&list).expect("repeat");
        assert_eq!(
            prepared.vertices, repeat.vertices,
            "matrix {matrix:?} must be deterministic"
        );
    }
}

#[test]
fn dpi_tiers_scale_vertex_counts_monotonically_for_curves() {
    // Higher scale factors flatten curves finer: stroke triangle counts must
    // be non-decreasing across DPI tiers for the same rounded stroke.
    let mut counts = Vec::new();
    for scale in [1.0, 1.25, 1.5, 2.0] {
        let mut list = fixture();
        set_stroke_path(
            &mut list,
            vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Cubic {
                    c1x: 3.0,
                    c1y: 2.0,
                    c2x: 7.0,
                    c2y: -2.0,
                    x: 10.0,
                    y: 0.0,
                },
            ],
        );
        let Deep2dCommand::Path(command) = &mut list.commands[2] else {
            panic!("path command")
        };
        command.line_cap = Some(deep_engine_native::deep2d::LineCap::Round);
        list.scale_factor = scale;
        let prepared = prepare_display_list(&list).expect("curved stroke prepares");
        counts.push(prepared.summary.stroke_triangles);
    }
    for window in counts.windows(2) {
        assert!(
            window[1] >= window[0],
            "stroke tessellation must not coarsen with higher DPI: {counts:?}"
        );
    }
}

#[test]
fn dash_combinations_with_round_caps_and_closed_paths_stay_bounded() {
    // Odd-length dash + negative offset + round caps on an open path.
    let mut open = fixture();
    set_stroke_path(&mut open, open_l());
    let Deep2dCommand::Path(command) = &mut open.commands[2] else {
        panic!("path command")
    };
    command.dash = Some(vec![3.0, 1.0, 2.0]);
    command.dash_offset = Some(-7.0);
    command.line_cap = Some(deep_engine_native::deep2d::LineCap::Round);
    let prepared = prepare_display_list(&open).expect("odd dash + round caps");
    assert!(
        prepared.summary.stroke_triangles > 4,
        "dashes split the stroke"
    );

    // Dash + closed subpath: dash expansion emits open segments, so the
    // closed-stroke seam logic must not double-count the closing edge.
    let mut closed = fixture();
    set_stroke_path(
        &mut closed,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 10.0 },
            Deep2dPathVerb::Close,
        ],
    );
    let Deep2dCommand::Path(command) = &mut closed.commands[2] else {
        panic!("path command")
    };
    command.dash = Some(vec![4.0, 2.0]);
    let prepared = prepare_display_list(&closed).expect("dashed closed stroke");
    assert!(prepared.summary.stroke_triangles >= 4);
    assert!(
        prepared
            .vertices
            .iter()
            .flatten()
            .all(|value| value.is_finite())
    );
}

#[test]
fn extreme_miter_limit_and_zero_width_boundaries_fail_closed_or_prepare() {
    // miterLimit 1.0 forces bevels at the sharp corner — legal.
    let mut limited = fixture();
    set_stroke_path(&mut limited, open_l());
    let Deep2dCommand::Path(command) = &mut limited.commands[2] else {
        panic!("path command")
    };
    command.miter_limit = Some(1.0);
    let _ = prepare_display_list(&limited).expect("miterLimit 1.0 is legal");

    // 180° reversal inside a stroke remains rejected (UnsupportedGeometry).
    let mut reversal = fixture();
    set_stroke_path(
        &mut reversal,
        vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 1e-13 },
        ],
    );
    let error = prepare_display_list(&reversal).expect_err("reversal rejected");
    assert_eq!(
        error.issues[0].code,
        Deep2dPainterIssueCode::UnsupportedGeometry
    );
}
