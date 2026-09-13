use crate::gpu_texture_types::{
    FALLBACK_TEXTURE_SPECS, address_mode, filter_mode, mip_filter_mode, texture_format,
};
use deep_engine_native::pbr_texture::{
    PreparedAddressMode, PreparedFilter, PreparedSampler, PreparedTexture,
};

pub struct GpuTexture {
    _texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub sampler: wgpu::Sampler,
}

pub fn upload_texture(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    source: &PreparedTexture,
) -> Result<GpuTexture, String> {
    let level = source
        .levels
        .first()
        .ok_or_else(|| format!("prepared texture {} has no level 0", source.id))?;
    let format = texture_format(source.encoding);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(&source.id),
        size: wgpu::Extent3d {
            width: level.width,
            height: level.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: source.levels.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (mip_level, level) in source.levels.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: mip_level as u32,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &level.data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(level.width * 4),
                rows_per_image: Some(level.height),
            },
            wgpu::Extent3d {
                width: level.width,
                height: level.height,
                depth_or_array_layers: 1,
            },
        );
    }
    let view = texture.create_view(&Default::default());
    let sampler = create_sampler(device, &source.sampler, source.levels.len());
    Ok(GpuTexture {
        _texture: texture,
        view,
        sampler,
    })
}

pub fn create_fallbacks(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
) -> Result<Vec<GpuTexture>, String> {
    FALLBACK_TEXTURE_SPECS
        .into_iter()
        .enumerate()
        .map(|(index, (semantic, encoding, data))| {
            upload_texture(
                device,
                queue,
                &PreparedTexture {
                    id: format!("native-fallback-{index}"),
                    revision: 0,
                    semantic,
                    encoding,
                    sampler: PreparedSampler {
                        address_u: PreparedAddressMode::Repeat,
                        address_v: PreparedAddressMode::Repeat,
                        mag: PreparedFilter::Linear,
                        min: PreparedFilter::Linear,
                        mipmap: PreparedFilter::Linear,
                        anisotropy: 1,
                    },
                    levels: vec![deep_engine_native::pbr_texture::PreparedTextureLevel {
                        width: 1,
                        height: 1,
                        data: data.to_vec(),
                    }],
                },
            )
        })
        .collect()
}

fn create_sampler(
    device: &wgpu::Device,
    sampler: &PreparedSampler,
    mip_levels: usize,
) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("Deep Engine native texture sampler v1"),
        address_mode_u: address_mode(sampler.address_u),
        address_mode_v: address_mode(sampler.address_v),
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: filter_mode(sampler.mag),
        min_filter: filter_mode(sampler.min),
        mipmap_filter: mip_filter_mode(sampler.mipmap),
        lod_min_clamp: 0.0,
        lod_max_clamp: (mip_levels - 1) as f32,
        compare: None,
        anisotropy_clamp: sampler.anisotropy,
        border_color: None,
    })
}
