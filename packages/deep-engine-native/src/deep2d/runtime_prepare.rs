use std::collections::HashMap;

use super::{
    Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dComposition, Deep2dRuntimeContent, ImageSampling,
    PreparedDeep2d, PreparedDeep2dSummary, prepare_display_list, runtime_base64,
    runtime_layers::{PreparedAtlasItem, build_chunks},
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PreparedDeep2dChunk {
    pub kind: PreparedDeep2dChunkKind,
    pub first_vertex: u32,
    pub vertex_count: u32,
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
    pub atlas_vertices: Vec<[f32; 9]>,
    pub chunks: Vec<PreparedDeep2dChunk>,
    pub summary: PreparedDeep2dRuntimeSummary,
}

pub fn prepare_runtime_content(
    content: &Deep2dRuntimeContent,
) -> Result<PreparedDeep2dRuntime, String> {
    match content {
        Deep2dRuntimeContent::DisplayList(display_list) => {
            let path = prepare_display_list(display_list).map_err(|error| error.to_string())?;
            let summary = PreparedDeep2dRuntimeSummary {
                path: path.summary,
                atlases: 0,
                atlas_bytes: 0,
                glyph_quads: 0,
                image_quads: 0,
                atlas_batches: 0,
                atlas_vertices: 0,
                render_chunks: usize::from(!path.chunks.is_empty()),
            };
            let chunks = build_chunks(Deep2dComposition::PathThenAtlas, &path.chunks, &[]);
            Ok(PreparedDeep2dRuntime {
                path,
                atlases: Vec::new(),
                atlas_vertices: Vec::new(),
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
            let path =
                prepare_display_list(&package.display_list).map_err(|error| error.to_string())?;
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

fn append_quad(
    vertices: &mut Vec<[f32; 9]>,
    quad: &super::Deep2dAtlasQuad,
    atlas: &PreparedDeep2dAtlas,
) {
    let [x, y, width, height] = quad.destination;
    let positions = [
        point(quad.transform, x, y),
        point(quad.transform, x + width, y),
        point(quad.transform, x + width, y + height),
        point(quad.transform, x, y + height),
    ];
    let [source_x, source_y, source_width, source_height] = quad.source;
    let left = (source_x as f32 + 0.5) / atlas.width as f32;
    let top = (source_y as f32 + 0.5) / atlas.height as f32;
    let right = (source_x + source_width) as f32 - 0.5;
    let bottom = (source_y + source_height) as f32 - 0.5;
    let right = right / atlas.width as f32;
    let bottom = bottom / atlas.height as f32;
    let uvs = [[left, top], [right, top], [right, bottom], [left, bottom]];
    let color = [
        quad.color[0] as f32,
        quad.color[1] as f32,
        quad.color[2] as f32,
        (quad.color[3] * quad.opacity) as f32,
    ];
    let glyph = f32::from(atlas.kind == Deep2dAtlasKind::Glyph);
    for index in [0, 1, 2, 0, 2, 3] {
        vertices.push([
            positions[index][0],
            positions[index][1],
            uvs[index][0],
            uvs[index][1],
            color[0],
            color[1],
            color[2],
            color[3],
            glyph,
        ]);
    }
}

fn point(matrix: [f64; 6], x: f64, y: f64) -> [f32; 2] {
    [
        (matrix[0] * x + matrix[2] * y + matrix[4]) as f32,
        (matrix[1] * x + matrix[3] * y + matrix[5]) as f32,
    ]
}
