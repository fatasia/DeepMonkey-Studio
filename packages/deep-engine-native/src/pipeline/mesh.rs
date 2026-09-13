use deep_engine_native::mesh_abi::{
    FORWARD_COLOR_FORMAT, FORWARD_DEPTH_FORMAT, FORWARD_SAMPLE_COUNT, GEOMETRY_VERTEX_ATTRIBUTES,
    GEOMETRY_VERTEX_BYTES, INSTANCE_VERTEX_ATTRIBUTES, PACKED_INSTANCE_BYTES,
    TANGENT_VERTEX_ATTRIBUTES, TANGENT_VERTEX_BYTES,
};

use super::{MaterialPipelines, RasterPipelines, raster::RasterState};

pub(super) fn create_material_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    transparent: bool,
) -> MaterialPipelines {
    MaterialPipelines {
        standard: create_raster_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            transparent,
            false,
        ),
        normal_mapped: create_raster_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            transparent,
            true,
        ),
    }
}

fn create_raster_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    transparent: bool,
    normal_mapped: bool,
) -> RasterPipelines {
    RasterPipelines {
        regular: create_mesh_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            RasterState::REGULAR,
            transparent,
            normal_mapped,
        ),
        mirrored: create_mesh_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            RasterState::MIRRORED,
            transparent,
            normal_mapped,
        ),
        double_sided: create_mesh_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            RasterState::DOUBLE_SIDED,
            transparent,
            normal_mapped,
        ),
    }
}

fn create_mesh_pipeline(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    raster: RasterState,
    transparent: bool,
    normal_mapped: bool,
) -> wgpu::RenderPipeline {
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native pipeline layout"),
        bind_group_layouts: &[Some(frame_layout), Some(material_layout)],
        immediate_size: 0,
    });
    let vertex_buffers = vertex_buffers(normal_mapped);
    let targets = [Some(wgpu::ColorTargetState {
        format: FORWARD_COLOR_FORMAT,
        blend: blend_state(transparent),
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let label = format!(
        "Deep Engine native {} {} mesh pipeline",
        if transparent { "blend" } else { "depth" },
        raster.label
    );
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
            buffers: &vertex_buffers,
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            front_face: raster.front_face,
            cull_mode: raster.cull_mode,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: FORWARD_DEPTH_FORMAT,
            depth_write_enabled: Some(!transparent),
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
            entry_point: Some("fragment_main"),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        multiview_mask: None,
        cache: None,
    })
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

fn blend_state(transparent: bool) -> Option<wgpu::BlendState> {
    transparent.then_some(wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::SrcAlpha,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        },
    })
}
