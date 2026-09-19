use bytemuck::cast_slice;
use deep_engine_native::{
    culling_contract::{
        FrustumPlanes, GPU_CULLING_FRUSTUM_BYTES, GPU_CULLING_INDIRECT_BYTES,
        GPU_CULLING_INSTANCE_BYTES, GPU_CULLING_WORKGROUP_SIZE, MAIN_SOLID_MASK,
        PreparedGpuCulling, SHADOW_CASTER_MASK, frustum_planes,
    },
    mesh_abi::FrameUniform,
};
use wgpu::util::DeviceExt;

use crate::{
    gpu_culling_readback::{CullingReadback, GpuCullingFrameMetrics},
    gpu_culling_resources::{create_bind_group, create_layout, storage_init, validate_device},
    gpu_occlusion::{GpuOcclusionStage, OcclusionSource},
    shadow_map::ShadowViewSource,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GpuCullingSummary {
    pub candidate_instances: u32,
    pub batches: u32,
    pub views: u32,
    pub dispatch_workgroups: u32,
    pub allocated_bytes: u64,
}

struct CullingView {
    frustum: wgpu::Buffer,
    visible_instances: wgpu::Buffer,
    indirect: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

pub struct GpuCulling {
    _bounds: wgpu::Buffer,
    _metadata: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    views: Vec<CullingView>,
    indirect_template: Vec<u8>,
    candidate_count: u32,
    revision: u64,
    submitted_revision: u64,
    summary: GpuCullingSummary,
    readback: Option<CullingReadback>,
    /// R4 首切片:主视锥 HiZ 遮挡判定,可选挂载;encode 时串联在
    /// frustum dispatch 之后(frustum 先、遮挡后)。阴影视锥不挂。
    occlusion: Option<GpuOcclusionStage>,
}

impl GpuCulling {
    pub fn new(
        device: &wgpu::Device,
        source_instances: &wgpu::Buffer,
        prepared: &PreparedGpuCulling,
        frame: &FrameUniform,
        shadow_map: &impl ShadowViewSource,
        enable_readback: bool,
    ) -> Result<Self, String> {
        let candidate_count = prepared.bounds.len() as u32;
        let batch_count = prepared.indirect_template.len() as u32;
        let frustums = view_frustums(frame, shadow_map)?;
        validate_device(device, candidate_count, batch_count, frustums.len())?;
        let bounds_data = nonempty(cast_slice(&prepared.bounds), 16);
        let metadata_data = nonempty(cast_slice(&prepared.metadata), 16);
        let indirect_template = nonempty(cast_slice(&prepared.indirect_template), 20).to_vec();
        let bounds = storage_init(device, "native culling local bounds", bounds_data);
        let metadata = storage_init(device, "native culling metadata", metadata_data);
        let layout = create_layout(device);
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native GPU culling shader v1"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../assets/shaders/native_gpu_culling_v1.wgsl").into(),
            ),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native GPU culling pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Deep Engine native GPU instance frustum culling"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("cull_instances"),
            compilation_options: Default::default(),
            cache: None,
        });
        let capacity = u64::from(candidate_count.max(1));
        let mut views = Vec::with_capacity(frustums.len());
        for (view_index, planes) in frustums.iter().enumerate() {
            let params = pack_frustum(
                planes,
                candidate_count,
                if view_index == 0 {
                    MAIN_SOLID_MASK
                } else {
                    SHADOW_CASTER_MASK
                },
            );
            let frustum = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native GPU culling frustum"),
                contents: &params,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });
            let visible_instances = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Deep Engine native GPU visible instances"),
                size: capacity * GPU_CULLING_INSTANCE_BYTES,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::VERTEX,
                mapped_at_creation: false,
            });
            let indirect = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native GPU indexed indirect commands"),
                contents: &indirect_template,
                usage: wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::INDIRECT
                    | wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC,
            });
            let bind_group = create_bind_group(
                device,
                &layout,
                source_instances,
                &bounds,
                &metadata,
                &frustum,
                &visible_instances,
                &indirect,
            );
            views.push(CullingView {
                frustum,
                visible_instances,
                indirect,
                bind_group,
            });
        }
        let view_count = views.len() as u32;
        let readback = enable_readback
            .then(|| CullingReadback::new(device, views.len(), batch_count as usize));
        let per_view = GPU_CULLING_FRUSTUM_BYTES
            + capacity * GPU_CULLING_INSTANCE_BYTES
            + u64::from(batch_count.max(1)) * GPU_CULLING_INDIRECT_BYTES;
        Ok(Self {
            _bounds: bounds,
            _metadata: metadata,
            pipeline,
            views,
            indirect_template,
            candidate_count,
            revision: 1,
            submitted_revision: 0,
            summary: GpuCullingSummary {
                candidate_instances: candidate_count,
                batches: batch_count,
                views: view_count,
                dispatch_workgroups: candidate_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE)
                    * view_count,
                allocated_bytes: capacity * 32 + per_view * u64::from(view_count),
            },
            readback,
            occlusion: None,
        })
    }

    /// 挂载主视锥 HiZ 遮挡判定(只挂 view 0;HiZ 是主相机金字塔,
    /// 阴影视锥不适用)。挂载后 encode 依次派发 frustum 与遮挡。
    /// 生产接线(渲染器构造处)随可见性缓冲切片落地;本切片由 GPU
    /// 测试作为独立入口驱动。
    #[allow(dead_code)] // Direct builder remains the independent GPU-test entrypoint.
    pub fn attach_occlusion(
        &mut self,
        device: &wgpu::Device,
        source_instances: &wgpu::Buffer,
        source: OcclusionSource,
        frame: &FrameUniform,
        enable_readback: bool,
    ) -> Result<(), String> {
        if self.views.is_empty() {
            return Err("native GPU occlusion requires at least one culling view".into());
        }
        let stage = GpuOcclusionStage::new(
            device,
            source_instances,
            &self._bounds,
            &self._metadata,
            &self.views[0].frustum,
            self.candidate_count,
            source,
            frame,
            enable_readback,
        )?;
        self.occlusion = Some(stage);
        Ok(())
    }

    #[allow(dead_code)] // Reported alongside attach_occlusion until renderer wiring.
    pub fn occlusion_summary(&self) -> Option<(u32, u32, u32)> {
        self.occlusion.as_ref().map(|stage| stage.summary())
    }

    pub fn summary(&self) -> GpuCullingSummary {
        self.summary
    }

    pub fn update_views(
        &mut self,
        queue: &wgpu::Queue,
        frame: &FrameUniform,
        shadow_map: &impl ShadowViewSource,
    ) -> Result<(), String> {
        let frustums = view_frustums(frame, shadow_map)?;
        if frustums.len() != self.views.len() {
            return Err("native GPU culling view count changed after allocation".into());
        }
        let packed = frustums
            .iter()
            .enumerate()
            .map(|(index, planes)| {
                pack_frustum(
                    planes,
                    self.candidate_count,
                    if index == 0 {
                        MAIN_SOLID_MASK
                    } else {
                        SHADOW_CASTER_MASK
                    },
                )
            })
            .collect::<Vec<_>>();
        for (view, bytes) in self.views.iter().zip(&packed) {
            queue.write_buffer(&view.frustum, 0, bytes);
        }
        if let Some(occlusion) = &self.occlusion {
            occlusion.update_params(queue, frame)?;
        }
        self.revision = self.revision.wrapping_add(1);
        Ok(())
    }

    pub fn needs_encode(&self) -> bool {
        self.revision != self.submitted_revision
    }

    pub fn encode(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        for view in &self.views {
            queue.write_buffer(&view.indirect, 0, &self.indirect_template);
        }
        if self.candidate_count > 0 {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("Deep Engine native GPU instance frustum culling"),
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            for view in &self.views {
                pass.set_bind_group(0, &view.bind_group, &[]);
                pass.dispatch_workgroups(
                    self.candidate_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
                    1,
                    1,
                );
            }
        }
        // 串联第二档:frustum 先、遮挡后(独立 compute pass,隐式屏障,
        // 遮挡 pass 不读 frustum 输出,判定自带逐位一致的视锥重放)。
        if let Some(occlusion) = &self.occlusion {
            occlusion.encode(queue, encoder);
        }
        if let Some(readback) = &self.readback {
            for (index, view) in self.views.iter().enumerate() {
                readback.encode_copy(encoder, index, &view.indirect);
            }
        }
        if let Some(occlusion) = &self.occlusion {
            occlusion.encode_readback(encoder);
        }
    }

    pub fn commit_submission(&mut self) {
        self.submitted_revision = self.revision;
        if let Some(readback) = &mut self.readback {
            readback.commit();
        }
        if let Some(occlusion) = &mut self.occlusion {
            occlusion.commit_submission();
        }
    }

    /// 取回主视锥遮挡判定后的幸存实例数(需挂载时启用 readback)。
    #[allow(dead_code)] // Reported alongside attach_occlusion until renderer wiring.
    pub fn take_occlusion_visible(
        &mut self,
        device: &wgpu::Device,
    ) -> Result<Option<u32>, String> {
        match &mut self.occlusion {
            Some(occlusion) => occlusion.take_visible_count(device),
            None => Ok(None),
        }
    }

    pub fn take_metrics(
        &mut self,
        device: &wgpu::Device,
    ) -> Result<Option<GpuCullingFrameMetrics>, String> {
        self.readback
            .as_mut()
            .map_or(Ok(None), |readback| readback.take(device))
    }

    pub fn visible_instances(&self, view_index: usize) -> &wgpu::Buffer {
        &self.views[view_index].visible_instances
    }

    pub fn indirect(&self, view_index: usize) -> &wgpu::Buffer {
        &self.views[view_index].indirect
    }
}

fn view_frustums(
    frame: &FrameUniform,
    shadow_map: &impl ShadowViewSource,
) -> Result<Vec<FrustumPlanes>, String> {
    let main_matrix = frame[0..4]
        .try_into()
        .map_err(|_| "native frame view projection ABI is incomplete")?;
    let mut frustums = vec![frustum_planes(main_matrix)?];
    for index in 0..shadow_map.shadow_view_count() as usize {
        frustums.push(frustum_planes(shadow_map.shadow_view_projection(index))?);
    }
    Ok(frustums)
}

fn pack_frustum(planes: &FrustumPlanes, count: u32, mask: u32) -> [u8; 112] {
    let mut packed = [0; 112];
    packed[..96].copy_from_slice(cast_slice(planes));
    packed[96..].copy_from_slice(cast_slice(&[count, mask, 0, 0]));
    packed
}

fn nonempty(bytes: &[u8], minimum: usize) -> &[u8] {
    if bytes.is_empty() {
        &ZERO_BYTES[..minimum]
    } else {
        bytes
    }
}

static ZERO_BYTES: [u8; 20] = [0; 20];
