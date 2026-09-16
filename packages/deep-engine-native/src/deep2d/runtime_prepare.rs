use std::collections::HashMap;

use super::{
    Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dComposition, Deep2dRect, Deep2dRuntimeContent,
    ImageSampling, PreparedDeep2d, PreparedDeep2dSummary,
    painter_clip::clip_vertices,
    runtime_base64,
    runtime_layers::{PreparedAtlasItem, build_chunks},
    runtime_quad::append_quad,
    validate_runtime_package,
};

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedDeep2dAtlas {
    pub id: String,
    pub kind: Deep2dAtlasKind,
    pub format: Deep2dAtlasFormat,
    pub width: u32,
    pub height: u32,
    pub sampling: ImageSampling,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreparedDeep2dChunkKind {
    Path,
    Atlas { atlas_index: usize },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreparedDeep2dChunk {
    /// Composite source retained through tessellation for actual draw evidence.
    pub layer_index: Option<usize>,
    pub kind: PreparedDeep2dChunkKind,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub clip_rect: Option<Deep2dRect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedDeep2dRuntimeSummary {
    pub path: PreparedDeep2dSummary,
    pub atlases: usize,
    pub atlas_bytes: usize,
    pub glyph_quads: usize,
    pub image_quads: usize,
    pub atlas_batches: usize,
    pub atlas_vertices: usize,
    pub render_chunks: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedDeep2dRuntime {
    pub path: PreparedDeep2d,
    pub atlases: Vec<PreparedDeep2dAtlas>,
    pub atlas_vertices: Vec<[f32; 13]>,
    pub chunks: Vec<PreparedDeep2dChunk>,
    pub summary: PreparedDeep2dRuntimeSummary,
}

pub fn prepare_runtime_content(
    content: &Deep2dRuntimeContent,
) -> Result<PreparedDeep2dRuntime, String> {
    prepare_impl(content, None, true)
}

pub fn prepare_runtime_content_cached(
    content: &Deep2dRuntimeContent,
    cache: &mut super::Deep2dPathCache,
) -> Result<PreparedDeep2dRuntime, String> {
    prepare_impl(content, Some(cache), true)
}

pub(super) fn prepare_impl(
    content: &Deep2dRuntimeContent,
    cache: Option<&mut super::Deep2dPathCache>,
    finish_frame: bool,
) -> Result<PreparedDeep2dRuntime, String> {
    match content {
        Deep2dRuntimeContent::Composite(value) => {
            super::runtime_composite_prepare::prepare(value, cache)
        }
        Deep2dRuntimeContent::DisplayList(display_list) => {
            let path = super::painter::prepare_impl(display_list, cache, finish_frame)
                .map_err(|error| error.to_string())?;
            let atlases = display_list
                .atlases
                .iter()
                .map(|atlas| {
                    let data = runtime_base64::decode(&atlas.data_base64).map_err(|error| {
                        format!("atlas {} failed base64 decode: {error}", atlas.id)
                    })?;
                    let expected = atlas.width as usize
                        * atlas.height as usize
                        * atlas.format.bytes_per_pixel();
                    if data.len() != expected {
                        return Err(format!(
                            "atlas {} pixel data is {} bytes, expected {expected}",
                            atlas.id,
                            data.len()
                        ));
                    }
                    Ok(PreparedDeep2dAtlas {
                        id: atlas.id.clone(),
                        kind: atlas.kind,
                        format: atlas.format,
                        width: atlas.width,
                        height: atlas.height,
                        sampling: atlas.sampling,
                        data,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            let atlas_indices = atlases
                .iter()
                .enumerate()
                .map(|(index, atlas)| (atlas.id.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut atlas_vertices = Vec::new();
            let mut atlas_items = Vec::with_capacity(path.images.len() + path.glyphs.len());
            let mut image_quads = 0usize;
            let mut glyph_quads = 0usize;
            let direct_quads = path
                .images
                .iter()
                .map(|item| {
                    (
                        &item.quad,
                        item.source_index,
                        item.clip_rect,
                        &item.clip_sets,
                    )
                })
                .chain(path.glyphs.iter().map(|item| {
                    (
                        &item.quad,
                        item.source_index,
                        item.clip_rect,
                        &item.clip_sets,
                    )
                }));
            for (quad, source_index, clip_rect, clip_sets) in direct_quads {
                let atlas_index = atlas_indices[quad.atlas_id.as_str()];
                let first_vertex = atlas_vertices.len() as u32;
                append_quad(&mut atlas_vertices, quad, &atlases[atlas_index]);
                if !clip_sets.is_empty() {
                    let clipped = clip_vertices(
                        &atlas_vertices[first_vertex as usize..],
                        clip_sets,
                        &format!("commands[{source_index}]"),
                    )
                    .map_err(|error| error.message)?;
                    atlas_vertices.truncate(first_vertex as usize);
                    atlas_vertices.extend(clipped);
                }
                let vertex_count = atlas_vertices.len() as u32 - first_vertex;
                if vertex_count == 0 {
                    continue;
                }
                atlas_items.push(PreparedAtlasItem {
                    z_order: quad.z_order,
                    source_index,
                    atlas_index,
                    first_vertex,
                    vertex_count,
                    clip_rect,
                });
                match atlases[atlas_index].kind {
                    Deep2dAtlasKind::Glyph => glyph_quads += 1,
                    Deep2dAtlasKind::Image => image_quads += 1,
                }
            }
            let chunks = build_chunks(Deep2dComposition::ZOrdered, &path.chunks, &atlas_items);
            let summary = PreparedDeep2dRuntimeSummary {
                path: path.summary,
                atlases: atlases.len(),
                atlas_bytes: atlases.iter().map(|atlas| atlas.data.len()).sum(),
                glyph_quads,
                image_quads,
                atlas_batches: chunks
                    .iter()
                    .filter(|chunk| matches!(chunk.kind, PreparedDeep2dChunkKind::Atlas { .. }))
                    .count(),
                atlas_vertices: atlas_vertices.len(),
                render_chunks: chunks.len(),
            };
            Ok(PreparedDeep2dRuntime {
                path,
                atlases,
                atlas_vertices,
                chunks,
                summary,
            })
        }
        Deep2dRuntimeContent::Package(package) => {
            let validation = validate_runtime_package(package);
            if let Some(issue) = validation.issues.first() {
                return Err(format!(
                    "invalid Deep2d runtime package: {} at {} ({:?})",
                    issue.message, issue.path, issue.code
                ));
            }
            let path = super::painter::prepare_impl(&package.display_list, cache, finish_frame)
                .map_err(|error| error.to_string())?;
            let atlases = package
                .atlases
                .iter()
                .map(|atlas| {
                    runtime_base64::decode(&atlas.data_base64)
                        .map(|data| PreparedDeep2dAtlas {
                            id: atlas.id.clone(),
                            kind: atlas.kind,
                            format: atlas.format,
                            width: atlas.width,
                            height: atlas.height,
                            sampling: atlas.sampling,
                            data,
                        })
                        .map_err(|error| {
                            format!(
                                "atlas {} failed base64 decode after validation: {error}",
                                atlas.id
                            )
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let atlas_indices = atlases
                .iter()
                .enumerate()
                .map(|(index, atlas)| (atlas.id.as_str(), index))
                .collect::<HashMap<_, _>>();
            let mut ordered = package.quads.iter().enumerate().collect::<Vec<_>>();
            ordered.sort_by_key(|(index, quad)| (quad.z_order, *index));
            let mut vertices = Vec::with_capacity(ordered.len() * 6);
            let mut atlas_items = Vec::with_capacity(ordered.len());
            let mut glyph_quads = 0;
            let mut image_quads = 0;
            for (source_index, quad) in ordered {
                let atlas_index = atlas_indices[quad.atlas_id.as_str()];
                let atlas = &atlases[atlas_index];
                let first_vertex = vertices.len() as u32;
                append_quad(&mut vertices, quad, atlas);
                atlas_items.push(PreparedAtlasItem {
                    z_order: quad.z_order,
                    source_index,
                    atlas_index,
                    first_vertex,
                    vertex_count: 6,
                    clip_rect: None,
                });
                match atlas.kind {
                    Deep2dAtlasKind::Glyph => glyph_quads += 1,
                    Deep2dAtlasKind::Image => image_quads += 1,
                }
            }
            let chunks = build_chunks(package.composition, &path.chunks, &atlas_items);
            let atlas_batches = chunks
                .iter()
                .filter(|chunk| matches!(chunk.kind, PreparedDeep2dChunkKind::Atlas { .. }))
                .count();
            let summary = PreparedDeep2dRuntimeSummary {
                path: path.summary,
                atlases: atlases.len(),
                atlas_bytes: atlases.iter().map(|atlas| atlas.data.len()).sum(),
                glyph_quads,
                image_quads,
                atlas_batches,
                atlas_vertices: vertices.len(),
                render_chunks: chunks.len(),
            };
            Ok(PreparedDeep2dRuntime {
                path,
                atlases,
                atlas_vertices: vertices,
                chunks,
                summary,
            })
        }
    }
}
