//! Bounded trusted-worker wire for offline panorama prefiltering.
use super::{PreparedIblCube, panorama};
use serde::Deserialize;
use serde_json::{Value, json};
#[path = "../half_float.rs"]
mod half;
pub const MAX_REQUEST_BYTES: usize = 40 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    schema: String,
    width: u32,
    height: u32,
    rgb_float32_le_base64: String,
    source_hash: String,
    license: String,
    specular_size: u32,
}
pub fn prefilter_json(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_REQUEST_BYTES {
        return Err("HDR prefilter request budget exceeded".into());
    }
    let request: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let pixels = u64::from(request.width) * u64::from(request.height);
    if request.schema != "deep-engine.hdr-prefilter-request.v1"
        || !(4..=2_097_152).contains(&pixels)
        || request.license.trim().is_empty()
        || request.license.encode_utf16().count() > 256
        || request.source_hash.len() != 64
        || !request
            .source_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid HDR prefilter identity or dimensions".into());
    }
    let length = crate::deep2d::runtime_base64::decoded_len(&request.rgb_float32_le_base64)?;
    if length as u64 != pixels * 12 {
        return Err("HDR RGB byte count mismatch".into());
    }
    let bytes = crate::deep2d::runtime_base64::decode(&request.rgb_float32_le_base64)?;
    let rgb: Vec<[f32; 3]> = bytes
        .chunks_exact(12)
        .map(|pixel| {
            std::array::from_fn(|i| f32::from_le_bytes(pixel[i * 4..i * 4 + 4].try_into().unwrap()))
        })
        .collect();
    let environment = panorama::prefilter(
        &panorama::Panorama {
            width: request.width,
            height: request.height,
            rgb: &rgb,
        },
        &request.source_hash,
        request.specular_size,
    )?;
    let encode = |values: &[[f32; 4]]| {
        crate::deep2d::encode_base64(
            &values
                .iter()
                .flat_map(|pixel| {
                    pixel
                        .iter()
                        .flat_map(|value| half::f32_to_f16(*value).to_le_bytes())
                })
                .collect::<Vec<_>>(),
        )
    };
    let cube = |value: &PreparedIblCube| json!({"mips":value.mips.iter().map(|mip|json!({"size":mip.size,"dataBase64":encode(&mip.texels)})).collect::<Vec<Value>>()});
    serde_json::to_vec(&json!({"schema":"deep-engine.ibl-prefiltered","schemaVersion":1,"id":"scene.environment","revision":1,"kind":"prefiltered-hdri","format":"rgba16float","encoding":"base64-le","faceOrder":"px-nx-py-ny-pz-nz",
        "source":{"contentHash":{"algorithm":"sha256","value":request.source_hash},"license":request.license},
        "specular":cube(&environment.specular),"diffuse":cube(&environment.diffuse),"brdfLut":{"width":environment.brdf_lut.width,"height":environment.brdf_lut.height,"dataBase64":encode(&environment.brdf_lut.texels)}})).map_err(|e|e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value {
        let rgb = crate::deep2d::encode_base64(
            &[4.0f32, 2.0, 0.5]
                .into_iter()
                .cycle()
                .take(24)
                .flat_map(f32::to_le_bytes)
                .collect::<Vec<_>>(),
        );
        json!({"schema":"deep-engine.hdr-prefilter-request.v1","width":4,"height":2,"rgbFloat32LeBase64":rgb,"sourceHash":"a".repeat(64),"license":"CC0","specularSize":16})
    }
    #[test]
    fn hdr_wire_preserves_provenance_and_rejects_shape_budget_and_nonfinite_input() {
        let valid = request();
        let output: Value =
            serde_json::from_slice(&prefilter_json(&serde_json::to_vec(&valid).unwrap()).unwrap())
                .unwrap();
        assert_eq!(
            output["source"]["contentHash"]["value"],
            valid["sourceHash"]
        );
        assert_eq!(output["specular"]["mips"].as_array().unwrap().len(), 5);
        for (key, value) in [
            ("width", json!(4096)),
            ("sourceHash", json!("x")),
            ("license", json!("")),
            ("specularSize", json!(2048)),
            ("extra", json!(true)),
            (
                "rgbFloat32LeBase64",
                json!(crate::deep2d::encode_base64(
                    &[f32::INFINITY; 24]
                        .into_iter()
                        .flat_map(f32::to_le_bytes)
                        .collect::<Vec<_>>()
                )),
            ),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            assert!(
                prefilter_json(&serde_json::to_vec(&changed).unwrap()).is_err(),
                "{key}"
            );
        }
    }
}
