use deep_engine_native::deep2d::{
    Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand, Deep2dDisplayList,
    Deep2dPainterIssueCode, Deep2dPathVerb, Deep2dResource, Deep2dRuntimeContent, ImageColorSpace,
    ImageCommand, ImageResource, ImageSampling, PathCommand, PathResource, prepare_display_list,
    prepare_runtime_content,
};

fn rectangle(id: &str, x: f64, y: f64, width: f64, height: f64) -> Deep2dResource {
    Deep2dResource::Path(PathResource {
        id: id.into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x, y },
            Deep2dPathVerb::Line { x: x + width, y },
            Deep2dPathVerb::Line {
                x: x + width,
                y: y + height,
            },
            Deep2dPathVerb::Line { x, y: y + height },
            Deep2dPathVerb::Close,
        ],
    })
}

fn path_command(clips: &[&str]) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: "draw:canvas".into(),
        z_order: 0,
        transform: [1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
        opacity: None,
        clip_path_ids: Some(clips.iter().map(|id| (*id).into()).collect()),
        clip_rect: None,
        hit_id: None,
        path_id: "canvas".into(),
        fill: Some([1.0, 0.0, 0.0, 1.0]),
        fill_rule: None,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
    })
}

fn path_list(clips: Vec<Deep2dResource>, ids: &[&str]) -> Deep2dDisplayList {
    let mut resources = vec![rectangle("canvas", 0.0, 0.0, 4.0, 4.0)];
    resources.extend(clips);
    Deep2dDisplayList {
        schema_version: 1,
        id: "path-clip".into(),
        revision: 1,
        logical_width: 6.0,
        logical_height: 4.0,
        scale_factor: 1.0,
        resources,
        commands: vec![path_command(ids)],
        atlases: vec![],
    }
}

fn area6(vertices: &[[f32; 6]]) -> f32 {
    vertices
        .chunks_exact(3)
        .map(|triangle| {
            let a = triangle[0];
            let b = triangle[1];
            let c = triangle[2];
            ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).abs() * 0.5
        })
        .sum()
}

#[test]
fn convex_and_multiple_path_clips_intersect_in_command_space() {
    let single = path_list(vec![rectangle("left", 0.0, 0.0, 2.0, 4.0)], &["left"]);
    let prepared = prepare_display_list(&single).expect("convex clip");
    assert!((area6(&prepared.vertices) - 8.0).abs() < 1e-4);
    assert!(
        prepared
            .vertices
            .iter()
            .all(|vertex| { (1.0..=3.0).contains(&vertex[0]) && (0.0..=4.0).contains(&vertex[1]) })
    );

    let intersected = path_list(
        vec![
            rectangle("left", 0.0, 0.0, 2.0, 4.0),
            rectangle("right", 1.0, 0.0, 3.0, 4.0),
        ],
        &["left", "right"],
    );
    let prepared = prepare_display_list(&intersected).expect("two clip intersection");
    assert!((area6(&prepared.vertices) - 4.0).abs() < 1e-4);
    assert!(
        prepared
            .vertices
            .iter()
            .all(|vertex| (2.0..=3.0).contains(&vertex[0]))
    );
}

#[test]
fn concave_path_clip_uses_a_deterministic_triangle_union() {
    let concave = Deep2dResource::Path(PathResource {
        id: "concave".into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 3.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 3.0, y: 1.0 },
            Deep2dPathVerb::Line { x: 1.0, y: 1.0 },
            Deep2dPathVerb::Line { x: 1.0, y: 3.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 3.0 },
            Deep2dPathVerb::Close,
        ],
    });
    let list = path_list(vec![concave], &["concave"]);
    let first = prepare_display_list(&list).expect("concave clip");
    let second = prepare_display_list(&list).expect("repeat");
    assert_eq!(first.vertices, second.vertices);
    assert!((area6(&first.vertices) - 5.0).abs() < 1e-4);
}

#[test]
fn image_clip_interpolates_uvs_and_fully_clipped_draws_disappear() {
    let mut list = path_list(vec![rectangle("left", 0.0, 0.0, 2.0, 4.0)], &["left"]);
    list.resources.push(Deep2dResource::Image(ImageResource {
        id: "image".into(),
        revision: 1,
        asset_id: "embedded:image".into(),
        width: 2,
        height: 1,
        color_space: ImageColorSpace::Srgb,
    }));
    list.atlases.push(Deep2dAtlas {
        id: "image-atlas".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: "/wAA/wAA//8=".into(),
    });
    list.commands = vec![Deep2dCommand::Image(ImageCommand {
        id: "draw:image".into(),
        z_order: 0,
        transform: [1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
        opacity: None,
        clip_path_ids: Some(vec!["left".into()]),
        clip_rect: None,
        hit_id: None,
        image_id: "image".into(),
        x: 0.0,
        y: 0.0,
        width: 4.0,
        height: 4.0,
        atlas_id: Some("image-atlas".into()),
        source: Some([0, 0, 2, 1]),
        sampling: Some(ImageSampling::Nearest),
    })];
    let runtime = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list.clone()))
        .expect("clipped image");
    assert_eq!(runtime.summary.image_quads, 1);
    assert!(
        runtime
            .atlas_vertices
            .iter()
            .all(|vertex| (1.0..=3.0).contains(&vertex[0]) && vertex[2] <= 0.500_001)
    );

    list.resources[1] = rectangle("left", 10.0, 0.0, 2.0, 4.0);
    let runtime = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list))
        .expect("fully clipped image");
    assert!(runtime.atlas_vertices.is_empty());
    assert!(runtime.chunks.is_empty());
    assert_eq!(runtime.summary.image_quads, 0);
}

#[test]
fn open_clip_path_fails_with_a_machine_readable_issue() {
    let mut open = rectangle("open", 0.0, 0.0, 2.0, 2.0);
    let Deep2dResource::Path(path) = &mut open else {
        unreachable!()
    };
    path.verbs.pop();
    let error = prepare_display_list(&path_list(vec![open], &["open"]))
        .expect_err("open clip cannot publish");
    assert_eq!(
        error.issues[0].code,
        Deep2dPainterIssueCode::UnsupportedClip
    );
    assert_eq!(error.issues[0].path, "commands[0].clipPathIds[0]");
}
