use super::runtime_composite::{intersection, translate_rect};
use super::*;

pub(super) fn prepare(
    value: &Deep2dComposite,
    mut cache: Option<&mut Deep2dPathCache>,
) -> Result<PreparedDeep2dRuntime, String> {
    let list = value.display_list();
    let empty = Deep2dDisplayList {
        commands: Vec::new(),
        resources: Vec::new(),
        atlases: Vec::new(),
        ..list.clone()
    };
    let mut output = prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(empty))?;
    for (layer_index, layer) in value.layers().iter().enumerate() {
        let mut part = match cache.as_deref_mut() {
            Some(cache) => {
                super::runtime_prepare::prepare_impl(&layer.content, Some(cache), false)?
            }
            None => prepare_runtime_content(&layer.content)?,
        };
        // Reject the complete candidate totals before appending any geometry/resources.
        let summary = combined_summary(output.summary, part.summary)?;
        let path_offset = u32::try_from(output.path.vertices.len())
            .map_err(|_| "composite path offset overflow")?;
        let atlas_offset = u32::try_from(output.atlas_vertices.len())
            .map_err(|_| "composite atlas offset overflow")?;
        let atlas_index_offset = output.atlases.len();
        for vertex in &mut part.path.vertices {
            vertex[0] += layer.translation[0] as f32;
            vertex[1] += layer.translation[1] as f32;
        }
        for vertex in &mut part.atlas_vertices {
            vertex[0] += layer.translation[0] as f32;
            vertex[1] += layer.translation[1] as f32;
        }
        for mut chunk in part.chunks {
            chunk.layer_index = Some(layer_index);
            chunk.clip_rect = match chunk.clip_rect {
                Some(rect) => intersection(translate_rect(rect, layer.translation), layer.clip),
                None => Some(layer.clip),
            };
            if chunk.clip_rect.is_none() {
                continue;
            }
            match &mut chunk.kind {
                PreparedDeep2dChunkKind::Path => {
                    chunk.first_vertex = chunk
                        .first_vertex
                        .checked_add(path_offset)
                        .ok_or("composite path overflow")?
                }
                PreparedDeep2dChunkKind::Atlas { atlas_index } => {
                    *atlas_index = atlas_index
                        .checked_add(atlas_index_offset)
                        .ok_or("composite atlas index overflow")?;
                    chunk.first_vertex = chunk
                        .first_vertex
                        .checked_add(atlas_offset)
                        .ok_or("composite atlas overflow")?;
                }
            }
            output.chunks.push(chunk);
        }
        for mut chunk in part.path.chunks {
            chunk.first_vertex = chunk
                .first_vertex
                .checked_add(path_offset)
                .ok_or("composite path chunk offset overflow")?;
            chunk.clip_rect = match chunk.clip_rect {
                Some(rect) => intersection(translate_rect(rect, layer.translation), layer.clip),
                None => Some(layer.clip),
            };
            if chunk.clip_rect.is_some() {
                output.path.chunks.push(chunk);
            }
        }
        output.path.vertices.extend(part.path.vertices);
        output.atlas_vertices.extend(part.atlas_vertices);
        output.atlases.extend(part.atlases);
        output.path.summary = summary.path;
        output.summary = summary;
    }
    if let Some(cache) = cache {
        // Children share one frame: prune only after every layer prepared successfully.
        let live_ids = value
            .layers()
            .iter()
            .flat_map(|layer| &layer.content.display_list().commands)
            .filter_map(|command| match command {
                Deep2dCommand::Path(command) => Some(command.id.as_str()),
                Deep2dCommand::Text(_) | Deep2dCommand::Image(_) => None,
            });
        cache.prune_to_ids(live_ids);
    }
    output.summary.path = output.path.summary;
    output.summary.atlases = output.atlases.len();
    output.summary.atlas_vertices = output.atlas_vertices.len();
    output.summary.render_chunks = output.chunks.len();
    output.summary.atlas_batches = output
        .chunks
        .iter()
        .filter(|c| matches!(c.kind, PreparedDeep2dChunkKind::Atlas { .. }))
        .count();
    Ok(output)
}

/// Uses only existing command/atlas/quad budgets and the u32 GPU vertex index range.
/// Count-only validation also permits exact overflow regression tests without huge allocations.
pub(super) fn combined_summary(
    current: PreparedDeep2dRuntimeSummary,
    incoming: PreparedDeep2dRuntimeSummary,
) -> Result<PreparedDeep2dRuntimeSummary, String> {
    let add = |a: usize, b: usize| {
        a.checked_add(b)
            .ok_or_else(|| "composite frame accounting overflow".to_string())
    };
    let summary = PreparedDeep2dRuntimeSummary {
        path: PreparedDeep2dSummary {
            commands: add(current.path.commands, incoming.path.commands)?,
            path_segments: add(current.path.path_segments, incoming.path.path_segments)?,
            fill_triangles: add(current.path.fill_triangles, incoming.path.fill_triangles)?,
            stroke_triangles: add(
                current.path.stroke_triangles,
                incoming.path.stroke_triangles,
            )?,
            vertices: add(current.path.vertices, incoming.path.vertices)?,
        },
        atlases: add(current.atlases, incoming.atlases)?,
        atlas_bytes: add(current.atlas_bytes, incoming.atlas_bytes)?,
        glyph_quads: add(current.glyph_quads, incoming.glyph_quads)?,
        image_quads: add(current.image_quads, incoming.image_quads)?,
        atlas_batches: add(current.atlas_batches, incoming.atlas_batches)?,
        atlas_vertices: add(current.atlas_vertices, incoming.atlas_vertices)?,
        render_chunks: add(current.render_chunks, incoming.render_chunks)?,
    };
    if summary.path.commands > DEEP_2D_DISPLAY_LIST_BUDGETS.commands
        || add(summary.glyph_quads, summary.image_quads)? > 262_144
        || summary.atlases > 512
        || summary.atlas_bytes > 64 * 1024 * 1024
        || summary.path.vertices > u32::MAX as usize
        || summary.atlas_vertices > u32::MAX as usize
    {
        return Err("composite final frame budget exceeded".into());
    }
    Ok(summary)
}
