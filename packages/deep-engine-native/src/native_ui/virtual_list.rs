//! Virtual list windowing (U06): keeps the active node count a function of
//! the viewport, never of `total`, so a 100k-row list mounts the same number
//! of nodes as a 1k-row one. Pure arithmetic — the retained-tree stage maps
//! the returned window onto visible nodes.

/// The slice of a virtual list that should exist in the retained tree.
/// `first_index` already steps back by `overscan` rows; `visible_count` is
/// the true viewport row count (overscan excluded), so the mounted row budget
/// stays `visible_count + 2 * overscan`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualWindow {
    pub first_index: usize,
    pub visible_count: usize,
    pub overscan: usize,
}

impl VirtualWindow {
    /// Rows actually mounted: the visible window padded by overscan on both
    /// sides, clamped to the item count.
    pub fn mounted_count(&self) -> usize {
        self.visible_count + 2 * self.overscan
    }

    /// Inclusive-exclusive range of mounted indices, clamped to `total`.
    pub fn mounted_range(&self, total: usize) -> std::ops::Range<usize> {
        let start = self.first_index.min(total);
        let end = start
            .checked_add(self.visible_count.saturating_add(2 * self.overscan))
            .unwrap_or(total)
            .min(total);
        start..end
    }
}

/// Computes the mounted window for uniform row height. Degenerate inputs
/// (`item_height`/`viewport_height` non-finite or non-positive) yield an
/// empty window rather than guessing a row height; `scroll_offset` beyond
/// the scrollable range is clamped back into it.
pub fn compute_window(
    total: usize,
    item_height: f64,
    viewport_height: f64,
    scroll_offset: f64,
    overscan: usize,
) -> VirtualWindow {
    let empty = VirtualWindow {
        first_index: 0,
        visible_count: 0,
        overscan,
    };
    if total == 0 || !item_height.is_finite() || !viewport_height.is_finite() {
        return empty;
    }
    if item_height <= 0.0 || viewport_height <= 0.0 {
        return empty;
    }
    // Rows fully or partially inside the viewport; ceil so a row straddling
    // the bottom edge is still mounted.
    let visible_count = (viewport_height / item_height).ceil() as usize;
    let content_height = item_height * total as f64;
    let max_offset = (content_height - viewport_height).max(0.0);
    let clamped_offset = if scroll_offset.is_finite() {
        scroll_offset.clamp(0.0, max_offset)
    } else {
        0.0
    };
    let first_visible = (clamped_offset / item_height).floor() as usize;
    let first_index = first_visible.saturating_sub(overscan).min(total);
    VirtualWindow {
        first_index,
        visible_count,
        overscan,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_rows_stay_bounded_for_huge_lists() {
        let window = compute_window(100_000, 24.0, 480.0, 1_000.0, 4);
        // 480/24 = 20 visible rows; mounted = 20 + 2*4 overscan.
        assert_eq!(window.visible_count, 20);
        assert_eq!(
            window.first_index,
            1_000.0_f64.div_euclid(24.0) as usize - 4
        );
        assert_eq!(window.mounted_range(100_000).len(), 28);
        assert!(window.mounted_count() <= 20 + 2 * 4);
    }

    #[test]
    fn scroll_offset_clamps_to_scrollable_range() {
        let under = compute_window(100, 20.0, 200.0, -50.0, 0);
        assert_eq!((under.first_index, under.visible_count), (0, 10));
        let over = compute_window(100, 20.0, 200.0, 10_000.0, 0);
        // max offset = 2000 - 200 = 1800 -> first visible row 90, still 10 rows.
        assert_eq!((over.first_index, over.visible_count), (90, 10));
        let nan = compute_window(100, 20.0, 200.0, f64::NAN, 0);
        assert_eq!(nan.first_index, 0);
    }

    #[test]
    fn degenerate_inputs_yield_empty_window() {
        assert_eq!(
            compute_window(0, 20.0, 200.0, 0.0, 3),
            VirtualWindow {
                first_index: 0,
                visible_count: 0,
                overscan: 3
            }
        );
        assert_eq!(compute_window(100, 0.0, 200.0, 0.0, 0).visible_count, 0);
        assert_eq!(
            compute_window(100, 20.0, f64::INFINITY, 0.0, 0).visible_count,
            0
        );
        // viewport taller than content: everything mounts, nothing more.
        let short = compute_window(5, 20.0, 200.0, 0.0, 10);
        assert_eq!(short.mounted_range(5), 0..5);
    }
}
