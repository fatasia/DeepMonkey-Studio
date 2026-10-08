//! 刀 4 毛玻璃 backdrop 捕获链 GPU 侧:capture(copy)→ 半分辨率下采样 →
//! `iterations` 次可分离 `[1,4,6,4,1]/16` 扫 → 底色 quad(SDF 掩罩)。
//!
//! 单源纪律:捕获区域由 `deep2d::backdrop::backdrop_capture_region` 与
//! CPU oracle 共享;模糊核/下采样/双线性采样与 `deep2d/backdrop.rs`
//! 逐式互钉(WGSL `native_deep2d_backdrop_v1.wgsl`),仅剩 f32 舍入与
//! unorm 存储量化差(探针容差依据见 `deep2d_backdrop_gpu_tests`)。

use deep_engine_native::deep2d::PreparedBackdropChunk;
use wgpu::util::DeviceExt;

const SHADER: &str = include_str!("../assets/shaders/native_deep2d_backdrop_v1.wgsl");

/// Per-command base draw plan returned by [`capture_and_blur`].
pub struct BackdropBaseDraw {
    pub bind_group: wgpu::BindGroup,
    pub vertex_buffer: wgpu::Buffer,
}

pub struct Deep2dBackdropGpuResources {
    device: wgpu::Device,
    target_format: wgpu::TextureFormat,
    chain: Option<CaptureChain>,
}

/// One capture chain per region size; recreated when the padded capture size
/// changes (bounded by the per-frame backdrop command budget, fail-closed at
/// 8/frame — see `DEEP2D_MAX_BACKDROP_COMMANDS_PER_FRAME`).
struct CaptureChain {
    region: [u32; 2],
    half: [u32; 2],
    capture_tex: wgpu::Texture,
    ping: wgpu::Texture,
    pong: wgpu::Texture,
    stage_bind_layout: wgpu::BindGroupLayout,
    base_bind_layout: wgpu::BindGroupLayout,
    downsample: wgpu::RenderPipeline,
    sweep_h: wgpu::RenderPipeline,
    sweep_v: wgpu::RenderPipeline,
    base: wgpu::RenderPipeline,
    /// no-op Stencil8 变体:动态块同帧时 pass 必须声明同一 depth-stencil。
    base_stencil: wgpu::RenderPipeline,
    point_sampler: wgpu::Sampler,
    linear_sampler: wgpu::Sampler,
    fullquad: wgpu::Buffer,
}

/// Per-command base params block (WGSL `BaseParams`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BaseParams {
    rect: [f32; 4],
    capture_origin: [f32; 2],
    capture_half: [f32; 2],
    aa: f32,
    corner_radius: f32,
    logical_size: [f32; 2],
    physical_size: [f32; 2],
    /// WGSL uniform 结构尺寸按对齐(16)取整到 64 字节;repr(C) 无尾填充,
    /// 显式补齐,字段偏移与 WGSL 逐一对齐。
    pad: [f32; 2],
}

/// Per-stage params block (WGSL `StageParams`).
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct StageParams {
    half_size: [f32; 2],
    full_size: [f32; 2],
}

impl Deep2dBackdropGpuResources {
    pub fn new(device: &wgpu::Device, target_format: wgpu::TextureFormat) -> Self {
        Self {
            device: device.clone(),
            target_format,
            chain: None,
        }
    }

