//! Display-list image quad contract: atlases feed `ImageCommand`, pixel data is
//! decoded and size-checked at preparation, and quads interleave with paths by
//! z-order. GPU presentation reuses the proven atlas pipeline unchanged.

use deep_engine_native::deep2d::{
    Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand, Deep2dDisplayList,
    Deep2dIssueCode, Deep2dPathVerb, Deep2dRect, Deep2dResource, Deep2dRuntimeContent,
    ImageColorSpace, ImageCommand, ImageResource, ImageSampling, PathCommand, PathResource,
    PreparedDeep2dChunkKind, prepare_display_list, prepare_runtime_content, validate_display_list,
};

const TILE_ATLAS_BASE64: &str = "/wAA/wAA//8=";

fn atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "tiles".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: TILE_ATLAS_BASE64.into(),
    }
}

fn image_command(id: &str, z: i32, atlas_id: Option<&str>) -> Deep2dCommand {
    Deep2dCommand::Image(image_command_data(id, z, atlas_id))
}

fn image_command_data(id: &str, z: i32, atlas_id: Option<&str>) -> ImageCommand {
    deep_engine_native::deep2d::ImageCommand {
        id: id.into(),
        z_order: z,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        image_id: "img".into(),
        x: 0.0,
        y: 0.0,
        width: 4.0,
        height: 1.0,
        atlas_id: atlas_id.map(str::to_owned),
        source: atlas_id.map(|_| [0u32, 0, 2, 1]),
        sampling: None,
    }
}

fn display_list(commands: Vec<Deep2dCommand>) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "image-contract".into(),
        revision: 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Image(ImageResource {
            id: "img".into(),
            revision: 1,
            asset_id: "asset:img".into(),
            width: 2,
            height: 1,
            color_space: ImageColorSpace::Srgb,
        })],
        commands,
        atlases: vec![atlas()],
    }
}

fn image_only_display_list() -> Deep2dDisplayList {
    display_list(vec![image_command("draw:tile", 0, Some("tiles"))])
}

#[test]
fn image_quad_flows_to_atlas_vertices_with_exact_uvs() {
    let runtime =
        prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(image_only_display_list()))
            .expect("image display list prepares");
    assert_eq!(runtime.summary.image_quads, 1);
    assert_eq!(runtime.atlases.len(), 1);
    assert_eq!(runtime.atlas_vertices.len(), 6);
    assert_eq!(runtime.summary.atlas_vertices, 6);
    assert_eq!(runtime.summary.atlas_batches, 1);
    assert_eq!(runtime.summary.render_chunks, 1);
    assert!(matches!(
        runtime.chunks[0].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 0 }
    ));

    // Two triangles across a 4x1 logical quad sampling the full 2x1 atlas.
    let positions: Vec<[f32; 2]> = runtime
        .atlas_vertices
        .iter()
        .map(|vertex| [vertex[0], vertex[1]])
        .collect();
    let expected_corners: Vec<[f32; 2]> = vec![[0.0, 0.0], [4.0, 0.0], [4.0, 1.0], [0.0, 1.0]];
    for corner in expected_corners {
        assert!(
            positions
                .iter()
                .any(|candidate| (candidate[0] - corner[0]).abs() < 1e-4
                    && (candidate[1] - corner[1]).abs() < 1e-4),
            "corner {corner:?} missing from {positions:?}"
        );
    }
    // Every sampled u stays inside the atlas; v covers the single row.
    for vertex in &runtime.atlas_vertices {
        let (u, v) = (vertex[2], vertex[3]);
        assert!((0.0..=1.0).contains(&u) && (0.0..=1.0).contains(&v));
    }
    // Glyph modulation must be off for image atlases.
    assert!(runtime.atlas_vertices.iter().all(|vertex| vertex[8] == 0.0));
}

