use std::sync::Arc;

use bytemuck::cast_slice;
use deep_engine_native::{
    contract::{AlphaMode, GeometryResource, RenderPacket},
    mesh_abi::{GEOMETRY_VERTEX_FLOATS, TANGENT_VERTEX_FLOATS, pack_color_vertices},
    pbr_texture::{PreparedPbrResources, PreparedPbrSummary},
    scene::{DrawBatch, PACKED_INSTANCE_FLOATS, PreparedScene, SceneAlphaSummary, alpha_summary},
};
use wgpu::util::DeviceExt;

use crate::{
    gpu_shader_materials::{GpuShaderMaterials, ShaderSceneResources},
    gpu_textures::GpuPbrResources,
    player_content::PlayerContent,
};

pub struct GpuGeometry {
    pub vertex_buffer: wgpu::Buffer,
    pub tangent_buffer: Option<wgpu::Buffer>,
    /// 可选线性 RGBA 顶点色；无颜色几何为 `None`，旧上传序列逐字节不变。
    /// 渲染管线的绑定与 shader 采样由颜色变体切片接入（Web 侧已按 slot4 绑定）。
    #[allow(dead_code)]
    pub color_buffer: Option<wgpu::Buffer>,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
}

pub(crate) struct GpuInstanceResource {
    pub buffer: wgpu::Buffer,
    pub packed: Vec<deep_engine_native::scene::PackedInstance>,
}

pub struct GpuScene {
    pub geometries: Vec<Arc<GpuGeometry>>,
    pub instance_buffer: wgpu::Buffer,
    pub batches: Vec<DrawBatch>,
    pub pbr: GpuPbrResources,
    pub shader_materials: Option<GpuShaderMaterials>,
    pub shader_revision: u64,
    shader_scene_key: u64,
    device: wgpu::Device,
    _instance_resource: Arc<GpuInstanceResource>,
    /// CPU 侧打包行镜像:C3 transform-only 快路径的原位改写目标。
    packed_instances: Vec<deep_engine_native::scene::PackedInstance>,
}

