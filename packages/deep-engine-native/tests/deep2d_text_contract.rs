use deep_engine_native::deep2d::{
    BakedGlyphPlacement, Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand,
    Deep2dDisplayList, Deep2dIssueCode, Deep2dPainterIssueCode, Deep2dResource,
    Deep2dRuntimeContent, FontResource, FontStyle, ImageSampling, PreparedDeep2dChunkKind,
    TextCommand, prepare_display_list, prepare_runtime_content, validate_display_list,
};

fn glyph_atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "font-atlas".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Glyph,
        format: Deep2dAtlasFormat::R8Unorm,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: "/wA=".into(),
    }
}

fn text_command() -> TextCommand {
    TextCommand {
        id: "draw:text".into(),
        z_order: 3,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: Some(0.5),
        clip_path_ids: None,
        clip_rect: Some(deep_engine_native::deep2d::Deep2dRect {
            x: 2.0,
            y: 1.0,
            width: 4.0,
            height: 2.0,
        }),
        hit_id: None,
        text: "AB".into(),
        x: 2.0,
        y: 1.0,
        font_id: "font:ui".into(),
        font_size: 16.0,
        color: [1.0, 0.5, 0.0, 0.8],
        max_width: None,
        align: None,
        baseline: None,
        direction: None,
        atlas_id: Some("font-atlas".into()),
        baked_glyphs: Some(vec![
            BakedGlyphPlacement {
                cluster: 0,
                source: [0, 0, 1, 1],
                destination: [0.0, 0.0, 2.0, 2.0],
            },
            BakedGlyphPlacement {
                cluster: 1,
                source: [1, 0, 1, 1],
                destination: [2.0, 0.0, 2.0, 2.0],
            },
        ]),
    }
}

fn display_list(command: TextCommand) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "baked-text".into(),
        revision: 1,
        logical_width: 8.0,
        logical_height: 4.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Font(FontResource {
            id: "font:ui".into(),
            revision: 1,
            asset_id: "asset:ui".into(),
            family: "Test".into(),
            weight: 400,
            style: FontStyle::Normal,
        })],
        commands: vec![Deep2dCommand::Text(command)],
        atlases: vec![glyph_atlas()],
    }
}

#[test]
fn baked_text_compiles_deterministically_to_existing_atlas_quads() {
    let content = Deep2dRuntimeContent::DisplayList(display_list(text_command()));
    let first = prepare_runtime_content(&content).expect("baked text");
    let second = prepare_runtime_content(&content).expect("repeat");
    assert_eq!(first, second, "compilation must be deterministic");
    assert_eq!(first.summary.glyph_quads, 2);
    assert_eq!(first.summary.image_quads, 0);
    assert_eq!(first.atlas_vertices.len(), 12);
    assert_eq!(first.chunks.len(), 1, "adjacent glyphs must batch");
    assert!(matches!(
        first.chunks[0].kind,
        PreparedDeep2dChunkKind::Atlas { atlas_index: 0 }
    ));
    assert_eq!(first.chunks[0].clip_rect.unwrap().x, 2.0);
    assert!(first.atlas_vertices.iter().all(|vertex| vertex[8] == 1.0));
    assert!(
        first
            .atlas_vertices
            .iter()
            .any(|vertex| vertex[0] == 6.0 && vertex[1] == 3.0)
    );
    assert!(
        first
            .atlas_vertices
            .iter()
            .all(|vertex| (vertex[7] - 0.4).abs() < 1e-6)
    );
}

#[test]
fn missing_or_partial_baked_mapping_fails_with_structured_evidence() {
    let mut missing = text_command();
    missing.atlas_id = None;
    missing.baked_glyphs = None;
    let error = prepare_display_list(&display_list(missing)).expect_err("host shaping missing");
    assert_eq!(
        error.issues[0].code,
        Deep2dPainterIssueCode::UnsupportedCommand
    );
    assert!(error.issues[0].message.contains("host-shaped"));

    let mut partial = text_command();
    partial.atlas_id = None;
    let result = validate_display_list(&display_list(partial));
    assert!(result.issues.iter().any(|issue| {
        issue.code == Deep2dIssueCode::InvalidStructure
            && issue.message.contains("both atlasId and bakedGlyphs")
    }));
}

#[test]
fn invalid_baked_glyphs_fail_closed_before_gpu_allocation() {
    let mut escaped = text_command();
    escaped.baked_glyphs.as_mut().unwrap()[0].source = [2, 0, 1, 1];
    let result = validate_display_list(&display_list(escaped));
    assert!(result.issues.iter().any(|issue| {
        issue.path == "commands[0].bakedGlyphs[0].source"
            && issue.code == Deep2dIssueCode::InvalidNumber
    }));

    let mut wrong_kind = text_command();
    let mut candidate = display_list(wrong_kind.clone());
    candidate.atlases[0].kind = Deep2dAtlasKind::Image;
    candidate.atlases[0].format = Deep2dAtlasFormat::Rgba8UnormSrgb;
    candidate.atlases[0].data_base64 = "/wAA/w==".into();
    let result = validate_display_list(&candidate);
    assert!(result.issues.iter().any(|issue| {
        issue.path == "commands[0].atlasId" && issue.code == Deep2dIssueCode::ResourceKindMismatch
    }));

    wrong_kind.baked_glyphs.as_mut().unwrap()[1].cluster = 0;
    assert!(
        validate_display_list(&display_list(wrong_kind)).valid,
        "multiple glyphs may share a shaping cluster"
    );
}
