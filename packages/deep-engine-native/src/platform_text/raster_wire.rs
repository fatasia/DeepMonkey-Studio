//! Frozen text producer wire contract; no filesystem or system-font discovery.
use super::raster::{FrozenFontInput, GlyphMeasureRequest, StyledTextRequest, TextRasterizer};
use serde::Deserialize;

pub const TEXT_RASTER_REQUEST_MAX_BYTES: usize = 90 * 1024 * 1024;
const FONT_BYTES_MAX: usize = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema: String,
    schema_version: u32,
    locale: String,
    fonts: Vec<Font>,
    request: StyledTextRequest,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Font {
    sha256: String,
    face_index: u32,
    data_base64: String,
}

/// The host supplies licensed frozen font bytes; this producer only validates identity.
pub fn rasterize_text_json(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > TEXT_RASTER_REQUEST_MAX_BYTES {
        return Err("text raster request exceeds 90 MiB".into());
    }
    let input: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if input.schema != "deep-engine.text-raster-request" || input.schema_version != 1 {
        return Err("unsupported text raster request schema".into());
    }
    if input.fonts.is_empty() || input.fonts.len() > 32 {
        return Err("frozen font count must be 1..32".into());
    }
    let mut total = 0usize;
    let mut fonts = Vec::with_capacity(input.fonts.len());
    for font in input.fonts {
        let size = crate::deep2d::runtime_base64::decoded_len(&font.data_base64)?;
        total = total.checked_add(size).ok_or("font byte budget overflow")?;
        if total > FONT_BYTES_MAX {
            return Err("frozen fonts exceed 64 MiB".into());
        }
        fonts.push(FrozenFontInput {
            bytes: crate::deep2d::runtime_base64::decode(&font.data_base64)?,
            sha256: font.sha256,
            face_index: font.face_index,
        });
    }
    let mut rasterizer = TextRasterizer::from_frozen_fonts(&input.locale, fonts)?;
    let result = rasterizer.rasterize_styled(input.request)?;
    let output = serde_json::json!({
        "schema": "deep-engine.text-raster-result", "schemaVersion": 1,
        "producer": "cosmic-text-0.19.0-frozen-v1",
        "sourceSha256": crate::shader_package::hash::sha256(bytes),
        "width": result.width, "height": result.height,
        "rgbaBase64": crate::deep2d::encode_base64(&result.rgba),
        "pixelSha256": crate::shader_package::hash::sha256(&result.rgba),
        "format": "rgba8unorm-srgb", "alphaMode": "straight",
        "glyphCount": result.glyph_count, "lineCount": result.line_count,
        "layoutWidth": result.layout_width, "layoutHeight": result.layout_height,
        "inkBounds": result.ink_bounds, "clipped": result.clipped,
        "lines": result.lines, "usedFaces": result.used_faces,
    });
    serde_json::to_vec(&output).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeasureRequest {
    schema: String,
    schema_version: u32,
    locale: String,
    fonts: Vec<Font>,
    request: GlyphMeasureRequest,
}

/// P1-18: the host supplies licensed frozen font bytes; the producer returns
/// measured baked-glyph placements plus the r8unorm glyph atlas they index.
pub fn measure_glyph_run_json(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > TEXT_RASTER_REQUEST_MAX_BYTES {
        return Err("glyph measure request exceeds 90 MiB".into());
    }
    let input: MeasureRequest = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if input.schema != "deep-engine.glyph-measure-request" || input.schema_version != 1 {
        return Err("unsupported glyph measure request schema".into());
    }
    if input.fonts.is_empty() || input.fonts.len() > 32 {
        return Err("frozen font count must be 1..32".into());
    }
    let mut total = 0usize;
    let mut fonts = Vec::with_capacity(input.fonts.len());
    for font in &input.fonts {
        let size = crate::deep2d::runtime_base64::decoded_len(&font.data_base64)?;
        total = total.checked_add(size).ok_or("font byte budget overflow")?;
        if total > FONT_BYTES_MAX {
            return Err("frozen fonts exceed 64 MiB".into());
        }
        fonts.push(FrozenFontInput {
            bytes: crate::deep2d::runtime_base64::decode(&font.data_base64)?,
            sha256: font.sha256.clone(),
            face_index: font.face_index,
        });
    }
    let mut rasterizer = TextRasterizer::from_frozen_fonts(&input.locale, fonts)?;
    let result = rasterizer.measure_glyph_run(&input.request)?;
    let output = serde_json::json!({
        "schema": "deep-engine.glyph-measure-result", "schemaVersion": 1,
        "producer": "cosmic-text-0.19.0-frozen-v1",
        "sourceSha256": crate::shader_package::hash::sha256(bytes),
        "atlas": {
            "width": result.atlas_width, "height": result.atlas_height,
            "format": "r8unorm",
            "dataBase64": crate::deep2d::encode_base64(&result.atlas_coverage),
            "coverageSha256": crate::shader_package::hash::sha256(&result.atlas_coverage),
        },
        "lines": result.lines,
    });
    serde_json::to_vec(&output).map_err(|e| e.to_string())
}
