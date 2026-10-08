use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::mesh_abi::{MATERIAL_UNIFORM_BYTES, MaterialUniformRow};
use deep_engine_native::pbr_layered::LAYERED_SURFACE_BLOCK_BYTES;
use deep_engine_native::pbr_texture::{
    PreparedLayeredMaterial, PreparedMaterial, PreparedPbrResources, PreparedPbrSummary,
};
use wgpu::util::DeviceExt;

use crate::gpu_texture_upload::{GpuTexture, create_fallbacks, upload_texture};

pub struct GpuMaterial {
    _uniform: wgpu::Buffer,
    texture_slots: [Option<Arc<GpuTexture>>; 7],
    pub bind_group: wgpu::BindGroup,
    pub normal_mapped: bool,
    pub base_color_mapped: bool,
    pub textured: bool,
    pub transmission: bool,
    pub extended: bool,
    /// I-C23 分层绑定:304B uniform + 4 个借用纹理槽([base0, mr0, base1, mr1])。
    /// 只有调用方提供分层 layout 且材质声明层行时才驻留。
    pub layered: Option<LayeredGpuMaterial>,
}

pub struct LayeredGpuMaterial {
    _uniform: wgpu::Buffer,
    texture_slots: [Option<Arc<GpuTexture>>; 4],
    pub bind_group: wgpu::BindGroup,
}

/// I-C23 分层材质 layout:与 v1 完全同构的 0..10 槽 + binding 11 的 304B
/// uniform + bindings 12..19 的四对层纹理/采样器(与 Web 分层能力同语义,
/// 片段采样纹理预算合同常量为 19,native 实际占 13)。
pub fn create_layered_material_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
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
        label: Some("Deep Engine native layered PBR material layout v1"),
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
            wgpu::BindGroupLayoutEntry {
                binding: 11,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(LAYERED_SURFACE_BLOCK_BYTES as u64),
                },
                count: None,
            },
            texture(12),
            sampler(13),
            texture(14),
            sampler(15),
            texture(16),
            sampler(17),
            texture(18),
            sampler(19),
            texture(20),sampler(21),texture(22),sampler(23),
        ],
    })
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
            texture(20),sampler(21),texture(22),sampler(23),
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
    /// caller must have classified the change as UniformOnly first (C3 stage guard), and the
    /// `rows` payloads must be the `prepare_material_uniform` outputs of the incoming packet
    /// (generated at stage time; publish only writes buffers). Index-range checked per row;
    /// the material count contract is enforced by the stage-side classification.
    pub(crate) fn write_material_uniforms(
        &mut self,
        queue: &wgpu::Queue,
        rows: &[(usize, MaterialUniformRow)],
    ) -> Result<(), String> {
        for (index, uniform) in rows {
            let material = self
                .materials
                .get(*index)
                .ok_or("material uniform update row out of range")?;
            queue.write_buffer(
                &material._uniform,
                0,
                cast_slice(std::slice::from_ref(uniform)),
            );
        }
        Ok(())
    }

    #[allow(dead_code)] // Direct builder remains the independent GPU-test entrypoint.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layout: &wgpu::BindGroupLayout,
        layered_layout: Option<&wgpu::BindGroupLayout>,
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
        let mips = crate::gpu_texture_upload::TextureMipGenerator::default();
        let textures: Vec<Arc<GpuTexture>> = prepared
            .textures
            .iter()
            .map(|texture| upload_texture(device, queue, texture, &mips).map(Arc::new))
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
                GpuMaterial::new(
                    device,
                    layout,
                    layered_layout,
                    material,
                    &textures,
                    &fallbacks,
                )
                .map(Arc::new)
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
        layered_layout: Option<&wgpu::BindGroupLayout>,
        material: &PreparedMaterial,
        textures: &[Arc<GpuTexture>],
        fallbacks: &[GpuTexture],
    ) -> Result<Self, String> {
        let texture_slots: [Option<Arc<GpuTexture>>; 7] = std::array::from_fn(|slot| {
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
            // COPY_DST:Queue::write_buffer 原位写入的必需 usage(接生产快
            // 路径时暴露——旧 UNIFORM-only 缓冲根本不可由 write_buffer 更新);
            // COPY_SRC:C3 GPU 读回验证需要拷贝到 MAP_READ staging(wgpu
            // 禁止直接 map uniform)。
            usage: wgpu::BufferUsages::UNIFORM
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
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
            view_entry(20,slots[5]),sampler_entry(21,slots[5]),
            view_entry(22,slots[6]),sampler_entry(23,slots[6]),
        ];
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native PBR material bindings v1"),
            layout,
            entries: &entries,
        });
        let layered = match (layered_layout, &material.layered) {
            (Some(layered_layout), Some(prepared)) => Some(LayeredGpuMaterial::new(
                device,
                layered_layout,
                &uniform,
                &texture_slots,
                prepared,
                textures,
                fallbacks,
            )?),
            // 无分层 layout 或材质未声明层行:普通绑定即可(层词不进基础块)。
            // 提供 layout 但材质声明了层行却落 None 只发生在 custom ShaderPackage
            // 路径(那里由调用方 fail-closed 拒绝),此处不静默吞层。
            _ => None,
        };
        Ok(Self {
            _uniform: uniform,
            texture_slots,
            bind_group,
            normal_mapped: material.normal_mapped,
            base_color_mapped: material.texture_indices[0].is_some(),
            textured: material.texture_indices.iter().any(Option::is_some),
            transmission: material.uniform[45] > 0.0,
            extended: material.uses_extended_response(),
            layered,
        })
    }
}