    /// Capture + downsample + `iterations` blur sweeps for one backdrop
    /// command. `target` must carry `COPY_SRC`; callers guard that.
    #[allow(clippy::too_many_arguments)]
    pub fn capture_and_blur(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        target_size: (u32, u32),
        chunk: &PreparedBackdropChunk,
        logical_size: [f32; 2],
    ) -> BackdropBaseDraw {
        let scale = {
            let ratio_x = f64::from(target_size.0) / f64::from(logical_size[0]);
            let ratio_y = f64::from(target_size.1) / f64::from(logical_size[1]);
            ratio_x.min(ratio_y)
        };
        let offset = [
            (f64::from(target_size.0) - f64::from(logical_size[0]) * scale) * 0.5,
            (f64::from(target_size.1) - f64::from(logical_size[1]) * scale) * 0.5,
        ];
        let (origin, region) = deep_engine_native::deep2d::backdrop_capture_region(
            chunk.rect,
            scale,
            offset,
            [target_size.0, target_size.1],
            chunk.iterations,
        );
        if self
            .chain
            .as_ref()
            .is_none_or(|chain| chain.region != region)
        {
            self.rebuild_chain(region);
        }
        let chain = self.chain.as_ref().expect("capture chain present");
        // Capture: copy the padded region straight off the composited target
        // (source origin = padded region origin in target pixels).
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: target.texture(),
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: origin[0],
                    y: origin[1],
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            chain.capture_tex.as_image_copy(),
            wgpu::Extent3d {
                width: region[0],
                height: region[1],
                depth_or_array_layers: 1,
            },
        );
        let half = chain.half;
        let stage_uniform = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep2d backdrop stage params"),
            contents: bytemuck::bytes_of(&StageParams {
                half_size: [half[0] as f32, half[1] as f32],
                full_size: [region[0] as f32, region[1] as f32],
            }),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let make_stage_bind = |view: &wgpu::TextureView| {
            self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Deep2d backdrop stage bind"),
                layout: &chain.stage_bind_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: stage_uniform.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(&chain.point_sampler),
                    },
                ],
            })
        };
        // Downsample: capture -> pong (half-res).
        {
            let bind = make_stage_bind(&chain.capture_tex.create_view(&Default::default()));
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Deep2d backdrop downsample"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &chain.pong.create_view(&Default::default()),
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&chain.downsample);
            pass.set_bind_group(0, &bind, &[]);
            pass.set_vertex_buffer(0, chain.fullquad.slice(..));
            deep_engine_native::benchmark_observer::note_draw();
            pass.draw(0..6, 0..1);
        }
        // `iterations` x (horizontal sweep -> ping, vertical sweep -> pong).
        for _ in 0..chunk.iterations {
            for (pipeline, (source, target_tex)) in [
                (&chain.sweep_h, (&chain.pong, &chain.ping)),
                (&chain.sweep_v, (&chain.ping, &chain.pong)),
            ] {
                let bind = make_stage_bind(&source.create_view(&Default::default()));
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Deep2d backdrop blur sweep"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &target_tex.create_view(&Default::default()),
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    ..Default::default()
                });
                pass.set_pipeline(pipeline);
                pass.set_bind_group(0, &bind, &[]);
                pass.set_vertex_buffer(0, chain.fullquad.slice(..));
                deep_engine_native::benchmark_observer::note_draw();
                pass.draw(0..6, 0..1);
            }
        }
        // After an integer number of (H, V) pairs the final texture is pong.
        let base_params = BaseParams {
            rect: chunk.rect,
            capture_origin: [origin[0] as f32, origin[1] as f32],
            capture_half: [half[0] as f32, half[1] as f32],
            aa: scale as f32,
            corner_radius: chunk.corner_radius,
            logical_size,
            physical_size: [target_size.0 as f32, target_size.1 as f32],
            pad: [0.0; 2],
        };
        let uniform = self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep2d backdrop base params"),
            contents: bytemuck::bytes_of(&base_params),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep2d backdrop base bind"),
            layout: &chain.base_bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &chain.pong.create_view(&Default::default()),
                    ),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&chain.linear_sampler),
                },
            ],
        });
        // Base quad vertices: the canvas-space rect corners (two triangles).
        // SDF 羽化带(sdf_coverage 在 d=+0.5 logical 归零,CPU oracle 按
        // floor..ceil 像素中心逐点评估)要求 quad 外扩同量,否则羽化带内
        // 无 fragment;掩罩仍由 uniform 里的未外扩 rect 计算,外扩区域
        // coverage→0,视觉与几何矩形一致。
        let [x, y, w, h] = chunk.rect;
        let feather = 0.5;
        let corners = [
            [x - feather, y - feather],
            [x + w + feather, y - feather],
            [x + w + feather, y + h + feather],
            [x - feather, y + h + feather],
        ];
        let vertices: Vec<f32> = [0usize, 1, 2, 0, 2, 3]
            .iter()
            .flat_map(|index| [corners[*index][0], corners[*index][1]])
            .collect();
        let vertex_buffer = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep2d backdrop base quad"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });
        BackdropBaseDraw {
            bind_group,
            vertex_buffer,
        }
    }

    /// Draws the blurred base quad inside the (reopened) main pass.
    pub fn draw_base(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        base: &BackdropBaseDraw,
        with_stencil: bool,
    ) {
        let Some(chain) = self.chain.as_ref() else {
            return;
        };
        pass.set_pipeline(if with_stencil {
            &chain.base_stencil
        } else {
            &chain.base
        });
        pass.set_bind_group(0, &base.bind_group, &[]);
        pass.set_vertex_buffer(0, base.vertex_buffer.slice(..));
        deep_engine_native::benchmark_observer::note_draw();
        pass.draw(0..6, 0..1);
    }

    fn rebuild_chain(&mut self, region: [u32; 2]) {
        let half = [(region[0] + 1) / 2, (region[1] + 1) / 2];
        let texture = |label: &'static str, size: [u32; 2], usage: wgpu::TextureUsages| {
            self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: size[0],
                    height: size[1],
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage,
                view_formats: &[],
            })
        };
        let capture_tex = texture(
            "Deep2d backdrop capture",
            region,
            wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let ping = texture(
            "Deep2d backdrop ping",
            half,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let pong = texture(
            "Deep2d backdrop pong",
            half,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        );
        let shader = self
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Deep Engine native Deep2d backdrop shader v1"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
        let stage_bind_layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Deep2d backdrop stage layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                        count: None,
                    },
                ],
            });
        let base_bind_layout = self
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Deep2d backdrop base layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });
        let pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep2d backdrop stage pipeline layout"),
                bind_group_layouts: &[Some(&stage_bind_layout)],
                immediate_size: 0,
            });
        let base_pipeline_layout = self
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep2d backdrop base pipeline layout"),
                bind_group_layouts: &[Some(&base_bind_layout)],
                immediate_size: 0,
            });
        let fullquad_attrs = wgpu::vertex_attr_array![0 => Float32x2];
        let fullquad_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: 8,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &fullquad_attrs,
        })];
        let stage_target = [Some(wgpu::ColorTargetState {
            format: wgpu::TextureFormat::Rgba8Unorm,
            blend: None,
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let stage_pipeline = |entry: &'static str| {
            self.device
                .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Deep2d backdrop stage pipeline"),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("stage_vertex"),
                        compilation_options: Default::default(),
                        buffers: &fullquad_buffers,
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: Default::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &stage_target,
                    }),
                    multiview_mask: None,
                    cache: None,
                })
        };
        let downsample = stage_pipeline("downsample_fragment");
        let sweep_h = stage_pipeline("sweep_h_fragment");
        let sweep_v = stage_pipeline("sweep_v_fragment");
        let base_attrs = wgpu::vertex_attr_array![0 => Float32x2];
        let base_buffers = [Some(wgpu::VertexBufferLayout {
            array_stride: 8,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &base_attrs,
        })];
        let base_target = [Some(wgpu::ColorTargetState {
            format: self.target_format,
            blend: Some(wgpu::BlendState::ALPHA_BLENDING),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        let base_vertex = wgpu::VertexState {
            module: &shader,
            entry_point: Some("base_vertex"),
            compilation_options: Default::default(),
            buffers: &base_buffers,
        };
        let base_fragment = wgpu::FragmentState {
            module: &shader,
            entry_point: Some("base_fragment"),
            compilation_options: Default::default(),
            targets: &base_target,
        };
        let base = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep2d backdrop base pipeline"),
                layout: Some(&base_pipeline_layout),
                vertex: base_vertex.clone(),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(base_fragment.clone()),
                multiview_mask: None,
                cache: None,
            });
        let base_stencil = self
            .device
            .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep2d backdrop base pipeline (stencil pass variant)"),
                layout: Some(&base_pipeline_layout),
                vertex: base_vertex,
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Stencil8,
                    depth_write_enabled: Some(false),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: crate::deep2d_dynamic_gpu::no_op_stencil(),
                    bias: Default::default(),
                }),
                multisample: Default::default(),
                fragment: Some(base_fragment),
                multiview_mask: None,
                cache: None,
            });
        let point_sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Deep2d backdrop point sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let linear_sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Deep2d backdrop linear sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let fullquad_corners: [f32; 12] = [
            -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0,
        ];
        let fullquad = self
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep2d backdrop fullquad"),
                contents: bytemuck::cast_slice(&fullquad_corners),
                usage: wgpu::BufferUsages::VERTEX,
            });
        self.chain = Some(CaptureChain {
            region,
            half,
            capture_tex,
            ping,
            pong,
            stage_bind_layout,
            base_bind_layout,
            downsample,
            sweep_h,
            sweep_v,
            base,
            base_stencil,
            point_sampler,
            linear_sampler,
            fullquad,
        });
    }
}
