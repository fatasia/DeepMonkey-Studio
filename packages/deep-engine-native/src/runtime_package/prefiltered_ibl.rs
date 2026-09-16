use super::{RuntimeContentHash, RuntimeResourceIndexEntry};
use crate::ibl::{
    PreparedIblCube, PreparedIblCubeMip, PreparedIblEnvironment, PreparedIblTexture2d,
};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
#[path = "../deep2d/runtime_base64.rs"]
mod base64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Wire {
    schema: String,
    #[serde(deserialize_with = "integer")]
    schema_version: u32,
    id: String,
    #[serde(deserialize_with = "integer")]
    revision: u32,
    kind: String,
    format: String,
    encoding: String,
    face_order: String,
    source: Source,
    specular: Cube,
    diffuse: Cube,
    brdf_lut: Lut,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Source {
    content_hash: RuntimeContentHash,
    license: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cube {
    mips: Vec<Mip>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Mip {
    #[serde(deserialize_with = "integer")]
    size: u32,
    data_base64: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Lut {
    #[serde(deserialize_with = "integer")]
    width: u32,
    #[serde(deserialize_with = "integer")]
    height: u32,
    data_base64: String,
}
fn integer<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let n = f64::deserialize(d)?;
    if n.is_finite() && n >= 0.0 && n <= u32::MAX as f64 && n.fract() == 0.0 {
        Ok(n as u32)
    } else {
        Err(serde::de::Error::custom("IBL requires uint32 integer"))
    }
}
pub(super) fn decode(
    value: &Value,
    descriptor: &RuntimeResourceIndexEntry,
) -> Result<PreparedIblEnvironment, String> {
    let w: Wire =
        serde_json::from_value(value.clone()).map_err(|e| format!("prefiltered-ibl/wire: {e}"))?;
    if w.schema != "deep-engine.ibl-prefiltered"
        || w.schema_version != 1
        || w.kind != "prefiltered-hdri"
        || w.format != "rgba16float"
        || w.encoding != "base64-le"
        || w.face_order != "px-nx-py-ny-pz-nz"
        || w.id != descriptor.id
        || w.revision == 0
        || u64::from(w.revision) != descriptor.revision
    {
        return Err("prefiltered-ibl/identity".into());
    }
    let hash = &w.source.content_hash;
    if hash.algorithm != "sha256"
        || hash.value.len() != 64
        || !hash
            .value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !(1..=256).contains(&w.source.license.encode_utf16().count())
    {
        return Err("prefiltered-ibl/source".into());
    }
    let mut total = 0usize;
    check_cube(&w.specular, true, &mut total)?;
    check_cube(&w.diffuse, false, &mut total)?;
    if w.brdf_lut.width != w.brdf_lut.height {
        return Err("prefiltered-ibl/brdf-square".into());
    }
    check_data(w.brdf_lut.width, 1, &w.brdf_lut.data_base64, &mut total)?;
    for m in w.specular.mips.iter().chain(&w.diffuse.mips) {
        check_length(m.size, 6, &m.data_base64)?;
    }
    check_length(w.brdf_lut.width, 1, &w.brdf_lut.data_base64)?;
    // All shapes, encoded lengths and the total budget pass before decoding any plane.
    let specular = decode_cube(w.specular)?;
    let diffuse = decode_cube(w.diffuse)?;
    let brdf_lut = PreparedIblTexture2d {
        width: w.brdf_lut.width,
        height: w.brdf_lut.height,
        texels: texels(&w.brdf_lut.data_base64)?,
    };
    PreparedIblEnvironment::imported_hdri(
        w.id,
        w.revision,
        descriptor.content_hash.value.clone(),
        specular,
        diffuse,
        brdf_lut,
    )
}
fn check_cube(c: &Cube, specular: bool, total: &mut usize) -> Result<(), String> {
    let first = c.mips.first().ok_or("prefiltered-ibl/empty-cube")?;
    if !specular && c.mips.len() != 1 {
        return Err("prefiltered-ibl/diffuse-mips".into());
    }
    if specular && (c.mips.len() != first.size.checked_ilog2().unwrap_or(0) as usize + 1) {
        return Err("prefiltered-ibl/specular-mips".into());
    }
    for (i, m) in c.mips.iter().enumerate() {
        if m.size != first.size.checked_shr(i as u32).unwrap_or(0) {
            return Err("prefiltered-ibl/mip-order".into());
        }
        check_data(m.size, 6, &m.data_base64, total)?;
    }
    Ok(())
}
fn check_data(size: u32, faces: usize, _data: &str, total: &mut usize) -> Result<(), String> {
    if size == 0 || size > 2048 || !size.is_power_of_two() {
        return Err("prefiltered-ibl/dimension".into());
    }
    let bytes = (size as usize) * (size as usize) * faces * 8;
    *total = total
        .checked_add(bytes)
        .ok_or("prefiltered-ibl/byte-budget")?;
    if *total > 64 * 1024 * 1024 {
        return Err("prefiltered-ibl/byte-budget".into());
    }
    Ok(())
}
fn check_length(size: u32, faces: usize, data: &str) -> Result<(), String> {
    if base64::decoded_len(data)? != size as usize * size as usize * faces * 8 {
        return Err("prefiltered-ibl/byte-length".into());
    }
    Ok(())
}
fn decode_cube(c: Cube) -> Result<PreparedIblCube, String> {
    Ok(PreparedIblCube {
        mips: c
            .mips
            .into_iter()
            .map(|m| {
                Ok(PreparedIblCubeMip {
                    size: m.size,
                    texels: texels(&m.data_base64)?,
                })
            })
            .collect::<Result<_, String>>()?,
    })
}
fn texels(data: &str) -> Result<Vec<[f32; 4]>, String> {
    let bytes = base64::decode(data)?;
    bytes
        .chunks_exact(8)
        .map(|p| {
            let mut out = [0.; 4];
            for (i, b) in p.chunks_exact(2).enumerate() {
                let h = u16::from_le_bytes([b[0], b[1]]);
                let value = crate::half_decode::half_to_f32(h);
                if !value.is_finite() || value < 0.0 {
                    return Err("prefiltered-ibl/invalid-half".into());
                }
                out[i] = value;
            }
            Ok(out)
        })
        .collect()
}