impl GpuScene {
    #[allow(dead_code)] // Direct builder remains the independent GPU-test entrypoint.
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        material_layout: &wgpu::BindGroupLayout,
        packet: &RenderPacket,
        scene_content_key: u64,
        prepared: &PreparedScene,
        pbr: &PreparedPbrResources,
    ) -> Result<Self, String> {
        if packet.geometries.len() != prepared.geometry_keys.len() {
            return Err("prepared geometry map does not match RenderPacket".into());
        }
        let mut geometries = Vec::with_capacity(packet.geometries.len());
        for (geometry, key) in packet.geometries.iter().zip(&prepared.geometry_keys) {
            if geometry.id != key.id || geometry.revision != key.revision {
                return Err(format!(
                    "prepared geometry key no longer matches {} revision {}",
                    geometry.id, geometry.revision
                ));
            }
            geometries.push(Arc::new(GpuGeometry::new(device, geometry)));
        }
        let instances = Arc::new(GpuInstanceResource::new(device, &prepared.instances));
        let pbr = GpuPbrResources::new(device, queue, material_layout, pbr)?;
        Ok(Self::from_resources(
            geometries,
            instances,
            prepared.batches.clone(),
            pbr,
            scene_content_key,
            device,
        ))
    }

    pub(crate) fn from_resources(
        geometries: Vec<Arc<GpuGeometry>>,
        instances: Arc<GpuInstanceResource>,
        batches: Vec<DrawBatch>,
        pbr: GpuPbrResources,
        scene_content_key: u64,
        device: &wgpu::Device,
    ) -> Self {
        Self {
            geometries,
            instance_buffer: instances.buffer.clone(),
            batches,
            pbr,
            shader_materials: None,
            shader_revision: 0,
            shader_scene_key: scene_content_key,
            device: device.clone(),
            packed_instances: instances.packed.clone(),
            _instance_resource: instances,
        }
    }

    /// C3 transform-only 快路径:内容键推进(shader 替换守卫依赖它判断"场景未变")。
    pub(crate) fn set_scene_content_key(&mut self, scene_content_key: u64) {
        self.shader_scene_key = scene_content_key;
    }

    /// C3 transform-only 快路径:对受影响行重算词 0..24(模型列主序 + 逆转置法线)
    /// 与镜像符号词 30,材质词(24..36 除 30)保持不变;随后按升序连续段合并
    /// partial-write 整行(144B)进 GPU 实例缓冲。奇异性合同与 prepare_scene 一致。
    pub(crate) fn write_instance_transforms(
        &mut self,
        queue: &wgpu::Queue,
        rows: &[(usize, [f32; 16])],
    ) -> Result<(), String> {
        let packed = &mut self.packed_instances;
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for (index, model) in rows {
            let row = packed
                .get_mut(*index)
                .ok_or("instance transform row out of range")?;
            let (words, mirrored_sign) =
                deep_engine_native::scene::recompute_transform_update(model, *index)?;
            row[..24].copy_from_slice(&words);
            row[30] = mirrored_sign;
            match runs.last_mut() {
                Some((_, end)) if *end == *index => *end = *index + 1,
                _ => runs.push((*index, *index + 1)),
            }
        }
        for (start, end) in &runs {
            let bytes = cast_slice(&packed[*start..*end]);
            queue.write_buffer(
                &self.instance_buffer,
                (*start as wgpu::BufferAddress) * deep_engine_native::scene::PACKED_INSTANCE_BYTES,
                bytes,
            );
        }
        Ok(())
    }

    /// C3 receive-shadow-only 快路径:对受影响行重算词 31(surface flags),
    /// 其余词保持不变;按升序连续段合并 partial-write 整行(144B)进 GPU
    /// 实例缓冲。词 31 数值由 `deep_engine_native::scene::recompute_surface_flags`
    /// 生成(与 pack_instance 逐位一致,测试钉死);批布局/实例顺序不变。
    pub(crate) fn write_instance_shadow_flags(
        &mut self,
        queue: &wgpu::Queue,
        rows: &[(usize, f32)],
    ) -> Result<(), String> {
        let packed = &mut self.packed_instances;
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for (index, flags) in rows {
            let row = packed
                .get_mut(*index)
                .ok_or("instance shadow-flag row out of range")?;
            row[31] = *flags;
            match runs.last_mut() {
                Some((_, end)) if *end == *index => *end = *index + 1,
                _ => runs.push((*index, *index + 1)),
            }
        }
        for (start, end) in &runs {
            let bytes = cast_slice(&packed[*start..*end]);
            queue.write_buffer(
                &self.instance_buffer,
                (*start as wgpu::BufferAddress) * deep_engine_native::scene::PACKED_INSTANCE_BYTES,
                bytes,
            );
        }
        Ok(())
    }

    pub fn replace_shader_materials(
        &mut self,
        device: &wgpu::Device,
        content: &PlayerContent,
        frame: &wgpu::Buffer,
        shadows: &crate::shadow_map::ShadowMap,
        ibl: &crate::gpu_ibl::GpuIblEnvironment,
    ) -> Result<bool, String> {
        if device != &self.device {
            return Err("native shader-only replacement belongs to another GPU device; rebuild the entire scene transaction".into());
        }
        if content.scene_content_key() != self.shader_scene_key {
            return Err("native shader-only replacement changed the scene, material or texture data; rebuild the entire scene transaction".into());
        }
        let signature = GpuShaderMaterials::content_key(content)?;
        let old = self
            .shader_materials
            .as_ref()
            .map(|value| value.signature.as_str());
        if old == signature.as_deref() {
            return Ok(false);
        }
        let features: Vec<_> = self
            .pbr
            .materials
            .iter()
            .map(
                |material| crate::player_shader_plan::ShaderMaterialFeatures {
                    normal_mapped: material.normal_mapped,
                    textured: material.textured,
                    base_color_mapped: material.base_color_mapped,
                },
            )
            .collect();
        let candidate = GpuShaderMaterials::new(
            device,
            content,
            ShaderSceneResources {
                pbr: &self.pbr,
                batches: &self.batches,
                features: &features,
                frame,
                shadows,
                ibl,
            },
            signature.unwrap_or_default(),
        )?;
        self.shader_materials = candidate;
        self.shader_revision = self.shader_revision.wrapping_add(1);
        Ok(true)
    }

    pub fn pbr_summary(&self) -> PreparedPbrSummary {
        self.pbr.summary
    }

    pub fn resident_texture_count(&self) -> usize {
        self.pbr.resident_texture_count()
    }

    pub fn alpha_summary(&self) -> SceneAlphaSummary {
        alpha_summary(&self.batches)
    }

    pub fn has_transparent(&self) -> bool {
        self.batches
            .iter()
            .any(|batch| batch.alpha_mode == AlphaMode::Blend)
    }

    pub fn matches_content(&self, scene_key: u64, shader_signature: Option<&str>) -> bool {
        let active_signature = self
            .shader_materials
            .as_ref()
            .map(|materials| materials.signature.as_str());
        self.shader_scene_key == scene_key && active_signature == shader_signature
    }
}

