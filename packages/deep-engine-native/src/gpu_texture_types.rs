use deep_engine_native::contract::TextureSemantic;
use deep_engine_native::pbr_texture::{PreparedAddressMode, PreparedFilter, TextureEncoding};

pub const FALLBACK_TEXTURE_SPECS: [(TextureSemantic, TextureEncoding, [u8; 4]); 5] = [
    (
        TextureSemantic::BaseColor,
        TextureEncoding::Srgb,
        [255, 255, 255, 255],
    ),
    (
        TextureSemantic::MetallicRoughness,
        TextureEncoding::Linear,
        [255, 255, 255, 255],
    ),
    (
        TextureSemantic::Normal,
        TextureEncoding::Linear,
        [128, 128, 255, 255],
    ),
    (
        TextureSemantic::Occlusion,
        TextureEncoding::Linear,
        [255, 255, 255, 255],
    ),
    (
        TextureSemantic::Emissive,
        TextureEncoding::Srgb,
        [255, 255, 255, 255],
    ),
];

pub fn texture_format(encoding: TextureEncoding) -> wgpu::TextureFormat {
    match encoding {
        TextureEncoding::Linear => wgpu::TextureFormat::Rgba8Unorm,
        TextureEncoding::Srgb => wgpu::TextureFormat::Rgba8UnormSrgb,
    }
}

pub fn address_mode(mode: PreparedAddressMode) -> wgpu::AddressMode {
    match mode {
        PreparedAddressMode::ClampToEdge => wgpu::AddressMode::ClampToEdge,
        PreparedAddressMode::Repeat => wgpu::AddressMode::Repeat,
        PreparedAddressMode::MirrorRepeat => wgpu::AddressMode::MirrorRepeat,
    }
}

pub fn filter_mode(filter: PreparedFilter) -> wgpu::FilterMode {
    match filter {
        PreparedFilter::Nearest => wgpu::FilterMode::Nearest,
        PreparedFilter::Linear => wgpu::FilterMode::Linear,
    }
}

pub fn mip_filter_mode(filter: PreparedFilter) -> wgpu::MipmapFilterMode {
    match filter {
        PreparedFilter::Nearest => wgpu::MipmapFilterMode::Nearest,
        PreparedFilter::Linear => wgpu::MipmapFilterMode::Linear,
    }
}
