use deep_engine_native::deep2d::Deep2dRect;

/// Maps a logical clip to physical target pixels and rounds outwards so the
/// scissor cannot cut into the requested logical rectangle.
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
    let scale = [
        f64::from(physical_size.0) / f64::from(logical_size[0]),
        f64::from(physical_size.1) / f64::from(logical_size[1]),
    ];
    let left = (rect.x * scale[0]).floor() as i64;
    let top = (rect.y * scale[1]).floor() as i64;
    let right = ((rect.x + rect.width) * scale[0]).ceil() as i64;
    let bottom = ((rect.y + rect.height) * scale[1]).ceil() as i64;
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
}
