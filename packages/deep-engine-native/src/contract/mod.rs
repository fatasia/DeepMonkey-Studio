mod author_lod;
mod lod;
mod lod_json;
mod types;
mod uv_sets;
mod validate;
mod validate_geometry;
mod validate_texture;

#[cfg(test)]
#[path = "contract_color_stream_tests.rs"]
mod color_stream_tests;

use std::{fs::File, io::Read, path::Path};

pub use lod::DEFAULT_LOD_HYSTERESIS_RATIO;
pub use types::{
    AlphaMode, GeometryResource, NormalTextureSlot, OcclusionTextureSlot, PbrMaterial, PixelLevel,
    RenderInstance, RenderLodLevel, RenderLodProfile, RenderPacket, ShadingModel, TextureResource,
    TextureSampler, TextureSemantic, TextureSlot,
};
pub use validate::{ContractSummary, validate_packet};

pub const CONTRACT_SCHEMA: &str = "deep-engine.render-packet";
pub const CONTRACT_VERSION: u32 = 1;
const MAX_INPUT_BYTES: usize = 160 * 1024 * 1024;

pub fn load_and_validate(path: &Path) -> Result<(RenderPacket, ContractSummary), String> {
    let bytes = read_render_packet_bytes(path)?;
    let packet: RenderPacket = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid RenderPacket JSON: {error}"))?;
    let summary = validate_packet(&packet)?;
    Ok((packet, summary))
}

pub fn read_render_packet_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file =
        File::open(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if file
        .metadata()
        .is_ok_and(|metadata| metadata.len() > MAX_INPUT_BYTES as u64)
    {
        return Err("contract file exceeds the 160 MiB input limit".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.len() > MAX_INPUT_BYTES {
        Err("contract file exceeds the 160 MiB input limit".into())
    } else {
        Ok(bytes)
    }
}

pub fn default_fixture_path() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/render_packet_v1.json"
    ))
}

pub fn default_textured_fixture_path() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/render_packet_textured_v1.json"
    ))
}

pub fn default_alpha_fixture_path() -> &'static Path {
    Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/fixtures/render_packet_alpha_v1.json"
    ))
}