impl GpuGeometry {
    pub(crate) fn new(device: &wgpu::Device, geometry: &GeometryResource) -> Self {
        let vertex_count = geometry.vertices.len() / 6;
        let mut vertices = Vec::<[f32; GEOMETRY_VERTEX_FLOATS]>::with_capacity(vertex_count);
        let mut tangents = geometry
            .tangents
            .as_ref()
            .map(|_| Vec::<[f32; TANGENT_VERTEX_FLOATS]>::with_capacity(vertex_count));
        for index in 0..vertex_count {
            let source = &geometry.vertices[index * 6..index * 6 + 6];
            let uv0 = geometry
                .uv0
                .as_ref()
                .map(|values| &values[index * 2..index * 2 + 2])
                .unwrap_or(&[0.0, 0.0]);
            let uv1 = geometry
                .uv1
                .as_ref()
                .map(|values| &values[index * 2..index * 2 + 2])
                .unwrap_or(&[0.0, 0.0]);
            vertices.push([
                source[0], source[1], source[2], source[3], source[4], source[5], uv0[0], uv0[1],
                uv1[0], uv1[1],
            ]);
            if let (Some(target), Some(source)) = (&mut tangents, &geometry.tangents) {
                target.push([
                    source[index * 4],
                    source[index * 4 + 1],
                    source[index * 4 + 2],
                    source[index * 4 + 3],
                ]);
            }
        }
        let color_buffer =
            pack_color_vertices(geometry.colors.as_deref(), vertex_count).map(|colors| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Deep Engine native geometry colors"),
                    contents: cast_slice(&colors),
                    usage: wgpu::BufferUsages::VERTEX,
                })
            });
        Self {
            vertex_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native geometry vertices"),
                contents: cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            }),
            tangent_buffer: tangents.map(|tangents| {
                device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Deep Engine native geometry tangents"),
                    contents: cast_slice(&tangents),
                    usage: wgpu::BufferUsages::VERTEX,
                })
            }),
            color_buffer,
            index_buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native geometry indices"),
                contents: cast_slice(&geometry.indices),
                usage: wgpu::BufferUsages::INDEX,
            }),
            index_count: geometry.indices.len() as u32,
        }
    }
}

impl GpuInstanceResource {
    pub(crate) fn new(
        device: &wgpu::Device,
        packed: &[deep_engine_native::scene::PackedInstance],
    ) -> Self {
        let empty = [[0.0_f32; PACKED_INSTANCE_FLOATS]];
        let bytes = if packed.is_empty() {
            cast_slice(&empty)
        } else {
            cast_slice(packed)
        };
        Self {
            buffer: device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native packed instances"),
                contents: bytes,
                usage: wgpu::BufferUsages::VERTEX
                    | wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::COPY_DST,
            }),
            packed: packed.to_vec(),
        }
    }
}
