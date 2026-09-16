use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dIssueCode, Deep2dRect, Deep2dRuntimeContent,
    default_display_list_fixture_path, prepare_display_list, prepare_runtime_content,
    validate_display_list,
};
use std::fs;

const CLIP: Deep2dRect = Deep2dRect {
    x: 24.0,
    y: 16.0,
    width: 320.0,
    height: 200.0,
};

fn fixture() -> Deep2dDisplayList {
    let bytes = fs::read(default_display_list_fixture_path()).expect("fixture");
    serde_json::from_slice(&bytes).expect("valid path-only fixture")
}

fn path_command(command: &mut Deep2dCommand) -> &mut deep_engine_native::deep2d::PathCommand {
    match command {
        Deep2dCommand::Path(value) => value,
        _ => panic!("path-only fixture must only contain path commands"),
    }
}

#[test]
fn clip_rect_flows_to_chunks_without_touching_geometry() {
    let mut clipped = fixture();
    path_command(&mut clipped.commands[2]).clip_rect = Some(CLIP);
    let prepared = prepare_display_list(&clipped).expect("clipped display list");
    assert_eq!(prepared.chunks.len(), 3);
    assert_eq!(prepared.chunks[2].clip_rect, Some(CLIP));
    assert_eq!(prepared.chunks[0].clip_rect, None);
    assert_eq!(prepared.chunks[1].clip_rect, None);

    let unclipped = prepare_display_list(&fixture()).expect("baseline display list");
    assert_eq!(prepared.vertices, unclipped.vertices);
    assert_eq!(
        prepared.chunks[2].first_vertex,
        unclipped.chunks[2].first_vertex
    );
    assert_eq!(
        prepared.chunks[2].vertex_count,
        unclipped.chunks[2].vertex_count
    );
}

#[test]
fn clip_rect_and_clip_path_ids_are_mutually_exclusive() {
    let mut conflicting = fixture();
    let command = path_command(&mut conflicting.commands[0]);
    command.clip_rect = Some(CLIP);
    command.clip_path_ids = Some(vec!["overlay:status".into()]);
    let validation = validate_display_list(&conflicting);
    assert!(!validation.valid);
    assert!(
        validation
            .issues
            .iter()
            .any(|issue| issue.code == Deep2dIssueCode::InvalidStructure
                && issue.path == "commands[0]"
                && issue.message.contains("mutually exclusive"))
    );

    // A clip path list that only validates as empty stays legal alongside a rect.
    let command = path_command(&mut conflicting.commands[0]);
    command.clip_path_ids = Some(Vec::new());
    assert!(validate_display_list(&conflicting).valid);
}

#[test]
fn invalid_clip_rects_fail_validation_with_field_paths() {
    for (label, rect, rect_path) in [
        (
            "zero width",
            Deep2dRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            },
            "commands[0].clipRect",
        ),
        (
            "negative height",
            Deep2dRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: -1.0,
            },
            "commands[0].clipRect",
        ),
        (
            "nan y",
            Deep2dRect {
                x: 0.0,
                y: f64::NAN,
                width: 10.0,
                height: 10.0,
            },
            "commands[0].clipRect.y",
        ),
    ] {
        let mut invalid = fixture();
        path_command(&mut invalid.commands[0]).clip_rect = Some(rect);
        let validation = validate_display_list(&invalid);
        assert!(!validation.valid, "{label} must be rejected");
        assert!(
            validation
                .issues
                .iter()
                .any(|issue| issue.path == rect_path)
        );
    }
}

#[test]
fn runtime_chunks_never_merge_across_distinct_clips() {
    // Two same-z path fills have contiguous vertices, so the default runtime merge
    // coalesces them; a clip difference must act as a merge barrier or a scissor
    // would leak onto the unclipped geometry.
    let mut merged = fixture();
    path_command(&mut merged.commands[1]).z_order = 0;
    let merged = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(merged))
        .expect("merged runtime content");
    assert_eq!(merged.chunks.len(), 1);
    assert_eq!(merged.chunks[0].clip_rect, None);

    let mut split = fixture();
    path_command(&mut split.commands[1]).z_order = 0;
    path_command(&mut split.commands[1]).clip_rect = Some(CLIP);
    let split = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(split))
        .expect("clipped runtime content");
    // The clipped chunk splits the vertex-contiguous run in draw order, so the
    // trailing z=2 fill cannot merge back across the barrier either.
    assert_eq!(split.chunks.len(), 3);
    assert_eq!(split.chunks[1].clip_rect, Some(CLIP));
    assert_eq!(split.chunks[0].clip_rect, None);
    assert_eq!(split.chunks[2].clip_rect, None);
    let clipped = split
        .chunks
        .iter()
        .find(|chunk| chunk.clip_rect == Some(CLIP))
        .expect("clipped chunk survives chunk building");
    assert_eq!(clipped.clip_rect, Some(CLIP));

    let mut uniform = fixture();
    path_command(&mut uniform.commands[1]).z_order = 0;
    path_command(&mut uniform.commands[1]).clip_rect = Some(CLIP);
    path_command(&mut uniform.commands[0]).clip_rect = Some(CLIP);
    let uniform = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(uniform))
        .expect("uniformly clipped runtime content");
    // The two same-z clipped fills coalesce into one chunk; the trailing z=2
    // unclipped fill stays separate.
    assert_eq!(uniform.chunks.len(), 2);
    assert_eq!(uniform.chunks[0].clip_rect, Some(CLIP));
    assert_eq!(uniform.chunks[1].clip_rect, None);
}
