use deep_engine_native::ibl::{
    IblSummary, PreparedIblCube, PreparedIblEnvironment, PreparedIblTexture2d,
    validate_ibl_environment,
};

use crate::{half_float::f32_to_f16, shadow_map::ShadowMap};

const IBL_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;

pub struct GpuIblEnvironment {
    _specular: wgpu::Texture,
    _diffuse: wgpu::Texture,
    _brdf_lut: wgpu::Texture,
    specular_view: wgpu::TextureView,
    diffuse_view: wgpu::TextureView,
    brdf_lut_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    pub id: String,
    pub revision: u32,
    pub summary: IblSummary,
}

impl GpuIblEnvironment {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &PreparedIblEnvironment,
    ) -> Result<Self, String> {
        let summary = validate_ibl_environment(source)?;
        let limit = device.limits().max_texture_dimension_2d;
        let largest = source
            .specular
            .mips
            .first()
            .map_or(0, |mip| mip.size)
            .max(source.diffuse.mips.first().map_or(0, |mip| mip.size))
            .max(source.brdf_lut.width)
            .max(source.brdf_lut.height);
        if largest > limit {
            return Err(format!(
                "native IBL dimension {largest} exceeds device limit {limit}"
            ));
        }
        if device.limits().max_texture_array_layers < 6 {
            return Err("native GPU cannot create the six layers required by a cube map".into());
        }

        let specular = upload_cube(
            device,
            queue,
            "Deep Engine native specular IBL",
            &source.specular,
        );
        let diffuse = upload_cube(
            device,
            queue,
            "Deep Engine native diffuse IBL",
            &source.diffuse,
        );
        let brdf_lut = upload_2d(
            device,
            queue,
            "Deep Engine native BRDF LUT",
            &source.brdf_lut,
        );
        let specular_view = cube_view(&specular, "Deep Engine native specular IBL view");
        let diffuse_view = cube_view(&diffuse, "Deep Engine native diffuse IBL view");
        let brdf_lut_view = brdf_lut.create_view(&wgpu::TextureViewDescriptor {
            label: Some("Deep Engine native BRDF LUT view"),
            ..Default::default()
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Deep Engine native IBL filtering sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            lod_min_clamp: 0.0,
            lod_max_clamp: source.specular.mips.len().saturating_sub(1) as f32,
            compare: None,
            anisotropy_clamp: 1,
            border_color: None,
        });
        Ok(Self {
            _specular: specular,
            _diffuse: diffuse,
            _brdf_lut: brdf_lut,
            specular_view,
            diffuse_view,
            brdf_lut_view,
            sampler,
            id: source.id.clone(),
            revision: source.revision,
            summary,
        })
    }

    pub fn create_frame_bind_group(
        &self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        frame: &wgpu::Buffer,
        shadow: &ShadowMap,
        label: &'static str,
    ) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some(label),
            layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame.as_entire_binding(),
                },
                texture_entry(1, &shadow.view),
                sampler_entry(2, &shadow.sampler),
                texture_entry(3, &self.specular_view),
                texture_entry(4, &self.diffuse_view),
                texture_entry(5, &self.brdf_lut_view),
                sampler_entry(6, &self.sampler),
                wgpu::BindGroupEntry {
                    binding: 7,
                    resource: shadow.sampling_uniform.as_entire_binding(),
                },
            ],
        })
    }

    pub fn specular_view(&self) -> &wgpu::TextureView {
        &self.specular_view
    }

    pub fn diffuse_view(&self) -> &wgpu::TextureView {
        &self.diffuse_view
    }

    pub fn brdf_lut_view(&self) -> &wgpu::TextureView {
        &self.brdf_lut_view
    }

    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }
}

fn upload_cube(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &'static str,
    source: &PreparedIblCube,
) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: source.mips[0].size,
            height: source.mips[0].size,
            depth_or_array_layers: 6,
        },
        mip_level_count: source.mips.len() as u32,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: IBL_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for (level, mip) in source.mips.iter().enumerate() {
        write_rgba16f(
            queue,
            &texture,
            level as u32,
            mip.size,
            mip.size,
            6,
            &mip.texels,
        );
    }
    texture
}

fn upload_2d(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &'static str,
    source: &PreparedIblTexture2d,
) -> wgpu::Texture {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: source.width,
            height: source.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: IBL_FORMAT,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    write_rgba16f(
        queue,
        &texture,
        0,
        source.width,
        source.height,
        1,
        &source.texels,
    );
    texture
}

fn write_rgba16f(
    queue: &wgpu::Queue,
    texture: &wgpu::Texture,
    mip_level: u32,
    width: u32,
    height: u32,
    layers: u32,
    texels: &[[f32; 4]],
) {
    let mut bytes = Vec::with_capacity(texels.len() * 8);
    for texel in texels {
        for channel in texel {
            bytes.extend_from_slice(&f32_to_f16(*channel).to_le_bytes());
        }
    }
    queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &bytes,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(width * 8),
            rows_per_image: Some(height),
        },
        wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: layers,
        },
    );
}

fn cube_view(texture: &wgpu::Texture, label: &'static str) -> wgpu::TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor {
        label: Some(label),
        dimension: Some(wgpu::TextureViewDimension::Cube),
        array_layer_count: Some(6),
        ..Default::default()
    })
}

fn texture_entry(binding: u32, view: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(view),
    }
}

fn sampler_entry(binding: u32, sampler: &wgpu::Sampler) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::Sampler(sampler),
    }
}
