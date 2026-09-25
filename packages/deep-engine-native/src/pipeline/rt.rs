//! F2 RT fragment 像素消费管线族：仅静态 opaque/MASK 批次的方向阴影
//! Ray Query 变体。BLEND 整族不在 TLAS 驻留内（renderer::rt_residency
//! 同口径），因此本族不提供混合语义管线；透明批次始终走栅格路径。
//!
//! 布局为 `frame_rt`（含 binding 10 TLAS 槽）+ 共享 material layout；
//! vertex 阶段与普通 mesh 管线同源（同一拼接模块），仅 fragment 入口
//! 换成 `fragment_main_rt`。创建入口在 renderer 初始化，仅当设备启用
//! 实验性 ray query 时执行——任何失败由 error scope 捕获并 fail-closed
//! 回退栅格，不阻塞渲染器创建。

use deep_engine_native::mesh_abi::{
    FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, GEOMETRY_VERTEX_ATTRIBUTES,
    GEOMETRY_VERTEX_BYTES, INSTANCE_VERTEX_ATTRIBUTES, PACKED_INSTANCE_BYTES,
    TANGENT_VERTEX_ATTRIBUTES, TANGENT_VERTEX_BYTES,
};

use super::raster::RasterState;

/// RT opaque/MASK 管线族：standard + normal_mapped 两组，各含
/// regular/mirrored/double_sided 三变体（与栅格 solid 家族一一对应）。
pub(crate) struct RtMeshPipelines {
    standard: RtRasterPipelines,
    normal_mapped: RtRasterPipelines,
}

struct RtRasterPipelines {
    regular: wgpu::RenderPipeline,
    mirrored: wgpu::RenderPipeline,
    double_sided: wgpu::RenderPipeline,
}

impl RtMeshPipelines {
    /// 与栅格 `MeshPipelines::select` 的 solid 分支同语义的变体选择。
    pub(crate) fn select(
        &self,
        mirrored: bool,
        double_sided: bool,
        normal_mapped: bool,
    ) -> &wgpu::RenderPipeline {
        let set = if normal_mapped {
            &self.normal_mapped
        } else {
            &self.standard
        };
        if double_sided {
            &set.double_sided
        } else if mirrored {
            &set.mirrored
        } else {
            &set.regular
        }
    }
}

/// 在已启用 ray query 的设备上创建 RT opaque/MASK 管线族。调用方保证
/// `frame_rt` layout 存在（非 RT 设备该 layout 为 None，不应走到这里）。
pub(crate) fn create_rt_mesh_pipelines(
    device: &wgpu::Device,
    frame_rt_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> RtMeshPipelines {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native RT mesh pipeline layout"),
        bind_group_layouts: &[Some(frame_rt_layout), Some(material_layout)],
        immediate_size: 0,
    });
    let targets = [Some(wgpu::ColorTargetState {
        format: FORWARD_COLOR_FORMAT,
        // opaque/MASK 不混合，与栅格 Solid 语义一致。
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let create = |raster: RasterState, normal_mapped: bool| {
        let label = format!("Deep Engine native RT {} mesh pipeline", raster.label);
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(&label),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: shader,
                entry_point: Some(if normal_mapped {
                    "vertex_normal_mapped"
                } else {
                    "vertex_main"
                }),
                compilation_options: Default::default(),
                buffers: &vertex_buffers(normal_mapped),
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                front_face: raster.front_face,
                cull_mode: raster.cull_mode,
                ..Default::default()
            },
            // RT pass 只画 opaque/MASK：写深度语义与栅格 solid 相同。
            depth_stencil: Some(wgpu::DepthStencilState {
                format: FORWARD_DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState {
                count: FORWARD_SAMPLE_COUNT,
                ..Default::default()
            },
            fragment: Some(wgpu::FragmentState {
                module: shader,
                entry_point: Some("fragment_main_rt"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        })
    };
    RtMeshPipelines {
        standard: RtRasterPipelines {
            regular: create(RasterState::REGULAR, false),
            mirrored: create(RasterState::MIRRORED, false),
            double_sided: create(RasterState::DOUBLE_SIDED, false),
        },
        normal_mapped: RtRasterPipelines {
            regular: create(RasterState::REGULAR, true),
            mirrored: create(RasterState::MIRRORED, true),
            double_sided: create(RasterState::DOUBLE_SIDED, true),
        },
    }
}

fn vertex_buffers(normal_mapped: bool) -> [Option<wgpu::VertexBufferLayout<'static>>; 3] {
    [
        Some(wgpu::VertexBufferLayout {
            array_stride: GEOMETRY_VERTEX_BYTES,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &GEOMETRY_VERTEX_ATTRIBUTES,
        }),
        Some(wgpu::VertexBufferLayout {
            array_stride: PACKED_INSTANCE_BYTES,
            step_mode: wgpu::VertexStepMode::Instance,
            attributes: &INSTANCE_VERTEX_ATTRIBUTES,
        }),
        normal_mapped.then_some(wgpu::VertexBufferLayout {
            array_stride: TANGENT_VERTEX_BYTES,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &TANGENT_VERTEX_ATTRIBUTES,
        }),
    ]
}
