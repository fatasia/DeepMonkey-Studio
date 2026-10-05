//! Per-frame paint registry: assigns stable storage slots to paint entries so
//! path vertices can reference gradients/quads by index. Slot 0 is a reserved
//! solid dummy (solid fills render from the vertex color without touching the
//! storage buffer). Content dedup keeps identical gradients on one slot.
//!
//! Cache interplay: cached vertices embed slot ids from their store frame.
//! `painter_cache` re-registers the entry's paints on every hit and patches
//! the vertex slot ids to the fresh frame's slots, so cache reuse stays
//! correct across frames with different paint sets.

use std::collections::HashMap;

use super::paint_data::Deep2dPaintData;
use super::painter::{Deep2dPainterIssue, Deep2dPainterIssueCode, issue};

/// Hard cap on distinct paint entries per prepared frame (mirrored from
/// `DEEP_2D_DISPLAY_LIST_BUDGETS.paints`); keeps the storage upload bounded.
pub(super) const MAX_FRAME_PAINTS: usize = super::DEEP_2D_DISPLAY_LIST_BUDGETS.paints;

const _: () =
    assert!(super::paint_data::DEEP2D_MAX_GRADIENT_STOPS == super::DEEP_2D_DISPLAY_LIST_BUDGETS.gradient_stops_per_paint);

pub(super) struct PaintRegistry {
    entries: Vec<Deep2dPaintData>,
    /// Content fingerprint -> candidate slot ids (checked byte-exactly).
    index: HashMap<u64, Vec<u32>>,
}

impl Default for PaintRegistry {
    fn default() -> Self {
        // Slot 0: reserved solid dummy; solid vertices carry paint_index 0
        // and never read the storage buffer.
        Self {
            entries: vec![Deep2dPaintData::default()],
            index: HashMap::new(),
        }
    }
}

impl PaintRegistry {
    pub(super) fn register(&mut self, paint: Deep2dPaintData) -> Result<u32, Deep2dPainterIssue> {
        let key = content_fingerprint(&paint);
        if let Some(slots) = self.index.get(&key) {
            for slot in slots {
                if self.entries[*slot as usize] == paint {
                    return Ok(*slot);
                }
            }
        }
        if self.entries.len() >= MAX_FRAME_PAINTS {
            return Err(issue(
                Deep2dPainterIssueCode::TessellationBudgetExceeded,
                "paints",
                "Display list exceeds the paint storage budget.",
            ));
        }
        let slot = self.entries.len() as u32;
        self.entries.push(paint);
        self.index.entry(key).or_default().push(slot);
        Ok(slot)
    }

    /// Registers a cache entry's paints (entry-local slot space: quad
    /// `fill_index` counts 1..n into this list). Two-pass so quads register
    /// AFTER their fills carry frame slots — identical quad content then
    /// dedups onto one frame slot instead of duplicating per cache entry.
    pub(super) fn register_all(
        &mut self,
        paints: &[Deep2dPaintData],
    ) -> Result<Vec<u32>, Deep2dPainterIssue> {
        let mut slots = vec![0u32; paints.len()];
        for (index, paint) in paints.iter().enumerate() {
            if paint.kind != super::paint_data::DEEP2D_PAINT_KIND_QUAD {
                slots[index] = self.register(*paint)?;
            }
        }
        for (index, paint) in paints.iter().enumerate() {
            if paint.kind == super::paint_data::DEEP2D_PAINT_KIND_QUAD {
                let mut frame_paint = *paint;
                if frame_paint.fill_index != 0 {
                    let local = frame_paint.fill_index as usize;
                    frame_paint.fill_index = slots[local - 1];
                }
                slots[index] = self.register(frame_paint)?;
            }
        }
        Ok(slots)
    }

    /// The entry at a slot (cache entry self-containment capture).
    pub(super) fn paint_at(&self, slot: u32) -> Option<&Deep2dPaintData> {
        self.entries.get(slot as usize)
    }

    pub(super) fn finish(self) -> Vec<Deep2dPaintData> {
        self.entries
    }
}

fn content_fingerprint(paint: &Deep2dPaintData) -> u64 {
    use std::hash::Hasher;
    let bytes: &[u8] = bytemuck::bytes_of(paint);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write_u64(bytes.len() as u64);
    hasher.write(bytes);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deep2d::paint_data::{DEEP2D_PAINT_KIND_LINEAR, DEEP2D_MAX_GRADIENT_STOPS, Deep2dPaintStop};

    fn gradient(color: [f32; 4]) -> Deep2dPaintData {
        let mut stops = [Deep2dPaintStop {
            offset: 0.0,
            pad: [0.0; 3],
            color: [0.0; 4],
        }; DEEP2D_MAX_GRADIENT_STOPS];
        stops[0].color = color;
        Deep2dPaintData {
            kind: DEEP2D_PAINT_KIND_LINEAR,
            p0: [0.0, 0.0],
            p1: [10.0, 0.0],
            stop_count: 1,
            stops,
            ..Default::default()
        }
    }

    #[test]
    fn identical_content_shares_one_slot() {
        let mut registry = PaintRegistry::default();
        let first = registry.register(gradient([1.0, 0.0, 0.0, 1.0])).unwrap();
        let second = registry.register(gradient([1.0, 0.0, 0.0, 1.0])).unwrap();
        assert_eq!(first, second);
        assert_ne!(first, 0, "slot 0 is the reserved solid dummy");
        assert_eq!(registry.finish().len(), 2);
    }

    #[test]
    fn distinct_content_gets_distinct_slots() {
        let mut registry = PaintRegistry::default();
        let red = registry.register(gradient([1.0, 0.0, 0.0, 1.0])).unwrap();
        let blue = registry.register(gradient([0.0, 0.0, 1.0, 1.0])).unwrap();
        assert_ne!(red, blue);
    }

    #[test]
    fn budget_fails_closed() {
        let mut registry = PaintRegistry::default();
        for index in 0..MAX_FRAME_PAINTS - 1 {
            registry
                .register(Deep2dPaintData {
                    kind: 99,
                    p0: [index as f32, 0.0],
                    ..Default::default()
                })
                .expect("within budget");
        }
        let overflow = registry.register(gradient([0.0, 1.0, 0.0, 1.0]));
        assert!(overflow.is_err(), "paint budget must fail closed");
    }
}
