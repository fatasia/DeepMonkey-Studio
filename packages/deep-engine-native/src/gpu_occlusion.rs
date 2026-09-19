//! R4 遮挡判定 compute 第一档(R4 GPU-driven 首切片)。
//!
//! 与 [`crate::gpu_culling::GpuCulling`] 的 frustum pass 串联:frustum 先、
//! 遮挡后。遮挡 pass 重放与 frustum pass 逐位一致的视锥判定,再用主视锥
//! HiZ 金字塔(标准 Z、min 缩减,与 webgpu 侧 hiZPyramid 的 conservative
//! 档语义一致)做遮挡判定,输出 per-instance u32 标志。
//!
//! 纪律:全步定序、无原子、无 workgroup 共享内存;阈值带 1e-6 裕量;
//! 判定只少剔不误剔(半径/矩形全部取保守上界)。
//!
//! 边界(如实):深度金字塔纹理由调用方提供;native 渲染器侧的
//! 「MSAA 深度 resolve + reduce 进金字塔」生产接线不在本切片,本切片
//! 以受控合成金字塔验证判定内核;两阶段完整管线(可见性缓冲 + indirect)
//! 属下一切片。

use bytemuck::cast_slice;
use deep_engine_native::culling_contract::GPU_CULLING_WORKGROUP_SIZE;
use deep_engine_native::mesh_abi::FrameUniform;
use std::sync::mpsc;
use wgpu::util::DeviceExt;

/// 遮挡判定裕量:场景最近深度比实例最近判定深度近超该值才判遮挡。
pub const OCCLUSION_MARGIN: f32 = 1e-6;
/// 足迹矩形单边 texel 迭代上限(顶层为 1,下探低层时兜底,保定序成本)。
pub const OCCLUSION_RECT_SIDE_CAP: u32 = 16;

/// HiZ 金字塔输入契约:调用方持有纹理与尺寸;采样按显式 mip level。
#[derive(Clone)]
pub struct OcclusionSource {
    pub view: wgpu::TextureView,
    /// 金字塔第 0 层(全分辨率)宽高,亦是屏幕矩形折算基准。
    pub width: u32,
    pub height: u32,
    /// 本切片按规范采样顶层;rect 采样实现保持通用。
    pub mip_level: u32,
}

/// 从 FrameUniform 确定性提取的投影项(frame_data_with_camera 布局)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProjectionTerms {
    pub depth_scale: f32,
    pub near: f32,
    pub focal_x: f32,
    pub focal_y: f32,
}

/// 行/列范数提取主相机投影项:forward 单位 ⇒ 行 2 范数 = far/(far-near),
/// 行 0/1 范数 = focal/aspect 与 focal,near 由平移行反解。
/// 纯 CPU 函数,确定性,单测覆盖(对照 PlayerView 原值)。
pub fn projection_terms(frame: &FrameUniform) -> Result<ProjectionTerms, String> {
    let row_norm = |row: usize| {
        ((frame[0][row] * frame[0][row]
            + frame[1][row] * frame[1][row]
            + frame[2][row] * frame[2][row])
            .sqrt()) as f32
    };
    let depth_scale = row_norm(2);
    let focal_x = row_norm(0);
    let focal_y = row_norm(1);
    if !depth_scale.is_finite()
        || !focal_x.is_finite()
        || !focal_y.is_finite()
        || depth_scale <= 1e-8
        || focal_x <= 1e-8
        || focal_y <= 1e-8
    {
        return Err("native occlusion frame projection rows are degenerate".into());
    }
    let eye = [frame[8][0], frame[8][1], frame[8][2]];
    let mut forward = [frame[0][2] / depth_scale, frame[1][2] / depth_scale, frame[2][2] / depth_scale];
    let forward_length = (forward[0] * forward[0] + forward[1] * forward[1] + forward[2] * forward[2])
        .sqrt();
    if !forward_length.is_finite() || forward_length <= 0.0 {
        return Err("native occlusion camera forward is degenerate".into());
    }
    for value in &mut forward {
        *value /= forward_length;
    }
    let near = -frame[3][2] / depth_scale
        - (forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2]);
    if !near.is_finite() || near <= 0.0 {
        return Err("native occlusion camera near plane is degenerate".into());
    }
    Ok(ProjectionTerms {
        depth_scale,
        near,
        focal_x,
        focal_y,
    })
}

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
struct OcclusionParams {
    dims: [u32; 4],
    config: [u32; 4],
    projection: [f32; 4],
    viewport: [f32; 4],
    view_projection: [[f32; 4]; 4],
}

