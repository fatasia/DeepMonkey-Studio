use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::mesh_abi::MATERIAL_UNIFORM_BYTES;
use deep_engine_native::pbr_texture::{PreparedMaterial, PreparedPbrResources, PreparedPbrSummary, prepare_material_uniform};
use wgpu::util::DeviceExt;

use crate::gpu_texture_upload::{GpuTexture, create_fallbacks, upload_texture};

pub struct GpuMaterial {
    _uniform: wgpu::Buffer,
    texture_slots: [Option<Arc<GpuTexture>>; 5],
    pub bind_group: wgpu::BindGroup,
    pub normal_mapped: bool,
    pub base_color_mapped: bool,
    pub textured: bool,
}

pub struct GpuPbrResources {
    _textures: Vec<Arc<GpuTexture>>,
    _fallbacks: Arc<Vec<GpuTexture>>,
    pub materials: Vec<Arc<GpuMaterial>>,
    pub summary: PreparedPbrSummary,
}

pub fn create_material_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    let texture = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let sampler = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    };
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native PBR material layout v1"),
        entries: &[
            texture(0),
            sampler(1),
            texture(2),
            sampler(3),
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(MATERIAL_UNIFORM_BYTES),
                },
                count: None,
            },
            texture(5),
            sampler(6),
            texture(7),
            sampler(8),
            texture(9),
            sampler(10),
        ],
    })
}

impl GpuPbrResources {
    pub fn create_material_bind_group(
        &self,
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        index: usize,
    ) -> wgpu::BindGroup {
        let material = &self.materials[index];
        let slots: Vec<_> = material
            .texture_slots
            .iter()
            .enumerate()
            .map(|(slot, texture)| texture.as_deref().unwrap_or(&self._fallbacks[slot]))
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("native shader package material bindings"),
            layout,
            entries: &[
                view_entry(0, slots[0]),
                sampler_entry(1, slots[0]),
                view_entry(2, slots[1]),
                sampler_entry(3, slots[1]),
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: material._uniform.as_entire_binding(),
                },
                view_entry(5, slots[3]),
                sampler_entry(6, slots[3]),
                view_entry(7, slots[2]),
                sampler_entry(8, slots[2]),
                view_entry(9, slots[4]),
                sampler_entry(10, slots[4]),
            ],
        })
    }

    pub fn resident_texture_count(&self) -> usize {
        self._textures.len() + self._fallbacks.len()
    }

    /// Update only numeric material uniforms. Texture slots and bind groups stay unchanged;
    /// caller must have classified the change as UniformOnly first.
    pub(crate) fn write_material_uniforms(
        &mut self,
        queue: &wgpu::Queue,
        materials: &[deep_engine_native::contract::PbrMaterial],
        changed_indices: &[usize],
    ) -> Result<(), String> {
        if materials.len() != self.materials.len() {
            return Err("uniform-only material update changed material count".into());
        }
        for &index in changed_indices {
            let material = materials.get(index).ok_or("material update index out of range")?;
            let uniform = prepare_material_uniform(material)?;
            queue.write_buffer(&self.materials[index]._uniform, 0, cast_slice(&uniform));
        }
        Ok(())
    }


    #[allow(dead_code)] // Direct builder remains the independent GPU-test entrypoint.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layout: &wgpu::BindGroupLayout,
        prepared: &PreparedPbrResources,
    ) -> Result<Self, String> {
        let limit = device.limits().max_texture_dimension_2d;
        if prepared
            .textures
            .iter()
            .any(|texture| texture.levels[0].width > limit || texture.levels[0].height > limit)
        {
            return Err(format!(
                "native GPU texture exceeds device 2D dimension limit {limit}"
            ));
        }
        let textures: Vec<Arc<GpuTexture>> = prepared
            .textures
            .iter()
            .map(|texture| upload_texture(device, queue, texture).map(Arc::new))
            .collect::<Result<Vec<_>, _>>()?;
        let fallbacks = Arc::new(if prepared.materials.is_empty() {
            Vec::new()
        } else {
            create_fallbacks(device, queue)?
        });
        let materials = prepared
            .materials
            .iter()
            .map(|material| {
                GpuMaterial::new(device, layout, material, &textures, &fallbacks).map(Arc::new)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self::from_resources(
            textures,
            fallbacks,
            materials,
            prepared.summary(),
        ))
    }

    pub(crate) fn from_resources(
        textures: Vec<Arc<GpuTexture>>,
        fallbacks: Arc<Vec<GpuTexture>>,
        materials: Vec<Arc<GpuMaterial>>,
        summary: PreparedPbrSummary,
    ) -> Self {
        Self {
            _textures: textures,
            _fallbacks: fallbacks,
            materials,
            summary,
        }
    }
}

impl GpuMaterial {
    pub(crate) fn new(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        material: &PreparedMaterial,
        textures: &[Arc<GpuTexture>],
        fallbacks: &[GpuTexture],
    ) -> Result<Self, String> {
        let texture_slots: [Option<Arc<GpuTexture>>; 5] = std::array::from_fn(|slot| {
            material.texture_indices[slot].map(|index| Arc::clone(&textures[index]))
        });
        let slots: Vec<&GpuTexture> = texture_slots
            .iter()
            .enumerate()
            .map(|(slot, texture)| texture.as_deref().unwrap_or(&fallbacks[slot]))
            .collect();
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native PBR material uniform v1"),
            contents: cast_slice(&material.uniform),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let entries = [
            view_entry(0, slots[0]),
            sampler_entry(1, slots[0]),
            view_entry(2, slots[1]),
            sampler_entry(3, slots[1]),
            wgpu::BindGroupEntry {
                binding: 4,
                resource: uniform.as_entire_binding(),
            },
            view_entry(5, slots[3]),
            sampler_entry(6, slots[3]),
            view_entry(7, slots[2]),
            sampler_entry(8, slots[2]),
            view_entry(9, slots[4]),
            sampler_entry(10, slots[4]),
        ];
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native PBR material bindings v1"),
            layout,
            entries: &entries,
        });
        Ok(Self {
            _uniform: uniform,
            texture_slots,
            bind_group,
            normal_mapped: material.normal_mapped,
            base_color_mapped: material.texture_indices[0].is_some(),
            textured: material.texture_indices.iter().any(Option::is_some),
        })
    }
}

fn view_entry(binding: u32, texture: &GpuTexture) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(&texture.view),
    }
}

fn sampler_entry(binding: u32, texture: &GpuTexture) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::Sampler(&texture.sampler),
    }
}
