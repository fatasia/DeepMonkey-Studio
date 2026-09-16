//! D05: glyph atlas incremental-update contract and text shaping over the
//! pure layout layer. The atlas channel accepts per-glyph region updates
//! (add/replace/evict) with bounded per-commit work — a full re-upload only
//! happens when the atlas dimensions change. Shaping maps cluster layout
//! (platform_text) into baked-glyph placements the painter already consumes.
//! Real pixel bytes now flow through `raster::GlyphRasterCache` (cosmic-text
//! rasterization behind a bounded LRU); this book owns atlas placement and
//! region accounting only — GPU region upload stays in the render lane.

/// One glyph cell in a virtual atlas: pixel rect + logical placement relative
/// to the pen origin. Identical to `BakedGlyphPlacement` semantics so a
/// shaped run converts directly into `TextCommand::baked_glyphs`.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphCell {
    /// Stable glyph key: font id + cluster signature hash supplied by the host.
    pub glyph_key: u64,
    /// Pixel rect inside the atlas: [x, y, width, height].
    pub source: [u32; 4],
    /// Logical placement relative to the pen origin: [dx, dy, w, h].
    pub destination: [f64; 4],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtlasSpec {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AtlasUpdateError {
    CellOutsideAtlas,
    BudgetExceeded { cells: usize, cap: usize },
    DimensionChangeRequiresRebuild,
}

/// Incremental glyph atlas: shelf packing with bounded eviction. Updates
/// mutate at most the touched cells — existing cell pixels are never
/// re-uploaded (the D05 incremental contract), and `pending_region_updates`
/// reports exactly which rects the GPU must copy.
#[derive(Debug, Clone)]
pub struct GlyphAtlasBook {
    spec: AtlasSpec,
    cells: std::collections::HashMap<u64, GlyphCell>,
    /// Shelf packer cursor: current shelf y and next free x on that shelf.
    shelf_y: u32,
    shelf_x: u32,
    shelf_height: u32,
    pending: Vec<[u32; 4]>,
    evicted: usize,
    /// Content-change counter (epoch seam for P1-01's ChartEpoch.resource_set):
    /// insert/replace and eviction batches advance it; idempotent re-place of
    /// identical pixels does not.
    resource_revision: u64,
}

pub const MAX_CELLS: usize = 4096;

impl GlyphAtlasBook {
    pub fn new(spec: AtlasSpec, shelf_height: u32) -> Self {
        Self {
            spec,
            cells: std::collections::HashMap::new(),
            shelf_y: 0,
            shelf_x: 0,
            shelf_height: shelf_height.max(1).min(spec.height.max(1)),
            pending: Vec::new(),
            evicted: 0,
            resource_revision: 0,
        }
    }

    pub fn spec(&self) -> AtlasSpec {
        self.spec
    }

    pub fn resource_revision(&self) -> u64 {
        self.resource_revision
    }

    pub fn cell(&self, glyph_key: u64) -> Option<&GlyphCell> {
        self.cells.get(&glyph_key)
    }

    pub fn pending_region_updates(&self) -> &[[u32; 4]] {
        &self.pending
    }

    pub fn evicted_count(&self) -> usize {
        self.evicted
    }

    pub fn cells_len_hint(&self) -> usize {
        self.cells.len()
    }

    /// Inserts or replaces one glyph cell. Returns the touched rect; an
    /// existing cell with the same source rect is a no-op (no new upload).
    pub fn place(
        &mut self,
        glyph_key: u64,
        source: [u32; 4],
        destination: [f64; 4],
    ) -> Result<(), AtlasUpdateError> {
        if self.cells.len() >= MAX_CELLS {
            // One-shot eviction of the oldest half: bounded amortized work.
            let mut keys: Vec<u64> = self.cells.keys().copied().collect();
            keys.sort_unstable();
            let drop_count = keys.len() / 2;
            for key in &keys[..drop_count] {
                self.cells.remove(key);
                self.evicted += 1;
            }
            if drop_count > 0 {
                self.resource_revision = self.resource_revision.saturating_add(1);
            }
        }
        if source[2] == 0 || source[3] == 0 {
            return Err(AtlasUpdateError::CellOutsideAtlas);
        }
        if source[0].saturating_add(source[2]) > self.spec.width
            || source[1].saturating_add(source[3]) > self.spec.height
        {
            return Err(AtlasUpdateError::CellOutsideAtlas);
        }
        if self
            .cells
            .get(&glyph_key)
            .is_some_and(|existing| existing.source == source)
        {
            return Ok(()); // identical pixels: no region upload
        }
        let shelf_span = source[3].max(1);
        if shelf_span > self.shelf_height {
            return Err(AtlasUpdateError::CellOutsideAtlas);
        }
        if self.shelf_x + source[2] > self.spec.width {
            // Advance to the next shelf row.
            self.shelf_y += self.shelf_height;
            self.shelf_x = 0;
        }
        if self.shelf_y + self.shelf_height > self.spec.height {
            return Err(AtlasUpdateError::DimensionChangeRequiresRebuild);
        }
        let cell = GlyphCell {
            glyph_key,
            source,
            destination,
        };
        self.cells.insert(glyph_key, cell);
        self.resource_revision = self.resource_revision.saturating_add(1);
        // The GPU only copies the new/changed rect, snapped to the shelf
        // position the book actually assigned (deterministic packing).
        let placed_x = self.shelf_x;
        let placed_y = self.shelf_y;
        self.pending
            .push([placed_x, placed_y, source[2], source[3]]);
        self.shelf_x += source[2];
        Ok(())
    }

    /// Drains the pending rect list; the renderer uploads exactly these.
    pub fn drain_pending(&mut self) -> Vec<[u32; 4]> {
        std::mem::take(&mut self.pending)
    }

    /// Places one real rasterized text (`GlyphRasterCache` output) as a single
    /// atlas cell. Pixel bytes stay owned by the cache's `Arc` — the pending
    /// rect reported here is what the GPU upload lane copies from that Arc in
    /// a later batch; this book never stores pixels. Empty rasters occupy a
    /// 1x1 transparent cell so the placement contract (non-zero rect) holds.
    pub fn place_text(
        &mut self,
        glyph_key: u64,
        raster: &crate::platform_text::raster::RasterizedText,
    ) -> Result<(), AtlasUpdateError> {
        let [width, height] = [raster.width.max(1), raster.height.max(1)];
        self.place(
            glyph_key,
            [0, 0, width, height],
            [0.0, 0.0, f64::from(width), f64::from(height)],
        )
    }
}

/// Shaped run: maps laid-out clusters (advance model injected) to baked
/// glyph placements. This is the cluster-level advance seam; full-text real
/// rasterization goes through `raster::GlyphRasterCache::rasterize` +
/// `GlyphAtlasBook::place_text` (one cell per text). Per-cluster real glyph
/// bitmaps feeding this run remain a later tranche.
pub fn shape_run(
    text: &str,
    advance_of: impl Fn(&str) -> f64,
    glyph_key_of: impl Fn(usize) -> u64,
) -> Vec<GlyphCell> {
    let clusters = crate::platform_text::layout::grapheme_clusters(text, advance_of);
    let mut pen_x = 0.0f64;
    clusters
        .into_iter()
        .enumerate()
        .map(|(index, cluster)| {
            let cell = GlyphCell {
                glyph_key: glyph_key_of(index),
                // Placeholder source: the rasterizer fills real atlas pixels.
                source: [0, 0, cluster.advance.max(1.0) as u32, 16],
                destination: [pen_x, 0.0, cluster.advance, 16.0],
            };
            pen_x += cluster.advance;
            cell
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AtlasSpec {
        AtlasSpec {
            width: 256,
            height: 256,
        }
    }

    #[test]
    fn incremental_places_only_new_cells_and_drains_clean() {
        let mut book = GlyphAtlasBook::new(spec(), 16);
        book.place(1, [0, 0, 10, 16], [0.0, 0.0, 10.0, 16.0])
            .expect("place 1");
        book.place(2, [0, 0, 12, 16], [10.0, 0.0, 12.0, 16.0])
            .expect("place 2");
        assert_eq!(book.pending_region_updates().len(), 2);

        // Same source pixels: zero new uploads (the incremental contract).
        book.place(1, [0, 0, 10, 16], [0.0, 0.0, 10.0, 16.0])
            .expect("idempotent");
        assert_eq!(
            book.pending_region_updates().len(),
            2,
            "no-op must not enqueue"
        );

        let drained = book.drain_pending();
        assert_eq!(drained.len(), 2);
        assert!(book.pending_region_updates().is_empty(), "drain clears");
    }

    #[test]
    fn shelf_packing_advances_rows_and_rejects_outside_cells() {
        let mut book = GlyphAtlasBook::new(spec(), 16);
        // 25 cells of width 16: after 16 the shelf must advance a row.
        for index in 0..25u64 {
            book.place(index, [0, 0, 16, 16], [0.0, 0.0, 16.0, 16.0])
                .expect("place");
        }
        let drained = book.drain_pending();
        let second_row = &drained[16];
        assert_eq!(second_row[1], 16, "row 2 starts at y=16");

        assert_eq!(
            book.place(99, [0, 0, 32, 32], [0.0, 0.0, 32.0, 32.0]),
            Err(AtlasUpdateError::CellOutsideAtlas),
            "taller than shelf is rejected"
        );
    }

    #[test]
    fn cell_budget_evicts_bounded_and_reports() {
        let mut book = GlyphAtlasBook::new(spec(), 8);
        let total = (MAX_CELLS + 64) as u64;
        for index in 0..total {
            // 1px-wide cells: shelf capacity (32 rows x 256) never binds
            // before the cell-count budget under test.
            let _ = book.place(index, [0, 0, 1, 8], [0.0, 0.0, 1.0, 8.0]);
        }
        assert!(book.cell(0).is_none(), "oldest half evicted");
        assert!(
            book.evicted_count() > 0,
            "over-budget inserts must trigger eviction"
        );
        assert!(book.cells_len_hint() <= MAX_CELLS);
    }

    #[test]
    fn shaping_maps_clusters_to_pen_advanced_placements() {
        let run = shape_run("a中b", |_| 1.0, |index| index as u64);
        assert_eq!(run.len(), 3, "three clusters");
        assert_eq!(run[1].destination[0], 1.0, "pen advanced past 'a'");
        assert_eq!(run[2].destination[0], 2.0, "CJK cluster advanced one unit");
        assert_eq!(run[0].glyph_key, 0);
    }
}
