use deep_engine_native::deep2d::{Deep2dRect, LetterboxMapping};

/// Maps a logical clip to physical target pixels and rounds outwards so the
/// scissor cannot cut into the requested logical rectangle.
///
/// The mapping must be the same letterbox the vertex shader applies
/// (`logical_to_ndc`: uniform min-axis scale plus centering offset). A per-axis
/// stretch here desynchronizes the scissor from the actual vertex positions on
/// mismatched-aspect windows and culls precisely-clipped chunks (chart heading
/// image quads, legend/axis glyph chunks) out of the frame entirely.
pub(crate) fn chunk_scissor(
    clip_rect: Option<Deep2dRect>,
    logical_size: [f32; 2],
    physical_size: (u32, u32),
) -> Option<[u32; 4]> {
    let Some(rect) = clip_rect else {
        return Some([0, 0, physical_size.0, physical_size.1]);
    };
    if logical_size[0] <= 0.0 || logical_size[1] <= 0.0 {
        return None;
    }
    let mapping = LetterboxMapping::new(
        [f64::from(logical_size[0]), f64::from(logical_size[1])],
        [f64::from(physical_size.0), f64::from(physical_size.1)],
    );
    let left = (rect.x * mapping.scale + mapping.offset[0]).floor() as i64;
    let top = (rect.y * mapping.scale + mapping.offset[1]).floor() as i64;
    let right = ((rect.x + rect.width) * mapping.scale + mapping.offset[0]).ceil() as i64;
    let bottom = ((rect.y + rect.height) * mapping.scale + mapping.offset[1]).ceil() as i64;
    let start_x = left.max(0);
    let start_y = top.max(0);
    let end_x = right.min(i64::from(physical_size.0));
    let end_y = bottom.min(i64::from(physical_size.1));
    (start_x < end_x && start_y < end_y).then(|| {
        [
            start_x as u32,
            start_y as u32,
            (end_x - start_x) as u32,
            (end_y - start_y) as u32,
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_logical_clip_to_high_dpi_pixels() {
        let clip = Deep2dRect {
            x: 0.5,
            y: 0.25,
            width: 1.0,
            height: 0.5,
        };
        assert_eq!(
            chunk_scissor(Some(clip), [4.0, 1.0], (8, 4)),
            Some([1, 1, 2, 2])
        );
    }

    #[test]
    fn clamps_partial_clips_and_suppresses_offscreen_draws() {
        let partial = Deep2dRect {
            x: -1.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        let outside = Deep2dRect {
            x: 5.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        assert_eq!(
            chunk_scissor(Some(partial), [4.0, 1.0], (8, 2)),
            Some([0, 0, 2, 2])
        );
        assert_eq!(chunk_scissor(Some(outside), [4.0, 1.0], (8, 2)), None);
    }

    #[test]
    fn follows_letterbox_offset_on_mismatched_aspect_windows() {
        // 960x540 logical on a 1200x800 window: shader scale 1.25 with a
        // (0, 62.5) centering offset. A heading box at the top of the page
        // must map with the offset, not the per-axis stretch (which would
        // place the scissor 60+ pixels too high and cull the chunk).
        let heading = Deep2dRect {
            x: 287.0,
            y: 121.0,
            width: 90.0,
            height: 26.0,
        };
        assert_eq!(
            chunk_scissor(Some(heading), [960.0, 540.0], (1200, 800)),
            Some([358, 213, 114, 34])
        );
        // A clip fully inside the letterbox border stays culled.
        let above_canvas = Deep2dRect {
            x: 0.0,
            y: -100.0,
            width: 90.0,
            height: 26.0,
        };
        assert_eq!(
            chunk_scissor(Some(above_canvas), [960.0, 540.0], (1200, 800)),
            None
        );
    }
}
