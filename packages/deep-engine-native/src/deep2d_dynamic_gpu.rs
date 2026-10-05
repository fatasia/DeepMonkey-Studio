//! 刀 3:stencil-then-cover 动态路径填充的 GPU 资源与管线族(GPUI 对齐)。
//!
//! 一个动态块的绘制序列(全部在一个 render pass 内,scissor 逐块生效):
//!   1. clear  — 该块 cover bbox 画一遍,stencil Replace 0(清掉上一块残值);
//!   2. cover  — fence 三角形汤,朝向增/减写 stencil(nonzero:前向
//!      IncrementWrap/背向 DecrementWrap;evenodd:双向 Invert 翻转 LSB);
//!   3. fill   — cover bbox 重画,stencil 测试(nonzero:≠0;evenodd:
//!      LSB==1,read_mask 0x01 + reference 1)通过处走 v2 着色(实心顶点
//!      色/渐变 paint 存储)与 ALPHA_BLENDING。
//!
//! 朝向不敏感是非零填充的正确性关键:front/back 增减约定即使整体颠倒,
//! winding 只发生全局符号翻转,`≠0` 判定不变;evenodd 的 Invert 位翻转
//! 天然无朝向依赖。模板纹理按物理尺寸惰性创建(动态块缺席的帧不建、
//! 不附加、零开销——纯静态帧的 pass 描述符与刀 3 之前逐字节一致)。

use std::sync::Arc;

use wgpu::util::DeviceExt;

use deep_engine_native::deep2d::{FillRule, PreparedDeep2d};
use crate::deep2d_gpu_cache::{CachedDynamicPipelines, Deep2dGpuAssetCache};

const COVER_SHADER: &str = include_str!("../assets/shaders/native_deep2d_dynamic_cover_v1.wgsl");
const FILL_SHADER: &str = include_str!("../assets/shaders/native_deep2d_v1.wgsl");

/// 物理目标对应的模板附件(Stencil8,惰性创建,尺寸变更重建)。
pub(super) struct StencilTarget {
    pub size: (u32, u32),
    pub view: wgpu::TextureView,
}

/// 动态路径 GPU 资源:pipeline 族 + fence 顶点缓冲(每帧重建;顶点区间
/// 由 chunk 携带,绘制侧不另存计数)。
pub(super) struct Deep2dDynamicPathGpuResources {
    pub pipelines: std::sync::Arc<CachedDynamicPipelines>,
    pub edge_buffer: wgpu::Buffer,
    /// fence 管线的 frame uniform 绑定(与 atlas 共享 frame layout)。
    pub edge_bind_group: wgpu::BindGroup,
}

impl Deep2dDynamicPathGpuResources {
    pub(super) fn new(
        device: &wgpu::Device,
        frame_layout: &wgpu::BindGroupLayout,
        frame_buffer: &wgpu::Buffer,
        prepared: &PreparedDeep2d,
        format: wgpu::TextureFormat,
        cache: &Deep2dGpuAssetCache,
    ) -> Self {
        // 先取 paints 布局再进管线缓存锁:build_pipelines 在 dynamic_pipelines
        // 的互斥锁内执行,重入同一 Mutex 会死锁(首动态帧实测)。
        let paints_layout = cache.path_paint_layout(|| crate::deep2d_gpu::path_paint_layout(device));
        let pipelines = cache.dynamic_pipelines(format, || {
            build_pipelines(device, format, frame_layout, &paints_layout)
        });
        let edge_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native Deep2d dynamic fence edges"),
            contents: bytemuck::cast_slice(&prepared.dynamic_edges),
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        });
        let edge_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Deep Engine native Deep2d dynamic edge bindings"),
            layout: frame_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: frame_buffer.as_entire_binding(),
            }],
        });
        Self {
            pipelines,
            edge_buffer,
            edge_bind_group,
        }
    }
}

/// 静态管线在含模板附件的 pass 中使用的 no-op 模板状态
/// (Always 通过 + Keep 不写;deep2d 动态 pass 的变体管线共用)。
pub(crate) fn no_op_stencil() -> wgpu::StencilState {
    let keep = stencil_face(wgpu::CompareFunction::Always, wgpu::StencilOperation::Keep);
    wgpu::StencilState {
        front: keep,
        back: keep,
        read_mask: 0xff,
        write_mask: 0x00,
    }
}

