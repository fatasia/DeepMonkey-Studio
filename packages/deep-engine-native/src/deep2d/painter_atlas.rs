use std::collections::HashMap;

use super::{
    Deep2dAtlasQuad, Deep2dPainterIssue, Deep2dPainterIssueCode, ImageCommand, PathResource,
    TextCommand,
    painter::{PreparedDeep2d, PreparedDeep2dGlyph, PreparedDeep2dImage, issue},
    painter_clip::prepare_clip_sets,
};

pub(super) fn prepare_image(
    command: &ImageCommand,
    source_index: usize,
    path: &str,
    paths: &HashMap<&str, (usize, &PathResource)>,
    scale_factor: f64,
    output: &mut PreparedDeep2d,
) -> Result<(), Deep2dPainterIssue> {
    let clip_sets = prepare_clip_sets(
        command.clip_path_ids.as_deref(),
        paths,
        command.transform,
        scale_factor,
        path,
    )?;
    let Some(atlas_id) = &command.atlas_id else {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedCommand,
            path,
            "Image requires atlasId: images have no native pixel source without an atlas.",
        ));
    };
    let Some(source) = command.source else {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedCommand,
            &format!("{path}.source"),
            "Image atlasId requires a pixel-space source rect.",
        ));
    };
    output.images.push(PreparedDeep2dImage {
        quad: Deep2dAtlasQuad {
            id: command.id.clone(),
            z_order: command.z_order,
            transform: command.transform,
            atlas_id: atlas_id.clone(),
            source,
            destination: [command.x, command.y, command.width, command.height],
            color: [1.0, 1.0, 1.0, 1.0],
            opacity: command.opacity.unwrap_or(1.0),
        },
        source_index,
        clip_rect: command.clip_rect,
        clip_sets,
    });
    Ok(())
}

pub(super) fn prepare_text(
    command: &TextCommand,
    source_index: usize,
    path: &str,
    paths: &HashMap<&str, (usize, &PathResource)>,
    scale_factor: f64,
    output: &mut PreparedDeep2d,
) -> Result<(), Deep2dPainterIssue> {
    let clip_sets = prepare_clip_sets(
        command.clip_path_ids.as_deref(),
        paths,
        command.transform,
        scale_factor,
        path,
    )?;
    let (Some(atlas_id), Some(glyphs)) = (&command.atlas_id, &command.baked_glyphs) else {
        return Err(issue(
            Deep2dPainterIssueCode::UnsupportedCommand,
            path,
            "Text requires host-shaped bakedGlyphs and a glyph atlasId.",
        ));
    };
    for (glyph_index, glyph) in glyphs.iter().enumerate() {
        let [x, y, width, height] = glyph.destination;
        output.glyphs.push(PreparedDeep2dGlyph {
            quad: Deep2dAtlasQuad {
                id: format!("{}:glyph:{glyph_index}", command.id),
                z_order: command.z_order,
                transform: command.transform,
                atlas_id: atlas_id.clone(),
                source: glyph.source,
                destination: [command.x + x, command.y + y, width, height],
                color: command.color,
                opacity: command.opacity.unwrap_or(1.0),
            },
            source_index,
            clip_rect: command.clip_rect,
            clip_sets: clip_sets.clone(),
        });
    }
    Ok(())
}
