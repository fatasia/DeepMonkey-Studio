//! A bounded same-font job reuses shaping state while preserving each original wire identity.
use super::{Font, FrozenFontInput, StyledTextRequest, TextRasterizer, result_value};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch {
    schema: String,
    schema_version: u32,
    // Exact serialized single-request header, without its final `request` field.
    shared: String,
    requests: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Shared {
    schema: String,
    schema_version: u32,
    locale: String,
    fonts: Vec<Font>,
}

pub fn rasterize_text_batch_json(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() > super::TEXT_RASTER_REQUEST_MAX_BYTES { return Err("text batch exceeds 90 MiB".into()); }
    let batch: Batch = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if batch.schema != "deep-engine.text-raster-batch" || batch.schema_version != 1
        || batch.requests.is_empty() || batch.requests.len() > 512 {
        return Err("unsupported text batch schema or count".into());
    }
    let shared: Shared = serde_json::from_str(&batch.shared).map_err(|e| e.to_string())?;
    if shared.schema != "deep-engine.text-raster-request" || shared.schema_version != 1
        || shared.fonts.is_empty() || shared.fonts.len() > 32 {
        return Err("invalid text batch shared header".into());
    }
    let prefix = batch.shared.strip_suffix('}').ok_or("shared header must end with object")?;
    let mut source = crate::shader_package::hash::Sha256::new();
    source.update(prefix.as_bytes()); source.update(b",\"request\":");
    let mut pixels = 0usize;
    let mut requests = Vec::with_capacity(batch.requests.len());
    for wire in &batch.requests {
        if wire.len() > 128 * 1024 { return Err("text batch item exceeds 128 KiB".into()); }
        let request: StyledTextRequest = serde_json::from_str(wire).map_err(|e| e.to_string())?;
        pixels = pixels.checked_add((request.width as usize).checked_mul(request.height as usize)
            .and_then(|value| value.checked_mul(4)).ok_or("text batch extent overflow")?).ok_or("text batch budget overflow")?;
        if pixels > 64 * 1024 * 1024 { return Err("text batch pixels exceed 64 MiB".into()); }
        requests.push(request);
    }
    let mut total = 0usize;
    let mut fonts = Vec::with_capacity(shared.fonts.len());
    for font in shared.fonts {
        total = total.checked_add(crate::deep2d::runtime_base64::decoded_len(&font.data_base64)?).ok_or("font byte overflow")?;
        if total > super::FONT_BYTES_MAX { return Err("frozen fonts exceed 64 MiB".into()); }
        fonts.push(FrozenFontInput { bytes: crate::deep2d::runtime_base64::decode(&font.data_base64)?,
            sha256: font.sha256, face_index: font.face_index });
    }
    let mut rasterizer = TextRasterizer::from_frozen_fonts(&shared.locale, fonts)?;
    let mut results = Vec::with_capacity(requests.len());
    for (request, wire) in requests.into_iter().zip(batch.requests) {
        let mut identity = source.clone(); identity.update(wire.as_bytes()); identity.update(b"}");
        results.push(result_value(rasterizer.rasterize_styled(request)?, identity.finish()));
    }
    serde_json::to_vec(&serde_json::json!({ "schema": "deep-engine.text-raster-batch-result", "schemaVersion": 1, "results": results }))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn header() -> (String, serde_json::Value) {
        let system = cosmic_text::FontSystem::new();
        let face = system.db().faces().find(|face| face.weight.0 == 400 && face.style == cosmic_text::Style::Normal
            && face.families.iter().any(|(name, _)| ["Arial", "DejaVu Sans", "Liberation Sans"].contains(&name.as_str())))
            .expect("test requires static Latin font");
        let font = system.db().with_face_data(face.id, |bytes, index| serde_json::json!({
            "sha256": crate::shader_package::hash::sha256(bytes), "faceIndex": index,
            "dataBase64": crate::deep2d::encode_base64(bytes) })).unwrap();
        let reference = serde_json::json!({ "sha256": font["sha256"], "faceIndex": font["faceIndex"] });
        (serde_json::json!({ "schema": "deep-engine.text-raster-request", "schemaVersion": 1,
            "locale": "en-US", "fonts": [font] }).to_string(), reference)
    }
    #[test]
    fn batch_matches_single_pixels_source_identity_and_font_receipts() {
        let (shared, font) = header();
        let requests: Vec<String> = ["Alpha", "A B", ""].into_iter().map(|text| serde_json::json!({
            "text": text, "font": font, "weight": 400, "style": "normal", "align": "left",
            "verticalAlign": "top", "wrap": "none", "fontSize": 16, "lineHeight": 20,
            "width": 128, "height": 32, "color": [255,255,255,255] }).to_string()).collect();
        let wire = serde_json::json!({ "schema": "deep-engine.text-raster-batch", "schemaVersion": 1,
            "shared": shared, "requests": requests }).to_string();
        let actual: serde_json::Value = serde_json::from_slice(&rasterize_text_batch_json(wire.as_bytes()).unwrap()).unwrap();
        for (index, request) in requests.iter().enumerate() {
            let single = format!("{},\"request\":{}}}", shared.strip_suffix('}').unwrap(), request);
            let expected: serde_json::Value = serde_json::from_slice(&super::super::rasterize_text_json(single.as_bytes()).unwrap()).unwrap();
            assert_eq!(actual["results"][index], expected);
        }
    }
    #[test]
    fn batch_rejects_unknown_fields_empty_and_oversized_jobs() {
        for value in [serde_json::json!({ "schema":"deep-engine.text-raster-batch", "schemaVersion":1,"shared":"{}","requests":[] }),
            serde_json::json!({ "schema":"deep-engine.text-raster-batch", "schemaVersion":1,"shared":"{}","requests":["{}"],"extra":true }),
            serde_json::json!({ "schema":"deep-engine.text-raster-batch", "schemaVersion":1,"shared":"{}","requests":vec!["{}";513] })] {
            assert!(rasterize_text_batch_json(value.to_string().as_bytes()).is_err());
        }
    }
}
