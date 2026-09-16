use super::{
    Deep2dComposition, Deep2dRect, PreparedDeep2dChunk, PreparedDeep2dChunkKind,
    PreparedDeep2dPathChunk,
};

#[derive(Debug, Clone, Copy)]
pub(super) struct PreparedAtlasItem {
    pub z_order: i32,
    pub source_index: usize,
    pub atlas_index: usize,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub clip_rect: Option<Deep2dRect>,
}

#[derive(Debug, Clone, Copy)]
struct Candidate {
    z_order: i32,
    source_index: usize,
    kind_order: u8,
    kind: PreparedDeep2dChunkKind,
    first_vertex: u32,
    vertex_count: u32,
    clip_rect: Option<Deep2dRect>,
}

pub(super) fn build_chunks(
    composition: Deep2dComposition,
    paths: &[PreparedDeep2dPathChunk],
    atlases: &[PreparedAtlasItem],
) -> Vec<PreparedDeep2dChunk> {
    let mut candidates = paths
        .iter()
        .map(|path| Candidate {
            z_order: path.z_order,
            source_index: path.source_index,
            kind_order: 0,
            kind: PreparedDeep2dChunkKind::Path,
            first_vertex: path.first_vertex,
            vertex_count: path.vertex_count,
            clip_rect: path.clip_rect,
        })
        .chain(atlases.iter().map(|atlas| Candidate {
            z_order: atlas.z_order,
            source_index: atlas.source_index,
            kind_order: 1,
            kind: PreparedDeep2dChunkKind::Atlas {
                atlas_index: atlas.atlas_index,
            },
            first_vertex: atlas.first_vertex,
            vertex_count: atlas.vertex_count,
            clip_rect: atlas.clip_rect,
        }))
        .collect::<Vec<_>>();
    match composition {
        Deep2dComposition::PathThenAtlas => {
            candidates.sort_by_key(|item| (item.kind_order, item.z_order, item.source_index));
        }
        Deep2dComposition::ZOrdered => {
            candidates.sort_by_key(|item| (item.z_order, item.kind_order, item.source_index));
        }
    }
    let mut chunks = Vec::<PreparedDeep2dChunk>::new();
    for candidate in candidates {
        if let Some(chunk) = chunks.last_mut().filter(|chunk| {
            chunk.kind == candidate.kind
                && chunk.clip_rect == candidate.clip_rect
                && chunk.first_vertex + chunk.vertex_count == candidate.first_vertex
        }) {
            chunk.vertex_count += candidate.vertex_count;
        } else {
            chunks.push(PreparedDeep2dChunk {
                kind: candidate.kind,
                first_vertex: candidate.first_vertex,
                vertex_count: candidate.vertex_count,
                clip_rect: candidate.clip_rect,
            });
        }
    }
    chunks
}
