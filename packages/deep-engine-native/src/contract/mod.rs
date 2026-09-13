mod lod;
mod types;
mod uv_sets;
mod validate;
mod validate_geometry;
mod validate_texture;

use std::{fs, path::Path};

pub use lod::DEFAULT_LOD_HYSTERESIS_RATIO;
pub use types::{
    AlphaMode, GeometryResource, NormalTextureSlot, OcclusionTextureSlot, PbrMaterial, PixelLevel,
    RenderInstance, RenderLodLevel, RenderLodProfile, RenderPacket, TextureResource,
    TextureSampler, TextureSemantic, TextureSlot,
};
pub use validate::{ContractSummary, validate_packet};

pub const CONTRACT_SCHEMA: &str = "deep-engine.render-packet";
pub const CONTRACT_VERSION: u32 = 1;

pub fn load_and_validate(path: &Path) -> Result<(RenderPacket, ContractSummary), String> {
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    if bytes.len() > 160 * 1024 * 1024 {
        return Err("contract file exceeds the 160 MiB input limit".into());
    }
    let packet: RenderPacket = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid RenderPacket JSON: {error}"))?;
    let summary = validate_packet(&packet)?;
    Ok((packet, summary))
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
