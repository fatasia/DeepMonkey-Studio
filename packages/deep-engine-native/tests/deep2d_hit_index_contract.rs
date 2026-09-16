//! D07 clip-constraint behavior golden: hits respect clipPathIds (nested,
//! transformed) and clipRect exactly like the painter's paint region.

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dRect, Deep2dResource, ImageColorSpace,
    ImageCommand, ImageResource, PathCommand, PathResource, build_hit_index,
};

fn ring_resource(id: &str, points: &[[f64; 2]]) -> PathResource {
    let mut verbs = vec![Deep2dPathVerb::Move {
        x: points[0][0],
        y: points[0][1],
    }];
    for point in &points[1..] {
        verbs.push(Deep2dPathVerb::Line {
            x: point[0],
            y: point[1],
        });
    }
    verbs.push(Deep2dPathVerb::Close);
    PathResource {
        id: id.into(),
        revision: 1,
        verbs,
    }
}

fn identity() -> [f64; 6] {
    [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
}

fn display_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "hit-clip-test".into(),
        revision: 1,
        logical_width: 20.0,
        logical_height: 20.0,
        scale_factor: 1.0,
        resources: vec![
            Deep2dResource::Path(ring_resource(
                "big",
                &[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
            )),
            Deep2dResource::Path(ring_resource(
                "clip",
                &[[4.0, 4.0], [8.0, 4.0], [8.0, 8.0], [4.0, 8.0]],
            )),
            Deep2dResource::Path(ring_resource(
                "clip-narrow",
                &[[4.0, 4.0], [6.0, 4.0], [6.0, 8.0], [4.0, 8.0]],
            )),
            Deep2dResource::Image(ImageResource {
                id: "img".into(),
                revision: 1,
                asset_id: "asset:img".into(),
                width: 2,
                height: 2,
                color_space: ImageColorSpace::Srgb,
            }),
        ],
        commands: vec![Deep2dCommand::Path(PathCommand {
            id: "panel".into(),
            z_order: 0,
            transform: identity(),
            opacity: None,
            clip_path_ids: Some(vec!["clip".into()]),
            clip_rect: None,
            hit_id: Some("panel-hit".into()),
            path_id: "big".into(),
            fill: Some([1.0, 1.0, 1.0, 1.0]),
            fill_rule: None,
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

#[test]
fn clip_excludes_hits_outside_the_clip_ring_but_inside_the_fill() {
    let index = build_hit_index(&display_list()).expect("index builds");
    // (5,5) is inside both the fill ring and the clip square: hit.
    let hit = index.hit([5.0, 5.0]).expect("clipped fill hit");
    assert_eq!(hit.id, "panel");
    // (2,2) is inside the fill ring but OUTSIDE the clip square: no hit,
    // even though the unclipped geometry covers it.
    assert!(
        index.hit([2.0, 2.0]).is_none(),
        "clip must exclude the region the painter never paints"
    );
}

#[test]
fn nested_clips_intersect_and_clip_rect_composes() {
    // Two clips: their intersection is [4,6]×[4,8]; (7,5) lies in the fill
    // and the first clip but outside the narrow one.
    let mut nested = display_list();
    let Deep2dCommand::Path(command) = &mut nested.commands[0] else {
        panic!("path command")
    };
    command.clip_path_ids = Some(vec!["clip".into(), "clip-narrow".into()]);
    let index = build_hit_index(&nested).expect("index builds");
    assert!(index.hit([5.0, 5.0]).is_some(), "inside both clips");
    assert!(
        index.hit([7.0, 5.0]).is_none(),
        "outside the narrow clip must miss"
    );

    // clipRect composes with clip rings: shrinking to y∈[4,6] also excludes
    // (5,7) even though both rings contain it.
    let mut rect_clipped = display_list();
    let Deep2dCommand::Path(command) = &mut rect_clipped.commands[0] else {
        panic!("path command")
    };
    command.clip_rect = Some(Deep2dRect {
        x: 0.0,
        y: 4.0,
        width: 20.0,
        height: 2.0,
    });
    let index = build_hit_index(&rect_clipped).expect("index builds");
    assert!(index.hit([5.0, 5.0]).is_some());
    assert!(index.hit([5.0, 7.0]).is_none(), "clipRect must bound hits");
}

#[test]
fn transformed_clip_follows_the_command_transform() {
    // Translate the whole command (fill + clip together) by +10 on x.
    let mut moved = display_list();
    let Deep2dCommand::Path(command) = &mut moved.commands[0] else {
        panic!("path command")
    };
    command.transform = [1.0, 0.0, 0.0, 1.0, 10.0, 0.0];
    let index = build_hit_index(&moved).expect("index builds");
    // Fill ring [0,10]² and clip [4,8]² both move to x∈[10,20]/[14,18].
    let hit = index.hit([15.0, 5.0]).expect("translated clip hit");
    assert_eq!(hit.id, "panel");
    assert!(
        index.hit([5.0, 5.0]).is_none(),
        "original clip region must not hit after the transform"
    );
}

#[test]
fn open_clip_shape_fails_closed_like_the_painter() {
    let mut bad = display_list();
    bad.resources[1] = Deep2dResource::Path(PathResource {
        id: "clip".into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 4.0, y: 4.0 },
            Deep2dPathVerb::Line { x: 8.0, y: 4.0 },
        ],
    });
    let error = build_hit_index(&bad).expect_err("open clip must fail closed");
    let message = format!("{error:?}");
    assert!(
        message.contains("UnsupportedClip") || message.contains("closed simple subpath"),
        "unexpected error: {message}"
    );
}

#[test]
fn image_command_respects_its_own_clip() {
    let mut list = display_list();
    list.commands.push(Deep2dCommand::Image(ImageCommand {
        id: "sprite".into(),
        z_order: 1,
        transform: identity(),
        opacity: None,
        clip_path_ids: Some(vec!["clip".into()]),
        clip_rect: None,
        hit_id: None,
        image_id: "img".into(),
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        atlas_id: None,
        source: None,
        sampling: None,
    }));
    let index = build_hit_index(&list).expect("index builds");
    // Image quad spans [0,10]² but its clip confines hits to [4,8]².
    let hit = index.hit([5.0, 5.0]).expect("clipped image hit");
    assert_eq!(hit.id, "sprite");
    assert!(
        index.hit([1.0, 1.0]).is_none(),
        "image quad outside its clip must not hit"
    );
}
