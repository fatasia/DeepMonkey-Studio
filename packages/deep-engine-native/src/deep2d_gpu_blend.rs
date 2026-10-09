//! 刀 4 固定函数 blend 管线族(deep2d_gpu 的 `#[path]` 子模块,体量门)。
//!
//! 与 CPU 镜像 `deep2d::paint_data::blend_composite` 逐式互钉(文档照抄
//! 该函数头,单一事实源在 paint_data):
//! - normal    `{SrcAlpha, OneMinusSrcAlpha, Add}`,`fragment_main`
//! - multiply  `{Dst, OneMinusSrcAlpha, Add}`(premult 输出),`fragment_main_premultiplied`
//! - screen    `{One, OneMinusSrc, Add}`(premult 输出),`fragment_main_premultiplied`
//! - darken    `{One, One, Min}`,`fragment_main`
//! - lighten   `{One, One, Max}`,`fragment_main`
//! - overwrite `{One, Zero, Add}`,`fragment_main`(rgb 与 alpha 全替换)
//!
//! alpha 除 overwrite(`{One, Zero, Add}`)外全部 `{One, OneMinusSrcAlpha, Add}`。
//!
//! 未知模式回落 normal(fail-closed,不放大)。

use std::sync::Arc;

use deep_engine_native::deep2d::{
    DEEP2D_BLEND_DARKEN, DEEP2D_BLEND_LIGHTEN, DEEP2D_BLEND_MULTIPLY, DEEP2D_BLEND_OVERWRITE,
    DEEP2D_BLEND_SCREEN,
};

/// 模式是否要求 premultiplied 片元入口(与 `blend_premultiplies` 同口径)。
fn premultiplies(blend: u32) -> bool {
    blend == DEEP2D_BLEND_MULTIPLY || blend == DEEP2D_BLEND_SCREEN
}

/// 片元入口:premultiply 模式走 WGSL premul 入口,其余走 straight 入口。
fn entry_point(blend: u32) -> &'static str {
    if premultiplies(blend) {
        "fragment_main_premultiplied"
    } else {
        "fragment_main"
    }
}

/// CPU 镜像注释里的固定函数状态,逐式对应。
fn blend_state(blend: u32) -> wgpu::BlendState {
    let over_alpha = wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        operation: wgpu::BlendOperation::Add,
    };
    let (color, alpha) = match blend {
        DEEP2D_BLEND_MULTIPLY => (
            wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::Dst,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            over_alpha,
        ),
        DEEP2D_BLEND_SCREEN => (
            wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::OneMinusSrc,
                operation: wgpu::BlendOperation::Add,
            },
            over_alpha,
        ),
        DEEP2D_BLEND_DARKEN => (
            wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Min,
            },
            over_alpha,
        ),
        DEEP2D_BLEND_LIGHTEN => (
            wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::One,
                dst_factor: wgpu::BlendFactor::One,
                operation: wgpu::BlendOperation::Max,
            },
            over_alpha,
        ),
        DEEP2D_BLEND_OVERWRITE => (wgpu::BlendComponent::REPLACE, wgpu::BlendComponent::REPLACE),
        // normal(含未知模式回落):与 legacy 主管线逐参一致。
        _ => (
            wgpu::BlendComponent {
                src_factor: wgpu::BlendFactor::SrcAlpha,
                dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                operation: wgpu::BlendOperation::Add,
            },
            over_alpha,
        ),
    };
    wgpu::BlendState { color, alpha }
}

/// 六模式 ×(无模板 / Stencil8 no-op 变体)管线族。shader 模块、管线布局、
/// 顶点布局与主管线族完全一致,仅 fragment 入口与混合状态按模式分派;
/// 索引按 `DEEP2D_BLEND_*` 常量(0 = normal,调用方以主管线对象覆盖)。
pub(super) fn blend_family(
    device: &wgpu::Device,
    pipeline_layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
    format: wgpu::TextureFormat,
) -> [(Arc<wgpu::RenderPipeline>, Arc<wgpu::RenderPipeline>); 6] {
    let attributes =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4, 2 => Float32x2, 3 => Float32];
    let buffers = [Some(wgpu::VertexBufferLayout {
        array_stride: 36,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &attributes,
    })];
    let make = |blend: u32, stencil: bool| {
        let targets = [Some(wgpu::ColorTargetState {
            format,
            blend: Some(blend_state(blend)),
            write_mask: wgpu::ColorWrites::ALL,
        })];
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep Engine native Deep2d blend family pipeline"),
            layout: Some(pipeline_layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &buffers,
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                cull_mode: None,
                ..Default::default()
            },
            depth_stencil: stencil.then(|| wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Stencil8,
                depth_write_enabled: Some(false),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: crate::deep2d_dynamic_gpu::no_op_stencil(),
                bias: Default::default(),
            }),
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some(entry_point(blend)),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        })
    };
    std::array::from_fn(|mode| {
        (
            Arc::new(make(mode as u32, false)),
            Arc::new(make(mode as u32, true)),
        )
    })
}
