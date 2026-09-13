use std::fs;

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, LineCap, LineJoin,
    decode_display_list, default_display_list_fixture_path, prepare_display_list,
};

fn fixture() -> Deep2dDisplayList {
    let bytes = fs::read(default_display_list_fixture_path()).expect("fixture");
    decode_display_list(&bytes).expect("valid fixture")
}

#[test]
fn adaptively_flattens_quadratic_and_cubic_strokes_deterministically() {
    let mut display_list = fixture();
    let Deep2dResource::Path(resource) = &mut display_list.resources[2] else {
        panic!("path resource")
    };
    resource.verbs = vec![
        Deep2dPathVerb::Move { x: 52.0, y: 124.0 },
        Deep2dPathVerb::Quadratic {
            cx: 120.0,
            cy: 42.0,
            x: 190.0,
            y: 124.0,
        },
        Deep2dPathVerb::Cubic {
            c1x: 238.0,
            c1y: 180.0,
            c2x: 286.0,
            c2y: 68.0,
            x: 334.0,
            y: 124.0,
        },
    ];
    let Deep2dCommand::Path(command) = &mut display_list.commands[2] else {
        panic!("path command")
    };
    command.line_cap = Some(LineCap::Square);
    command.line_join = Some(LineJoin::Miter);
    command.miter_limit = Some(6.0);
    let first = prepare_display_list(&display_list).expect("curved stroke");
    let second = prepare_display_list(&display_list).expect("repeat curved stroke");
    assert_eq!(first, second);
    assert!(first.summary.stroke_triangles > 20);
    assert!(
        first
            .vertices
            .iter()
            .flatten()
            .all(|value| value.is_finite())
    );
    display_list.scale_factor = 4.0;
    let high_dpi = prepare_display_list(&display_list).expect("high-DPI curved stroke");
    assert!(
        high_dpi.summary.path_segments > first.summary.path_segments,
        "curve flattening must preserve the physical-pixel error bound on high-DPI surfaces"
    );
}

#[test]
fn adaptively_flattens_a_closed_quadratic_fill() {
    let mut display_list = fixture();
    let Deep2dResource::Path(resource) = &mut display_list.resources[0] else {
        panic!("path resource")
    };
    resource.verbs = vec![
        Deep2dPathVerb::Move { x: 40.0, y: 100.0 },
        Deep2dPathVerb::Quadratic {
            cx: 196.0,
            cy: 10.0,
            x: 352.0,
            y: 100.0,
        },
        Deep2dPathVerb::Line { x: 352.0, y: 180.0 },
        Deep2dPathVerb::Line { x: 40.0, y: 180.0 },
        Deep2dPathVerb::Close,
    ];
    let prepared = prepare_display_list(&display_list).expect("curved fill");
    assert!(prepared.summary.fill_triangles > 10);
}

#[test]
fn square_caps_extend_beyond_butt_caps() {
    let butt = prepare_display_list(&fixture()).expect("butt stroke");
    let mut square_list = fixture();
    let Deep2dCommand::Path(command) = &mut square_list.commands[2] else {
        panic!("path command")
    };
    command.line_cap = Some(LineCap::Square);
    let square = prepare_display_list(&square_list).expect("square stroke");
    let butt_stroke = &butt.vertices[butt.vertices.len() - 6..];
    let square_stroke = &square.vertices[square.vertices.len() - 6..];
    let butt_min_x = butt_stroke
        .iter()
        .map(|vertex| vertex[0])
        .fold(f32::INFINITY, f32::min);
    let square_min_x = square_stroke
        .iter()
        .map(|vertex| vertex[0])
        .fold(f32::INFINITY, f32::min);
    assert!(square_min_x < butt_min_x);
}

#[test]
fn miter_limit_falls_back_to_the_same_outline_as_bevel() {
    let mut bevel = fixture();
    set_stroke_corner(&mut bevel);
    let Deep2dCommand::Path(command) = &mut bevel.commands[2] else {
        panic!("path command")
    };
    command.line_join = Some(LineJoin::Bevel);

    let mut limited_miter = bevel.clone();
    let Deep2dCommand::Path(command) = &mut limited_miter.commands[2] else {
        panic!("path command")
    };
    command.line_join = Some(LineJoin::Miter);
    command.miter_limit = Some(1.0);
    assert_eq!(
        prepare_display_list(&bevel).expect("bevel").vertices,
        prepare_display_list(&limited_miter)
            .expect("limited miter")
            .vertices
    );
}

#[test]
fn concave_fill_accepts_both_winding_directions() {
    let mut forward = fixture();
    let points = [
        [20.0, 20.0],
        [180.0, 20.0],
        [180.0, 140.0],
        [100.0, 90.0],
        [20.0, 140.0],
    ];
    set_closed_polygon(&mut forward, &points);
    let mut reverse = fixture();
    let reversed = points.into_iter().rev().collect::<Vec<_>>();
    set_closed_polygon(&mut reverse, &reversed);
    let forward = prepare_display_list(&forward).expect("forward winding");
    let reverse = prepare_display_list(&reverse).expect("reverse winding");
    assert_eq!(
        forward.summary.fill_triangles,
        reverse.summary.fill_triangles
    );
}

fn set_stroke_corner(display_list: &mut Deep2dDisplayList) {
    let Deep2dResource::Path(resource) = &mut display_list.resources[2] else {
        panic!("path resource")
    };
    resource.verbs = vec![
        Deep2dPathVerb::Move { x: 40.0, y: 120.0 },
        Deep2dPathVerb::Line { x: 180.0, y: 60.0 },
        Deep2dPathVerb::Line { x: 330.0, y: 130.0 },
    ];
}

fn set_closed_polygon(display_list: &mut Deep2dDisplayList, points: &[[f64; 2]]) {
    let Deep2dResource::Path(resource) = &mut display_list.resources[0] else {
        panic!("path resource")
    };
    resource.verbs = points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            if index == 0 {
                Deep2dPathVerb::Move {
                    x: point[0],
                    y: point[1],
                }
            } else {
                Deep2dPathVerb::Line {
                    x: point[0],
                    y: point[1],
                }
            }
        })
        .chain(std::iter::once(Deep2dPathVerb::Close))
        .collect();
}