impl LayeredGpuMaterial {
    /// 分层 bind group = 完整 0..19 槽(pipeline 只有一个材质 bind group):
    /// 0..10 复用基础 uniform 与基础纹理槽,11 为独立 304B 块,12..19 为
    /// 层纹理([base0, mr0, base1, mr1]),缺槽借中性 fallback(仅未纹理层需要)。
    fn new(
        device: &wgpu::Device,
        layout: &wgpu::BindGroupLayout,
        base_uniform: &wgpu::Buffer,
        base_slots: &[Option<Arc<GpuTexture>>; 7],
        prepared: &PreparedLayeredMaterial,
        textures: &[Arc<GpuTexture>],
        fallbacks: &[GpuTexture],
    ) -> Result<Self, String> {
        let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native layered material 304B uniform v1"),
            contents: cast_slice(&prepared.block),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let texture_slots: [Option<Arc<GpuTexture>>; 4] = std::array::from_fn(|slot| {
            prepared.texture_indices[slot].map(|index| Arc::clone(&textures[index]))
        });
        let base_backing = |slot: usize| {
            base_slots[slot]
                .as_deref()
                .unwrap_or(&fallbacks[slot % fallbacks.len()])
        };
        let mut entries = vec![
            view_entry(0, base_backing(0)),
            sampler_entry(1, base_backing(0)),
            view_entry(2, base_backing(1)),
            sampler_entry(3, base_backing(1)),
            wgpu::BindGroupEntry {
                binding: 4,
                resource: base_uniform.as_entire_binding(),
            },
            view_entry(5, base_backing(3)),
            sampler_entry(6, base_backing(3)),
            view_entry(7, base_backing(2)),
            sampler_entry(8, base_backing(2)),
            view_entry(9, base_backing(4)),
            sampler_entry(10, base_backing(4)),
            wgpu::BindGroupEntry {
                binding: 11,
                resource: uniform.as_entire_binding(),
            },
        ];
        for (slot, texture) in texture_slots.iter().enumerate() {
            let backing = texture.as_deref().unwrap_or(&fallbacks[slot % fallbacks.len()]);
            entries.push(view_entry(12 + slot as u32 * 2, backing));
            entries.push(sampler_entry(13 + slot as u32 * 2, backing));
        }
        entries.extend([view_entry(20,base_backing(5)),sampler_entry(21,base_backing(5)),
            view_entry(22,base_backing(6)),sampler_entry(23,base_backing(6))]);
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native layered PBR material bindings v1"),
            layout,
            entries: &entries,
        });
        Ok(Self {
            _uniform: uniform,
            texture_slots,
            bind_group,
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

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::mesh_abi::MaterialUniformRow;
    use deep_engine_native::pbr_texture::PreparedPbrResources;

    fn prepared(id: &str, value: f32) -> PreparedMaterial {
        PreparedMaterial {
            id: id.into(),
            normal_mapped: false,
            texture_indices: [None; 7],
            uniform: [value; deep_engine_native::mesh_abi::MATERIAL_UNIFORM_ROW_FLOATS],
            layered: None,
        }
    }

    /// C3 write_material_uniforms 的真实 GPU 端到端验证:写入后从设备内存
    /// 读回,逐字节断言 payload 落在点名槽位、未点名槽保持初始 uniform。
    /// (uniform 缓冲禁止直接 map,经 COPY_SRC staging 中转读回。)
    #[test]
    #[ignore = "requires a real GPU adapter"]
    fn written_material_uniforms_read_back_from_device_memory() {
        pollster::block_on(async {
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            descriptor.backends = wgpu::Backends::VULKAN;
            let instance = wgpu::Instance::new(descriptor);
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions::default())
                .await
                .expect("real GPU adapter");
            let (device, queue) = adapter
                .request_device(&wgpu::DeviceDescriptor::default())
                .await
                .unwrap();
            let layout = create_material_layout(&device);
            let prepared = PreparedPbrResources {
                textures: Vec::new(),
                materials: vec![prepared("a", 0.25), prepared("b", 0.5)],
            };
            let initial_b = prepared.materials[1].uniform;
            let mut pbr = GpuPbrResources::new(&device, &queue, &layout, None, &prepared).unwrap();

            let mut updated_b = initial_b;
            updated_b[7] = 42.0;
            // 空行集必须是无害 no-op。
            pbr.write_material_uniforms(&queue, &[]).unwrap();
            pbr.write_material_uniforms(&queue, &[(1, updated_b)])
                .unwrap();
            // 越界行必须在写入前被守卫拒绝。
            assert!(
                pbr.write_material_uniforms(&queue, &[(9, updated_b)])
                    .is_err()
            );

            let size = MATERIAL_UNIFORM_BYTES;
            let staging = |label| {
                device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(label),
                    size,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            };
            let stage0 = staging("readback-material-uniform-0");
            let stage1 = staging("readback-material-uniform-1");
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("material uniform readback"),
            });
            encoder.copy_buffer_to_buffer(&pbr.materials[0]._uniform, 0, &stage0, 0, size);
            encoder.copy_buffer_to_buffer(&pbr.materials[1]._uniform, 0, &stage1, 0, size);
            queue.submit([encoder.finish()]);
            let readback = |buffer: &wgpu::Buffer| -> Vec<u8> {
                buffer.map_async(wgpu::MapMode::Read, .., |result| {
                    result.expect("material uniform readback map")
                });
                device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
                let mapped = buffer.get_mapped_range(..).unwrap();
                let bytes = mapped.to_vec();
                drop(mapped);
                buffer.unmap();
                bytes
            };
            let bytes0 = readback(&stage0);
            let bytes1 = readback(&stage1);
            let expected0: Vec<u8> = cast_slice(&prepared.materials[0].uniform[..]).to_vec();
            let expected1: Vec<u8> = cast_slice(&updated_b[..]).to_vec();
            assert_eq!(bytes0, expected0);
            assert_eq!(bytes1, expected1);
        });
    }
}
