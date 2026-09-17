//! Deterministic shelf packing for measured glyph rasters: first-seen order,
//! no dedupe (option runs are short), cells top-aligned on a shared shelf of
//! the tallest raster. An undersized atlas is an error, never a silent clip.

use super::measure::{GlyphMeasureRequest, MeasuredGlyphLine, MeasuredGlyphRun};

pub(super) struct Raster {
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) coverage: Vec<u8>,
}

/// Assigns each placement its atlas source rect and copies the coverage rows
/// in; rasters and placements arrive 1:1 from `measure_line`.
pub(super) fn pack_atlas(
    request: &GlyphMeasureRequest,
    mut lines: Vec<MeasuredGlyphLine>,
    rasters: Vec<Raster>,
) -> Result<MeasuredGlyphRun, String> {
    let shelf_height = rasters
        .iter()
        .map(|raster| raster.height)
        .max()
        .unwrap_or(1);
    let mut coverage = vec![0u8; request.atlas_width as usize * request.atlas_height as usize];
    let mut cursor_x = 0u32;
    let mut cursor_y = 0u32;
    for (placement, raster) in lines
        .iter_mut()
        .flat_map(|line| line.glyphs.iter_mut())
        .zip(&rasters)
    {
        if cursor_x + raster.width > request.atlas_width {
            cursor_x = 0;
            cursor_y += shelf_height;
        }
        if u64::from(cursor_y) + u64::from(raster.height) > u64::from(request.atlas_height) {
            return Err(format!(
                "glyph atlas {}x{} is too small for {} measured cells",
                request.atlas_width,
                request.atlas_height,
                rasters.len()
            ));
        }
        placement.source = [cursor_x, cursor_y, raster.width, raster.height];
        for row in 0..raster.height {
            let source = &raster.coverage
                [(row * raster.width) as usize..((row + 1) * raster.width) as usize];
            let target =
                (cursor_y + row) as usize * request.atlas_width as usize + cursor_x as usize;
            coverage[target..target + raster.width as usize].copy_from_slice(source);
        }
        cursor_x += raster.width;
    }
    Ok(MeasuredGlyphRun {
        atlas_width: request.atlas_width,
        atlas_height: request.atlas_height,
        atlas_coverage: coverage,
        lines,
    })
}
