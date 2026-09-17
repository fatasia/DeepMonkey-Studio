//! P1-18 glyph-run measurement over frozen fonts: real cosmic-text shaping with
//! real per-glyph swash coverage rasters. Every source/destination rect comes
//! from the sha256-verified frozen bytes — this producer never estimates
//! advances. The output maps 1:1 onto the deep2d `BakedGlyphPlacement` contract
//! (cluster = UTF-16 offset into the line text, source = atlas pixel rect,
//! destination = logical rect relative to the line top-left), so a filter
//! option row converts directly into a text command.

use super::measure_atlas::{Raster, pack_atlas};
use super::{FrozenTextRasterizer, styled_types::*};
use cosmic_text::{Attrs, Buffer, Family, Metrics, Shaping, Style, Weight};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const GLYPH_MEASURE_MAX_LINES: usize = 256;
const GLYPH_MEASURE_MAX_LINE_BYTES: usize = 4096;
pub const GLYPH_MEASURE_MAX_ATLAS_DIMENSION: u32 = 4096;
/// Hard cell budget: mirrors the atlas cell economics (`MAX_CELLS`), far below
/// the per-command baked-glyph budget, so a runaway request fails here.
pub const GLYPH_MEASURE_MAX_CELLS: usize = 4096;

/// One measurement line: a single unwrapped option label and its frozen face.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GlyphMeasureLine {
    pub text: String,
    pub font: FrozenFontRef,
    pub weight: u16,
    pub style: TextFontStyle,
    pub font_size: f32,
    pub line_height: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GlyphMeasureRequest {
    pub lines: Vec<GlyphMeasureLine>,
    pub atlas_width: u32,
    pub atlas_height: u32,
}

/// Baked glyph placement; field-for-field `deep2d::BakedGlyphPlacement`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredGlyphPlacement {
    pub cluster: u32,
    /// Pixel rect inside the atlas: [x, y, width, height].
    pub source: [u32; 4],
    /// Logical rect relative to the line top-left: [x, y, width, height].
    pub destination: [f64; 4],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredGlyphLine {
    pub text: String,
    /// Shaped advance width in logical pixels (0 for deferred lines).
    pub layout_width: f64,
    /// Empty means "no measurable glyphs for this line" (whitespace-only or an
    /// absent face raster); the host must keep such a line deferred.
    pub glyphs: Vec<MeasuredGlyphPlacement>,
}

#[derive(Debug, PartialEq)]
pub struct MeasuredGlyphRun {
    pub atlas_width: u32,
    pub atlas_height: u32,
    /// r8unorm coverage bytes, row-major, `atlas_width * atlas_height` long.
    pub atlas_coverage: Vec<u8>,
    pub lines: Vec<MeasuredGlyphLine>,
}

impl FrozenTextRasterizer {
    /// Measures the request lines against the frozen faces. Deterministic:
    /// identical inputs produce identical placements and atlas coverage.
    pub fn measure_glyph_run(
        &mut self,
        request: &GlyphMeasureRequest,
    ) -> Result<MeasuredGlyphRun, String> {
        validate_request(request)?;
        let mut lines = Vec::with_capacity(request.lines.len());
        let mut rasters: Vec<Raster> = Vec::new();
        let mut total_cells = 0usize;
        for line in &request.lines {
            let (measured, line_rasters) = self.measure_line(line)?;
            total_cells += line_rasters.len();
            if total_cells > GLYPH_MEASURE_MAX_CELLS {
                return Err(format!(
                    "glyph measure request exceeds {GLYPH_MEASURE_MAX_CELLS} raster cells"
                ));
            }
            rasters.extend(line_rasters);
            lines.push(measured);
        }
        pack_atlas(request, lines, rasters)
    }