/// 模板状态构造(深度不参与:Stencil8 无深度面)。
fn no_depth(stencil: wgpu::StencilState) -> wgpu::DepthStencilState {
    wgpu::DepthStencilState {
        format: wgpu::TextureFormat::Stencil8,
        depth_write_enabled: Some(false),
        depth_compare: Some(wgpu::CompareFunction::Always),
        stencil,
        bias: Default::default(),
    }
}

fn stencil_face(
    compare: wgpu::CompareFunction,
    op: wgpu::StencilOperation,
) -> wgpu::StencilFaceState {
    wgpu::StencilFaceState {
        compare,
        fail_op: op,
        depth_fail_op: op,
        pass_op: op,
    }
}

/// v2 fill 顶点布局(PathVertex,36 字节)——clear/fill 管线共用。
fn path_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRIBUTES: [wgpu::VertexAttribute; 4] =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4, 2 => Float32x2, 3 => Float32];
    wgpu::VertexBufferLayout {
        array_stride: 36,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &ATTRIBUTES,
    }
}

/// fence 顶点布局([f32; 2] 位置,8 字节)。
fn edge_vertex_layout() -> wgpu::VertexBufferLayout<'static> {
    const ATTRIBUTES: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x2];
    wgpu::VertexBufferLayout {
        array_stride: 8,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &ATTRIBUTES,
    }
}

fn color_target(format: wgpu::TextureFormat, write: bool) -> wgpu::ColorTargetState {
    wgpu::ColorTargetState {
        format,
        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
        write_mask: if write {
            wgpu::ColorWrites::ALL
        } else {
            wgpu::ColorWrites::empty()
        },
    }
}

/// cover pass 管线(fence 几何,颜色写关,stencil 写开)。
#[allow(clippy::too_many_arguments)]
fn cover_pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    format: wgpu::TextureFormat,
    label: &'static str,
    stencil: wgpu::StencilState,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vertex_edge"),
            compilation_options: Default::default(),
            buffers: &[Some(edge_vertex_layout())],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: Some(no_depth(stencil)),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some("fragment_cover"),
            compilation_options: Default::default(),
            targets: &[Some(color_target(format, false))],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// PathVertex 顶点管线(clear 或 fill;clear 走 cover 模块的 fragment_cover,
