//! Deep2d 路径 GPU 资源族(体量门拆分子模块;条目逐字未改):
//! 主管线 + 刀 4 固定函数混合管线族构建/缓存/选择,顶点与 paint 上传,
//! 以及 CPU 镜像 `paint_data::blend_composite` 对应的固定函数 blend 状态。

use deep_engine_native::deep2d::{
    DEEP2D_BLEND_DARKEN, DEEP2D_BLEND_LIGHTEN, DEEP2D_BLEND_MULTIPLY, DEEP2D_BLEND_NORMAL,
    DEEP2D_BLEND_OVERWRITE, DEEP2D_BLEND_SCREEN, PreparedDeep2d, blend_premultiplies,
};
use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::deep2d_gpu_cache::{CachedPathPipelines, Deep2dGpuAssetCache};

use super::{SHADER, vertex_transfer};

pub(super) struct Deep2dPathGpuResources {
    pub(super) pipeline: std::sync::Arc<wgpu::RenderPipeline>,
    /// 刀 3:含模板附件 pass 用的 no-op stencil 变体(与主管线同 shader/
    /// 布局/混合,仅 depth_stencil 声明 Stencil8)。
    pub(super) pipeline_stencil: std::sync::Arc<wgpu::RenderPipeline>,
    /// 刀 4 固定函数混合管线族(本帧出现的非 normal 模式):
    /// (blend, pipeline, stencil 变体)。premultiply 模式(multiply/
    /// screen)绑定 `fragment_main_premultiplied` 入口。
    pub(super) blend_pipelines: Vec<(u32, std::sync::Arc<wgpu::RenderPipeline>, std::sync::Arc<wgpu::RenderPipeline>)>,
    /// Path bind group: frame uniform (binding 0) + paint storage (binding 1).
    pub(super) bind_group: wgpu::BindGroup,
    pub(super) vertex_buffer: std::sync::Arc<wgpu::Buffer>,
    pub(super) snapshot: Option<vertex_transfer::VertexSnapshot>,
    pub(super) transfer: vertex_transfer::VertexTransferStats,
}

