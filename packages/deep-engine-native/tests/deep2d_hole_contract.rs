//! Single-level hole fill contract: with a fill rule set, the first closed
//! subpath is the outer ring and later closed subpaths are holes bridged into
//! it. The hole interior must never be covered by any triangle; outer regions
//! must stay covered for both nonzero and evenodd rules.

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, FillRule, PathCommand,
    PathResource, prepare_display_list,
};

fn ring(x: f64, y: f64, size: f64) -> Vec<Deep2dPathVerb> {
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

fn display_list(fill_rule: Option<FillRule>, hole_winding: f64) -> Deep2dDisplayList {
    // Outer 40x40 (CCW). The hole is a 20x20 square centred at (20, 20);
    // `hole_winding` flips it so nonzero and evenodd can both be exercised.
    let mut verbs = ring(0.0, 0.0, 40.0);
    // Same 20x20 hole centred at (20, 20); `hole_winding` only flips the
    // traversal direction (CCW vs CW in place).
    let mut hole = vec![Deep2dPathVerb::Move { x: 10.0, y: 10.0 }];
    if hole_winding >= 0.0 {
        hole.push(Deep2dPathVerb::Line { x: 10.0, y: 30.0 });
        hole.push(Deep2dPathVerb::Line { x: 30.0, y: 30.0 });
        hole.push(Deep2dPathVerb::Line { x: 30.0, y: 10.0 });
    } else {
        hole.push(Deep2dPathVerb::Line { x: 30.0, y: 10.0 });
        hole.push(Deep2dPathVerb::Line { x: 30.0, y: 30.0 });
        hole.push(Deep2dPathVerb::Line { x: 10.0, y: 30.0 });
    }
    hole.push(Deep2dPathVerb::Close);
    verbs.append(&mut hole);
    Deep2dDisplayList {
        schema_version: 1,
        id: "holes".into(),
        revision: 1,
        logical_width: 40.0,
        logical_height: 40.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Path(PathResource {
            id: "shape".into(),
            revision: 1,
            verbs,
        })],
        commands: vec![Deep2dCommand::Path(PathCommand {
            id: "draw:shape".into(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            path_id: "shape".into(),
            fill: Some([1.0, 1.0, 1.0, 1.0]),
            fill_rule,
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        })],
        atlases: Vec::new(),
    }
}

fn point_in_triangle(point: [f64; 2], triangle: [[f64; 2]; 3]) -> bool {
    let signed = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let (d1, d2, d3) = (
        signed(triangle[0], triangle[1], point),
        signed(triangle[1], triangle[2], point),
        signed(triangle[2], triangle[0], point),
    );
    let has_negative = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let has_positive = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(has_negative && has_positive)
}

fn triangles(prepared: &deep_engine_native::deep2d::PreparedDeep2d) -> Vec<[[f64; 2]; 3]> {
    prepared
        .vertices
        .chunks_exact(3)
        .map(|triangle| {
            triangle
                .iter()
                .map(|vertex| [f64::from(vertex[0]), f64::from(vertex[1])])
                .collect::<Vec<_>>()
                .try_into()
                .expect("3 vertices")
        })
        .collect()
}

fn assert_hole_and_frame(triangles: &[[[f64; 2]; 3]]) {
    let hole_center = [20.0, 20.0];
    let outer_corner = [5.0, 5.0];
    let far_corner = [35.0, 35.0];
    assert!(
        !triangles
            .iter()
            .any(|triangle| point_in_triangle(hole_center, *triangle)),
        "hole centre must stay uncovered"
    );
    assert!(
        triangles
            .iter()
            .any(|triangle| point_in_triangle(outer_corner, *triangle)),
        "outer frame corner must stay covered"
    );
    assert!(
        triangles
            .iter()
            .any(|triangle| point_in_triangle(far_corner, *triangle)),
        "far frame corner must stay covered"
    );
}

#[test]
fn nonzero_rule_bridges_same_winding_hole() {
    let prepared = prepare_display_list(&display_list(Some(FillRule::Nonzero), 1.0))
        .expect("nonzero hole display list");
    // 3 outer + split bridge pair + 3 hole + 1 tail -> 9 ring vertices, 7 triangles.
    assert_eq!(prepared.summary.fill_triangles, 7);
    let tris = triangles(&prepared);
    assert_eq!(tris.len(), 7);
    assert_hole_and_frame(&tris);
}

#[test]
fn evenodd_rule_bridges_opposite_winding_hole() {
    let prepared = prepare_display_list(&display_list(Some(FillRule::Evenodd), -1.0))
        .expect("evenodd hole display list");
    assert_eq!(prepared.summary.fill_triangles, 7);
    assert_hole_and_frame(&triangles(&prepared));
}

#[test]
fn no_fill_rule_keeps_independent_subpath_fills() {
    // Without a rule the two rects fill independently: the second rect covers
    // the would-be hole region, exactly matching pre-existing behaviour.
    let prepared = prepare_display_list(&display_list(None, 1.0)).expect("rule-less display list");
    assert_eq!(prepared.summary.fill_triangles, 4);
    let tris = triangles(&prepared);
    assert!(
        tris.iter()
            .any(|triangle| point_in_triangle([20.0, 20.0], *triangle)),
        "rule-less fills stay independent (no hole semantics)"
    );
}