/// fill 走 v2 模块的 fragment_main)。
#[allow(clippy::too_many_arguments)]
fn path_pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    vertex_entry: &'static str,
    fragment_entry: &'static str,
    layout: &wgpu::PipelineLayout,
    format: wgpu::TextureFormat,
    label: &'static str,
    write_color: bool,
    stencil: wgpu::StencilState,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some(vertex_entry),
            compilation_options: Default::default(),
            buffers: &[Some(path_vertex_layout())],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            cull_mode: None,
            ..Default::default()
        },
        depth_stencil: Some(no_depth(stencil)),
        multisample: Default::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fragment_entry),
            compilation_options: Default::default(),
            targets: &[Some(color_target(format, write_color))],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn build_pipelines(
    device: &wgpu::Device,
    format: wgpu::TextureFormat,
    frame_layout: &wgpu::BindGroupLayout,
    paints_layout: &wgpu::BindGroupLayout,
) -> CachedDynamicPipelines {
    let cover_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native Deep2d dynamic cover shader v1"),
        source: wgpu::ShaderSource::Wgsl(COVER_SHADER.into()),
    });
    let fill_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native Deep2d dynamic fill shader (v2 reuse)"),
        source: wgpu::ShaderSource::Wgsl(FILL_SHADER.into()),
    });
    // clear/fill 复用 path 管线布局(frame uniform + paints storage):
    // clear 片段阶段不读 paints,但共享一个 bind group 让绘制循环少一次切换。
    let shared_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native Deep2d dynamic shared layout"),
        bind_group_layouts: &[Some(paints_layout)],
        immediate_size: 0,
    });
    let edge_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native Deep2d dynamic edge layout"),
        bind_group_layouts: &[Some(frame_layout)],
        immediate_size: 0,
    });
    let replace = wgpu::StencilOperation::Replace;
    let inc = wgpu::StencilOperation::IncrementWrap;
    let dec = wgpu::StencilOperation::DecrementWrap;
    let invert = wgpu::StencilOperation::Invert;
    let keep = wgpu::StencilOperation::Keep;
    let always = wgpu::CompareFunction::Always;
    // nonzero cover:front +1 / back -1(朝向约定颠倒只造成全局符号翻转,
    // `≠0` 判定不变);evenodd cover:双向 Invert 位翻转 LSB——每穿越一次
    // 翻一次位,LSB 即穿越奇偶。双向 Increment 在多重覆盖区会失效:洞的
    // 正下方(外环带+内环顶+内环底=3 次覆盖)计数值 3≠0 会被 Equal-0 当成
    // 外部,而真 evenodd 奇偶为奇=内部(真机实测 4 像素内部分歧后修正)。
    let cover_nonzero = wgpu::StencilState {
        front: stencil_face(always, inc),
        back: stencil_face(always, dec),
        read_mask: 0xff,
        write_mask: 0xff,
    };
    let cover_evenodd = wgpu::StencilState {
        front: stencil_face(always, invert),
        back: stencil_face(always, invert),
        read_mask: 0xff,
        write_mask: 0x01,
    };
    let clear = wgpu::StencilState {
        front: stencil_face(always, replace),
        back: stencil_face(always, replace),
        read_mask: 0xff,
        write_mask: 0xff,
    };
    let fill_nonzero_stencil = wgpu::StencilState {
        front: stencil_face(wgpu::CompareFunction::NotEqual, keep),
        back: stencil_face(wgpu::CompareFunction::NotEqual, keep),
        read_mask: 0xff,
        write_mask: 0x00,
    };
    let fill_evenodd_stencil = wgpu::StencilState {
        front: stencil_face(wgpu::CompareFunction::Equal, keep),
        back: stencil_face(wgpu::CompareFunction::Equal, keep),
        read_mask: 0x01,
        write_mask: 0x00,
    };
    CachedDynamicPipelines {
        clear: Arc::new(path_pipeline(
            device,
            &cover_module,
            "vertex_path",
            "fragment_cover",
            &shared_layout,
            format,
            "Deep Engine native Deep2d dynamic stencil clear pipeline",
            false,
            clear,
        )),
        cover: Arc::new(cover_pipeline(
            device,
            &cover_module,
            &edge_pipeline_layout,
            format,
            "Deep Engine native Deep2d dynamic cover pipeline",
            cover_nonzero,
        )),
        cover_evenodd: Arc::new(cover_pipeline(
            device,
            &cover_module,
            &edge_pipeline_layout,
            format,
            "Deep Engine native Deep2d dynamic cover evenodd pipeline",
            cover_evenodd,
        )),
        fill_nonzero: Arc::new(path_pipeline(
            device,
            &fill_module,
            "vertex_main",
            "fragment_main",
            &shared_layout,
            format,
            "Deep Engine native Deep2d dynamic fill nonzero pipeline",
            true,
            fill_nonzero_stencil,
        )),
        fill_evenodd: Arc::new(path_pipeline(
            device,
            &fill_module,
            "vertex_main",
            "fragment_main",
            &shared_layout,
            format,
            "Deep Engine native Deep2d dynamic fill evenodd pipeline",
            true,
            fill_evenodd_stencil,
        )),
    }
}

/// 依据 fill rule 选 (cover, fill) 管线对。
pub(super) fn pipeline_pair<'a>(
    pipelines: &'a CachedDynamicPipelines,
    fill_rule: FillRule,
) -> (&'a wgpu::RenderPipeline, &'a wgpu::RenderPipeline) {
    match fill_rule {
        FillRule::Nonzero => (&pipelines.cover, &pipelines.fill_nonzero),
        FillRule::Evenodd => (&pipelines.cover_evenodd, &pipelines.fill_evenodd),
    }
}