#[test]
fn image_and_path_commands_interleave_by_z_order() {
    let mut display_list = image_only_display_list();
    let path = path_resource();
    display_list.resources.push(path);
    display_list
        .commands
        .insert(0, path_command("draw:under", 0));
    display_list.commands.push(path_command("draw:over", 2));
    let runtime = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(display_list))
        .expect("interleaved display list");
    assert_eq!(runtime.chunks.len(), 3, "z-ordered kinds must not merge");
    assert!(matches!(
        runtime.chunks[0].kind,
        PreparedDeep2dChunkKind::Path
    ));
    assert!(matches!(
        runtime.chunks[1].kind,
        PreparedDeep2dChunkKind::Atlas { .. }
    ));
    assert!(matches!(
        runtime.chunks[2].kind,
        PreparedDeep2dChunkKind::Path
    ));
}

#[test]
fn image_clip_survives_preparation_as_an_atlas_scissor() {
    let mut display_list = image_only_display_list();
    let clip = Deep2dRect {
        x: 1.0,
        y: 0.0,
        width: 2.0,
        height: 1.0,
    };
    let Deep2dCommand::Image(image) = &mut display_list.commands[0] else {
        unreachable!()
    };
    image.clip_rect = Some(clip);
    let runtime = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(display_list))
        .expect("clipped image prepares");
    assert_eq!(runtime.chunks.len(), 1);
    assert_eq!(runtime.chunks[0].clip_rect, Some(clip));
}

#[test]
fn images_without_an_atlas_stay_rejected_with_actionable_reasons() {
    let mut unattributed = image_only_display_list();
    if let Deep2dCommand::Image(command) = &mut unattributed.commands[0] {
        command.atlas_id = None;
        command.source = None;
    }
    let error = prepare_display_list(&unattributed).expect_err("no pixel source");
    assert!(error.to_string().contains("atlasId"));

    let mut orphan = image_only_display_list();
    if let Deep2dCommand::Image(command) = &mut orphan.commands[0] {
        command.atlas_id = Some("missing-atlas".into());
        command.source = Some([0, 0, 2, 1]);
    }
    let validation = validate_display_list(&orphan);
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.path == "commands[0].atlasId"
                && issue.code == Deep2dIssueCode::MissingResource)
    );

    let mut out_of_bounds = image_only_display_list();
    if let Deep2dCommand::Image(command) = &mut out_of_bounds.commands[0] {
        command.source = Some([0, 0, 3, 1]);
    }
    let validation = validate_display_list(&out_of_bounds);
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.path == "commands[0].source"
                && issue.message.contains("escapes the atlas bounds"))
    );

    let mut source_without_atlas = image_only_display_list();
    if let Deep2dCommand::Image(command) = &mut source_without_atlas.commands[0] {
        command.source = Some([0, 0, 2, 1]);
        command.atlas_id = None;
    }
    let validation = validate_display_list(&source_without_atlas);
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.message.contains("requires atlasId"))
    );
}

#[test]
fn atlas_resources_validate_dims_kind_and_duplicates() {
    let mut glyph = image_only_display_list();
    glyph.atlases[0].kind = Deep2dAtlasKind::Glyph;
    let validation = validate_display_list(&glyph);
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.path == "atlases[0].format")
    );

    let mut duplicated = image_only_display_list();
    duplicated.atlases.push(atlas());
    let validation = validate_display_list(&duplicated);
    assert!(
        validation.issues.iter().any(
            |issue| issue.code == Deep2dIssueCode::DuplicateId && issue.path == "atlases[1].id"
        )
    );

    // Corrupt pixel payloads fail at preparation, after contract validation.
    let mut short_data = image_only_display_list();
    short_data.atlases[0].data_base64 = "AAAA".into();
    let error = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(short_data))
        .expect_err("short atlas payload");
    assert!(error.contains("pixel data"), "{error}");
}

fn path_command(id: &str, z: i32) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: id.into(),
        z_order: z,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        path_id: "frame".into(),
        fill: Some([1.0, 1.0, 1.0, 1.0]),
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

fn path_resource() -> Deep2dResource {
    Deep2dResource::Path(PathResource {
        id: "frame".into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 4.0, y: 0.0 },
            Deep2dPathVerb::Line { x: 4.0, y: 1.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 1.0 },
            Deep2dPathVerb::Close,
        ],
    })
}