const OCCLUSION_PARAMS_BYTES: u64 = std::mem::size_of::<OcclusionParams>() as u64;

fn pack_params(
    count: u32,
    source: &OcclusionSource,
    frame: &FrameUniform,
    terms: &ProjectionTerms,
) -> Result<OcclusionParams, String> {
    let shift = source.mip_level;
    let level_width = source.width.checked_shr(shift).unwrap_or(0).max(1);
    let level_height = source.height.checked_shr(shift).unwrap_or(0).max(1);
    if source.width == 0 || source.height == 0 {
        return Err("native occlusion HiZ source has empty dimensions".into());
    }
    Ok(OcclusionParams {
        dims: [count, level_width, level_height, source.mip_level],
        config: [0, OCCLUSION_RECT_SIDE_CAP, 0, 0],
        projection: [terms.depth_scale, terms.near, terms.focal_x, terms.focal_y],
        viewport: [source.width as f32, source.height as f32, OCCLUSION_MARGIN, 0.0],
        view_projection: [frame[0], frame[1], frame[2], frame[3]],
    })
}

struct OcclusionView {
    params: wgpu::Buffer,
    flags: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

/// 遮挡判定 stage:单视图(主视锥)。HiZ 是主相机的深度金字塔,
/// 阴影视锥不适用,因此只挂 view 0。
pub struct GpuOcclusionStage {
    pipeline: wgpu::ComputePipeline,
    view: OcclusionView,
    hiz_view: wgpu::TextureView,
    candidate_count: u32,
    source_width: u32,
    source_height: u32,
    mip_level: u32,
    readback: Option<OcclusionReadback>,
}

impl GpuOcclusionStage {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        device: &wgpu::Device,
        source_instances: &wgpu::Buffer,
        bounds: &wgpu::Buffer,
        metadata: &wgpu::Buffer,
        frustum: &wgpu::Buffer,
        candidate_count: u32,
        source: OcclusionSource,
        frame: &FrameUniform,
        enable_readback: bool,
    ) -> Result<Self, String> {
        let terms = projection_terms(frame)?;
        let params =
            pack_params(candidate_count, &source, frame, &terms)?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Deep Engine native GPU occlusion layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(112),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 5,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(OCCLUSION_PARAMS_BYTES),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 6,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native GPU occlusion shader v1"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../assets/shaders/native_gpu_occlusion_v1.wgsl").into(),
            ),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native GPU occlusion pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Deep Engine native GPU instance HiZ occlusion"),
            layout: Some(&pipeline_layout),
            module: &shader,
            entry_point: Some("occlude_instances"),
            compilation_options: Default::default(),
            cache: None,
        });
        let flag_bytes = u64::from(candidate_count.max(1)) * 4;
        let flags = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep Engine native GPU occlusion visibility flags"),
            size: flag_bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let params_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native GPU occlusion params"),
            contents: cast_slice(&[params]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native GPU occlusion bindings"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: source_instances.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: bounds.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: metadata.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: frustum.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: flags.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: params_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 6,
                    resource: wgpu::BindingResource::TextureView(&source.view),
                },
            ],
        });
        Ok(Self {
            pipeline,
            view: OcclusionView {
                params: params_buffer,
                flags,
                bind_group,
            },
            hiz_view: source.view,
            candidate_count,
            source_width: source.width,
            source_height: source.height,
            mip_level: source.mip_level,
            readback: OcclusionReadback::new(device, flag_bytes as usize, enable_readback),
        })
    }

    pub fn summary(&self) -> (u32, u32, u32) {
        (
            self.candidate_count,
            self.candidate_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
            OCCLUSION_RECT_SIDE_CAP,
        )
    }

    /// 可见标志缓冲,供消费链(scan+compact)绑定读取。
    pub fn flags(&self) -> &wgpu::Buffer {
        &self.view.flags
    }

    /// 每帧更新投影项与视锥矩阵(frustum uniform 由 GpuCulling::update_views 负责)。
    pub fn update_params(&self, queue: &wgpu::Queue, frame: &FrameUniform) -> Result<(), String> {
        let terms = projection_terms(frame)?;
        let source = OcclusionSource {
            view: self.hiz_view.clone(),
            width: self.source_width,
            height: self.source_height,
            mip_level: self.mip_level,
        };
        let params = pack_params(self.candidate_count, &source, frame, &terms)?;
        queue.write_buffer(&self.view.params, 0, cast_slice(&[params]));
        Ok(())
    }

    pub fn encode(&self, queue: &wgpu::Queue, encoder: &mut wgpu::CommandEncoder) {
        if self.candidate_count == 0 {
            return;
        }
        // flags 整段清零:pass 只写 1,其余槽位保持 0(mask 外/被剔)。
        queue.write_buffer(
            &self.view.flags,
            0,
            &vec![0u8; (self.candidate_count as usize) * 4],
        );
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("Deep Engine native GPU instance HiZ occlusion"),
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.view.bind_group, &[]);
        pass.dispatch_workgroups(
            self.candidate_count.div_ceil(GPU_CULLING_WORKGROUP_SIZE),
            1,
            1,
        );
    }

    pub fn encode_readback(&self, encoder: &mut wgpu::CommandEncoder) {
        if let Some(readback) = &self.readback {
            readback.encode_copy(encoder, &self.view.flags);
        }
    }

    pub fn commit_submission(&mut self) {
        if let Some(readback) = &mut self.readback {
            readback.commit();
        }
    }

    pub fn take_visible_count(&mut self, device: &wgpu::Device) -> Result<Option<u32>, String> {
        match &mut self.readback {
            Some(readback) => readback.take(device),
            None => Ok(None),
        }
    }
}

