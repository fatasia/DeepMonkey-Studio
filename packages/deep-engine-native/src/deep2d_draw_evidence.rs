use deep_engine_native::deep2d::{
    Deep2dRuntimeContent, PreparedDeep2dAtlas, PreparedDeep2dChunk, PreparedDeep2dChunkKind,
};
use serde::Serialize;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawEvidence {
    pub id: String,
    pub draw_calls: u32,
    pub vertices: u64,
    pub atlas_ids: Vec<String>,
}

pub(super) struct DrawEvidenceTracker {
    enabled: Cell<bool>,
    layer_ids: Vec<String>,
    atlas_ids: Vec<String>,
    atlas_inventory: Vec<serde_json::Value>,
    draws: RefCell<BTreeMap<usize, DrawEvidence>>,
}
impl DrawEvidenceTracker {
    pub fn new(content: &Deep2dRuntimeContent, atlases: &[PreparedDeep2dAtlas]) -> Self {
        let capture_atlas_pixels = std::env::var_os("DEEP_ENGINE_ATLAS_EVIDENCE").is_some();
        Self {
            enabled: Cell::new(false),
            layer_ids: match content {
                Deep2dRuntimeContent::Composite(value) => {
                    value.layers().iter().map(|v| v.id.clone()).collect()
                }
                _ => Vec::new(),
            },
            atlas_ids: atlases.iter().map(|v| v.id.clone()).collect(),
            atlas_inventory: atlases
                .iter()
                .filter(|_| capture_atlas_pixels)
                .map(|v| {
                    serde_json::json!({
                        "id": v.id, "width": v.width, "height": v.height, "format": v.format,
                        "kind": v.kind, "sampling": v.sampling, "bytes": v.data.len(),
                        "sha256": v.content_sha256(),
                    })
                })
                .collect(),
            draws: RefCell::new(BTreeMap::new()),
        }
    }
    pub fn clear(&self) {
        self.draws.borrow_mut().clear();
    }
    pub fn atlas_inventory(&self) -> &[serde_json::Value] {
        &self.atlas_inventory
    }
    pub fn enable(&self) {
        self.enabled.set(true);
    }
    // Called at the draw command, after scissor/resource checks. A declaration is not a draw.
    pub fn record(&self, chunk: &PreparedDeep2dChunk) {
        if !self.enabled.get() {
            return;
        }
        let Some(index) = chunk.layer_index else {
            return;
        };
        if chunk.vertex_count == 0 {
            return;
        }
        let Some(id) = self.layer_ids.get(index) else {
            return;
        };
        let mut draws = self.draws.borrow_mut();
        let evidence = draws.entry(index).or_insert_with(|| DrawEvidence {
            id: id.clone(),
            draw_calls: 0,
            vertices: 0,
            atlas_ids: Vec::new(),
        });
        evidence.draw_calls += 1;
        evidence.vertices += u64::from(chunk.vertex_count);
        if let PreparedDeep2dChunkKind::Atlas { atlas_index } = chunk.kind {
            let id = &self.atlas_ids[atlas_index];
            if !evidence.atlas_ids.contains(id) {
                evidence.atlas_ids.push(id.clone());
            }
        }
    }
    pub fn snapshot(&self) -> Vec<DrawEvidence> {
        self.draws.borrow().values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tracker() -> DrawEvidenceTracker {
        DrawEvidenceTracker {
            enabled: Cell::new(true),
            layer_ids: vec!["node.a:static".into(), "node.b:chart".into()],
            atlas_ids: vec!["glyph.a".into(), "glyph.unused".into()],
            atlas_inventory: Vec::new(),
            draws: RefCell::new(BTreeMap::new()),
        }
    }
    fn chunk(
        layer_index: Option<usize>,
        kind: PreparedDeep2dChunkKind,
        count: u32,
    ) -> PreparedDeep2dChunk {
        PreparedDeep2dChunk {
            layer_index,
            kind,
            first_vertex: 0,
            vertex_count: count,
            clip_rect: None,
        }
    }
    #[test]
    fn only_records_issued_nonempty_draws_and_their_used_atlases() {
        let tracker = tracker();
        assert!(tracker.snapshot().is_empty());
        tracker.record(&chunk(Some(0), PreparedDeep2dChunkKind::Path, 0));
        tracker.record(&chunk(None, PreparedDeep2dChunkKind::Path, 6));
        assert!(tracker.snapshot().is_empty());
        tracker.record(&chunk(Some(0), PreparedDeep2dChunkKind::Path, 6));
        tracker.record(&chunk(
            Some(0),
            PreparedDeep2dChunkKind::Atlas { atlas_index: 0 },
            12,
        ));
        let draws = tracker.snapshot();
        assert_eq!(draws.len(), 1);
        assert_eq!(draws[0].id, "node.a:static");
        assert_eq!(draws[0].draw_calls, 2);
        assert_eq!(draws[0].vertices, 18);
        assert_eq!(draws[0].atlas_ids, ["glyph.a"]);
        tracker.clear();
        assert!(tracker.snapshot().is_empty());
    }
}
