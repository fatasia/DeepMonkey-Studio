use std::fs;

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPainterIssueCode, Deep2dPathVerb, Deep2dResource,
    decode_display_list, default_display_list_fixture_path, prepare_display_list,
};

fn fixture() -> Deep2dDisplayList {
    let bytes = fs::read(default_display_list_fixture_path()).expect("fixture");
    decode_display_list(&bytes).expect("valid path-only fixture")
}

#[test]
fn prepares_real_fill_and_stroke_triangles_in_z_order() {
    let prepared = prepare_display_list(&fixture()).expect("supported display list");
    assert_eq!(prepared.logical_width, 960.0);
    assert_eq!(prepared.logical_height, 640.0);
    assert_eq!(prepared.summary.commands, 3);
    assert_eq!(prepared.summary.path_segments, 9);
    assert_eq!(prepared.summary.fill_triangles, 4);
    assert_eq!(prepared.summary.stroke_triangles, 2);
    assert_eq!(prepared.summary.vertices, 18);
    assert!(
        prepared
            .vertices
            .iter()
            .take(6)
            .any(|vertex| vertex[0..2] == [36.0, 36.0])
    );
    assert_eq!(&prepared.vertices[0][2..6], &[0.025, 0.055, 0.095, 0.88]);
    assert_eq!(&prepared.vertices[6][2..6], &[0.12, 0.82, 0.68, 1.0]);
}

#[test]
fn applies_canvas_affine_transform_before_gpu_upload() {
    let mut display_list = fixture();
    let Deep2dCommand::Path(command) = &mut display_list.commands[0] else {
        panic!("path command")
    };
    command.transform = [2.0, 0.0, 0.0, 3.0, 10.0, 20.0];
    command.opacity = Some(0.5);
    let prepared = prepare_display_list(&display_list).expect("transformed display list");
    assert!(prepared.vertices.iter().take(6).any(|vertex| {
        vertex[0..2] == [82.0, 128.0] && (vertex[5] - 0.44).abs() < f32::EPSILON
    }));
}

#[test]
fn rejects_invalid_contract_before_preparing_any_gpu_geometry() {
    let mut display_list = fixture();
    display_list.logical_width = 0.0;
    let error = prepare_display_list(&display_list).expect_err("invalid contract");
    assert_eq!(
        error.issues[0].code,
        Deep2dPainterIssueCode::InvalidDisplayList
    );
    assert_eq!(error.issues[0].path, "logicalWidth");
}

#[test]
fn rejects_clips_and_dashes_with_structured_issues() {
    let mut clipped = fixture();
    let Deep2dCommand::Path(command) = &mut clipped.commands[0] else {
        panic!("path command")
    };
    command.clip_path_ids = Some(vec!["overlay:status".into()]);
    assert_first_code(&clipped, Deep2dPainterIssueCode::UnsupportedClip);

    let mut dashed = fixture();
    let Deep2dCommand::Path(command) = &mut dashed.commands[2] else {
        panic!("path command")
    };
    command.dash = Some(vec![4.0, 2.0]);
    assert_first_code(&dashed, Deep2dPainterIssueCode::UnsupportedDash);
}

#[test]
fn rejects_text_and_image_instead_of_silently_skipping_them() {
    let source = include_str!("../fixtures/deep2d_display_list_v1.json");
    let display_list = decode_display_list(source.as_bytes()).expect("full contract fixture");
    let error = prepare_display_list(&display_list).expect_err("unsupported commands");
    assert!(error.issues.iter().any(|issue| issue.code
        == Deep2dPainterIssueCode::UnsupportedCommand
        && issue.path == "commands[1]"));
    assert!(error.issues.iter().any(|issue| issue.code
        == Deep2dPainterIssueCode::UnsupportedCommand
        && issue.path == "commands[2]"));
    let serialized = serde_json::to_value(error).expect("structured painter error");
    assert_eq!(serialized["issues"][1]["code"], "unsupported-command");
}

#[test]
fn supports_concave_fills_and_open_multi_segment_strokes() {
    let mut concave = fixture();
    set_path_points(
        &mut concave,
        0,
        &[
            [0.0, 0.0],
            [10.0, 0.0],
            [5.0, 5.0],
            [10.0, 10.0],
            [0.0, 10.0],
        ],
        true,
    );
    let prepared = prepare_display_list(&concave).expect("concave polygon");
    assert_eq!(prepared.summary.fill_triangles, 5);

    let mut multi_stroke = fixture();
    set_path_points(
        &mut multi_stroke,
        2,
        &[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]],
        false,
    );
    let prepared = prepare_display_list(&multi_stroke).expect("multi-segment stroke");
    assert_eq!(prepared.summary.stroke_triangles, 4);
}

#[test]
fn rejects_open_fills_and_self_intersecting_polygons() {
    let mut open_fill = fixture();
    set_path_points(
        &mut open_fill,
        0,
        &[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]],
        false,
    );
    assert_first_code(&open_fill, Deep2dPainterIssueCode::UnsupportedGeometry);

    let mut bow_tie = fixture();
    set_path_points(
        &mut bow_tie,
        0,
        &[[0.0, 0.0], [10.0, 10.0], [0.0, 10.0], [10.0, 0.0]],
        true,
    );
    assert_first_code(&bow_tie, Deep2dPainterIssueCode::UnsupportedGeometry);
}

fn assert_first_code(display_list: &Deep2dDisplayList, code: Deep2dPainterIssueCode) {
    let error = prepare_display_list(display_list).expect_err("painter must reject");
    assert_eq!(error.issues[0].code, code);
}

fn set_path_points(
    display_list: &mut Deep2dDisplayList,
    resource_index: usize,
    points: &[[f64; 2]],
    closed: bool,
) {
    let Deep2dResource::Path(resource) = &mut display_list.resources[resource_index] else {
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
        .collect();
    if closed {
        resource.verbs.push(Deep2dPathVerb::Close);
    }
}