/// flags readback:staging MAP_READ 缓冲 + 定序统计 1 的个数。
/// 诊断口径与 gpu_culling_readback 一致(commit 后下一 take 取回)。
struct OcclusionReadback {
    buffer: wgpu::Buffer,
    bytes: usize,
    pending: bool,
}

impl OcclusionReadback {
    fn new(device: &wgpu::Device, bytes: usize, enabled: bool) -> Option<Self> {
        if !enabled {
            return None;
        }
        Some(Self {
            buffer: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Deep Engine native GPU occlusion flags readback"),
                size: bytes.max(4) as u64,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
            bytes: bytes.max(4),
            pending: false,
        })
    }

    fn encode_copy(&self, encoder: &mut wgpu::CommandEncoder, flags: &wgpu::Buffer) {
        encoder.copy_buffer_to_buffer(flags, 0, &self.buffer, 0, self.bytes as u64);
    }

    fn commit(&mut self) {
        self.pending = true;
    }

    fn take(&mut self, device: &wgpu::Device) -> Result<Option<u32>, String> {
        if !self.pending {
            return Ok(None);
        }
        self.pending = false;
        let (sender, receiver) = mpsc::sync_channel(1);
        self.buffer
            .map_async(wgpu::MapMode::Read, .., move |result| {
                let _ = sender.send(result);
            });
        device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|error| format!("GPU occlusion readback device poll failed: {error}"))?;
        receiver
            .recv()
            .map_err(|error| format!("GPU occlusion readback callback failed: {error}"))?
            .map_err(|error| format!("GPU occlusion readback map failed: {error}"))?;
        let mapped = self
            .buffer
            .get_mapped_range(..)
            .map_err(|error| format!("GPU occlusion mapped range failed: {error}"))?;
        let mut visible = 0u32;
        for chunk in mapped.chunks_exact(4) {
            if u32::from_le_bytes(chunk.try_into().unwrap()) != 0 {
                visible += 1;
            }
        }
        drop(mapped);
        self.buffer.unmap();
        Ok(Some(visible))
    }
}