impl Deep2dPathGpuResources {
    /// 刀 4:按 chunk 混合模式选管线家族(normal 走既有管线,非 normal
    /// 查本帧构建的固定函数混合族)。
    pub(super) fn pipeline_for(
        &self,
        blend: u32,
        with_stencil: bool,
    ) -> (
        &std::sync::Arc<wgpu::RenderPipeline>,
        &std::sync::Arc<wgpu::RenderPipeline>,
    ) {
        if blend == DEEP2D_BLEND_NORMAL {
            return (&self.pipeline, &self.pipeline_stencil);
        }
        let (_, pipeline, pipeline_stencil) = self
            .blend_pipelines
            .iter()
            .find(|(mode, _, _)| *mode == blend)
            .unwrap_or_else(|| panic!("blend pipeline family missing for mode {blend}"));
        (
            if with_stencil { pipeline_stencil } else { pipeline },
            if with_stencil { pipeline } else { pipeline_stencil },
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        format: wgpu::TextureFormat,
        frame_buffer: &wgpu::Buffer,
        prepared: &PreparedDeep2d,
        cache: &Deep2dGpuAssetCache,
        previous: Option<&Self>,
    ) -> Self {
        let paints_layout = cache.path_paint_layout(|| super::path_paint_layout(device));
        let cached = cache.path_pipelines(format, || {
            let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Deep Engine native Deep2d shader v2"),
                source: wgpu::ShaderSource::Wgsl(SHADER.into()),
            });
            let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Deep Engine native Deep2d pipeline layout"),
                bind_group_layouts: &[Some(paints_layout.as_ref())],
                immediate_size: 0,
            });
            let attributes = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4, 2 => Float32x2, 3 => Float32];
            let buffers = [Some(wgpu::VertexBufferLayout {
                array_stride: 36,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &attributes,
            })];
            let targets = [Some(wgpu::ColorTargetState {
                format,
                blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                write_mask: wgpu::ColorWrites::ALL,
            })];
            let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep Engine native Deep2d alpha pipeline v2"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: Default::default(),
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                multiview_mask: None,
                cache: None,
            });
            let pipeline_stencil = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Deep Engine native Deep2d alpha pipeline v2 (stencil pass variant)"),
                layout: Some(&pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vertex_main"),
                    compilation_options: Default::default(),
                    buffers: &buffers,
                },
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    cull_mode: None,
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
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fragment_main"),
                    compilation_options: Default::default(),
                    targets: &targets,
                }),
                multiview_mask: None,
                cache: None,
            });
            CachedPathPipelines {
                pipeline: Arc::new(pipeline),
                pipeline_stencil: Arc::new(pipeline_stencil),
            }
        });
        // 刀 4:为本帧出现的每个非 normal 混合模式构建固定函数管线族
        // (pipeline + no-op stencil 变体),premultiply 模式绑定
        // `fragment_main_premultiplied` 入口。模式集合来自 path 级
        // per-command chunk 流。
        let mut blends: Vec<u32> = prepared
            .chunks
            .iter()
            .map(|chunk| chunk.blend)
            .filter(|blend| *blend != DEEP2D_BLEND_NORMAL)
            .collect();
        blends.sort_unstable();
        blends.dedup();
        let mut blend_pipelines = Vec::with_capacity(blends.len());
        for blend in blends {
            let cached_blend = cache.path_blend_pipelines(format, blend, || {
                let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("Deep Engine native Deep2d shader v2 (blend family)"),
                    source: wgpu::ShaderSource::Wgsl(SHADER.into()),
                });
                let pipeline_layout =
                    device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("Deep Engine native Deep2d pipeline layout"),
                        bind_group_layouts: &[Some(paints_layout.as_ref())],
                        immediate_size: 0,
                    });
                let attributes =
                    wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4, 2 => Float32x2, 3 => Float32];
                let buffers = [Some(wgpu::VertexBufferLayout {
                    array_stride: 36,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &attributes,
                })];
                let targets = [Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(blend_state_for(blend)),
                    write_mask: wgpu::ColorWrites::ALL,
                })];
                let entry = if blend_premultiplies(blend) {
                    "fragment_main_premultiplied"
                } else {
                    "fragment_main"
                };
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("Deep Engine native Deep2d blend pipeline v2"),
                    layout: Some(&pipeline_layout),
                    vertex: wgpu::VertexState {
                        module: &shader,
                        entry_point: Some("vertex_main"),
                        compilation_options: Default::default(),
                        buffers: &buffers,
                    },
                    primitive: wgpu::PrimitiveState {
                        topology: wgpu::PrimitiveTopology::TriangleList,
                        cull_mode: None,
                        ..Default::default()
                    },
                    depth_stencil: None,
                    multisample: Default::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &shader,
                        entry_point: Some(entry),
                        compilation_options: Default::default(),
                        targets: &targets,
                    }),
                    multiview_mask: None,
                    cache: None,
                });
                let pipeline_stencil =
                    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some(
                            "Deep Engine native Deep2d blend pipeline v2 (stencil pass variant)",
                        ),
                        layout: Some(&pipeline_layout),
                        vertex: wgpu::VertexState {
                            module: &shader,
                            entry_point: Some("vertex_main"),
                            compilation_options: Default::default(),
                            buffers: &buffers,
                        },
                        primitive: wgpu::PrimitiveState {
                            topology: wgpu::PrimitiveTopology::TriangleList,
                            cull_mode: None,
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
                        fragment: Some(wgpu::FragmentState {
                            module: &shader,
                            entry_point: Some(entry),
                            compilation_options: Default::default(),
                            targets: &targets,
                        }),
                        multiview_mask: None,
                        cache: None,
                    });
                CachedPathPipelines {
                    pipeline: Arc::new(pipeline),
                    pipeline_stencil: Arc::new(pipeline_stencil),
                }
            });
            blend_pipelines.push((
                blend,
                Arc::clone(&cached_blend.pipeline),
                Arc::clone(&cached_blend.pipeline_stencil),
            ));
        }
        let pipeline = std::sync::Arc::clone(&cached.pipeline);
        let pipeline_stencil = std::sync::Arc::clone(&cached.pipeline_stencil);
        let previous = previous.and_then(|p| {
            p.snapshot
                .as_ref()
                .map(|snapshot| (p.vertex_buffer.as_ref(), snapshot))
        });
        let (vertex_buffer, transfer) =
            vertex_transfer::upload(device, queue, prepared, cache, previous);
        // Paint storage: slot 0 is always present (reserved solid dummy), so
        // the buffer is never empty; gradients/quads read it per fragment.
        let paints_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d paints"),
            contents: bytemuck::cast_slice(&prepared.paints),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native Deep2d paint bindings"),
            layout: &paints_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: frame_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: paints_buffer.as_entire_binding(),
                },
            ],
        });
        Self {
            pipeline,
            pipeline_stencil,
            blend_pipelines,
            bind_group,
            vertex_buffer,
            snapshot: None,
            transfer,
        }
    }
}

/// 刀 4:每模式的固定函数 blend 状态(CPU 镜像 = `paint_data::blend_composite`)。
/// 颜色分量按模式,alpha 恒 `{One, OneMinusSrcAlpha}`(overwrite 为
/// `{One, Zero}` 整体替换)。
fn blend_state_for(mode: u32) -> wgpu::BlendState {
    use wgpu::BlendFactor as F;
    use wgpu::BlendOperation as Op;
    let color = match mode {
        DEEP2D_BLEND_MULTIPLY => wgpu::BlendComponent {
            src_factor: F::Dst,
            dst_factor: F::OneMinusSrcAlpha,
            operation: Op::Add,
        },
        DEEP2D_BLEND_SCREEN => wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::OneMinusSrc,
            operation: Op::Add,
        },
        DEEP2D_BLEND_DARKEN => wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::One,
            operation: Op::Min,
        },
        DEEP2D_BLEND_LIGHTEN => wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::One,
            operation: Op::Max,
        },
        DEEP2D_BLEND_OVERWRITE => wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::Zero,
            operation: Op::Add,
        },
        _ => wgpu::BlendComponent {
            src_factor: F::SrcAlpha,
            dst_factor: F::OneMinusSrcAlpha,
            operation: Op::Add,
        },
    };
    let alpha = if mode == DEEP2D_BLEND_OVERWRITE {
        wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::Zero,
            operation: Op::Add,
        }
    } else {
        wgpu::BlendComponent {
            src_factor: F::One,
            dst_factor: F::OneMinusSrcAlpha,
            operation: Op::Add,
        }
    };
    wgpu::BlendState { color, alpha }
}