    /// Shapes one line and rasters every glyph; returns the placements (source
    /// rect still unassigned) and their rasters in the same 1:1 order.
    fn measure_line(
        &mut self,
        line: &GlyphMeasureLine,
    ) -> Result<(MeasuredGlyphLine, Vec<Raster>), String> {
        let face = self.primary(&primary_probe(line))?.clone();
        let style = match line.style {
            TextFontStyle::Normal => Style::Normal,
            TextFontStyle::Italic => Style::Italic,
            TextFontStyle::Oblique => Style::Oblique,
        };
        let attrs = Attrs::new()
            .family(Family::Name(&face.family))
            .weight(Weight(line.weight))
            .style(style);
        // Infinite layout width: option rows are single unwrapped labels.
        let mut buffer = Buffer::new(
            &mut self.inner.fonts,
            Metrics::new(line.font_size, line.line_height),
        );
        buffer.set_size(None, None);
        buffer.set_text(&line.text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.inner.fonts, false);
        let utf16 = utf16_offsets(&line.text);
        let mut placements = Vec::new();
        let mut rasters = Vec::new();
        let mut layout_width = 0f64;
        for run in buffer.layout_runs() {
            layout_width = layout_width.max(f64::from(run.line_w));
            for glyph in run.glyphs {
                if glyph.glyph_id == 0 {
                    return Err(format!(
                        "frozen fonts cannot render cluster at bytes {}..{} of {:?}",
                        glyph.start, glyph.end, line.text
                    ));
                }
                // glyph.start is a byte offset; the contract speaks UTF-16.
                let Some(&cluster) = utf16.get(&glyph.start) else {
                    return Err(format!(
                        "shaped cluster byte offset {} is outside {:?}",
                        glyph.start, line.text
                    ));
                };
                let physical = glyph.physical((0.0, run.line_y), 1.0);
                let Some(image) = self
                    .inner
                    .cache
                    .get_image(&mut self.inner.fonts, physical.cache_key)
                else {
                    return Err(format!(
                        "swash produced no raster for cluster {cluster} of {:?}",
                        line.text
                    ));
                };
                let placement = image.placement;
                // Zero-area rasters (spaces) cannot satisfy the baked-glyph
                // contract's positive-area source rect, so they are not emitted;
                // remaining clusters keep their relative order.
                if placement.width == 0 || placement.height == 0 {
                    continue;
                }
                // Coverage bitmaps are one byte per pixel; color bitmaps
                // (four bytes per pixel or larger) are rejected fail-closed.
                if image.data.len() != (placement.width * placement.height) as usize {
                    return Err(format!(
                        "glyph raster for cluster {cluster} is not an 8-bit coverage bitmap"
                    ));
                }
                rasters.push(Raster {
                    width: placement.width,
                    height: placement.height,
                    coverage: image.data.to_vec(),
                });
                // Destination relative to the line top-left, in screen
                // coordinates (y down). swash reports placement.top with the
                // typographic sign (positive above the baseline), so the
                // screen offset negates it — exactly what cosmic-text's own
                // renderer does (`with_pixels` yields y = -placement.top).
                let x = f64::from(physical.x + placement.left);
                let y = f64::from(physical.y - placement.top) - f64::from(run.line_top);
                placements.push(MeasuredGlyphPlacement {
                    cluster,
                    source: [0, 0, placement.width, placement.height],
                    destination: [
                        x,
                        y,
                        f64::from(placement.width),
                        f64::from(placement.height),
                    ],
                });
            }
        }
        Ok((
            MeasuredGlyphLine {
                text: line.text.clone(),
                layout_width,
                glyphs: placements,
            },
            rasters,
        ))
    }
}

/// `primary` validates a full `StyledTextRequest`; measurement lines only carry
/// the face selector, so probe values fill the unused viewport fields.
fn primary_probe(line: &GlyphMeasureLine) -> StyledTextRequest {
    StyledTextRequest {
        text: String::new(),
        font: line.font.clone(),
        weight: line.weight,
        style: line.style,
        align: TextAlign::Left,
        vertical_align: TextVerticalAlign::Top,
        wrap: TextWrap::None,
        font_size: line.font_size,
        line_height: line.line_height,
        width: 1,
        height: 1,
        color: [0, 0, 0, 0],
    }
}

fn validate_request(request: &GlyphMeasureRequest) -> Result<(), String> {
    if request.lines.is_empty()
        || request.lines.len() > GLYPH_MEASURE_MAX_LINES
        || request.atlas_width == 0
        || request.atlas_height == 0
        || request.atlas_width > GLYPH_MEASURE_MAX_ATLAS_DIMENSION
        || request.atlas_height > GLYPH_MEASURE_MAX_ATLAS_DIMENSION
    {
        return Err("glyph measure request exceeds line or atlas limits".into());
    }
    for line in &request.lines {
        if line.text.is_empty()
            || line.text.len() > GLYPH_MEASURE_MAX_LINE_BYTES
            || line.text.chars().any(char::is_control)
        {
            return Err(format!(
                "glyph measure line {:?} is empty, too long or multiline",
                line.text
            ));
        }
        if !line.font_size.is_finite()
            || !(1.0..=256.0).contains(&line.font_size)
            || !line.line_height.is_finite()
            || !(1.0..=512.0).contains(&line.line_height)
        {
            return Err("glyph measure line exceeds font metric limits".into());
        }
    }
    Ok(())
}

/// Byte offset → UTF-16 code unit offset for every char start in `text`.
fn utf16_offsets(text: &str) -> HashMap<usize, u32> {
    let mut offsets = HashMap::new();
    let mut utf16 = 0u32;
    for (byte, ch) in text.char_indices() {
        offsets.insert(byte, utf16);
        utf16 += ch.len_utf16() as u32;
    }
    offsets
}
