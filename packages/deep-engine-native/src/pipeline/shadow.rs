use deep_engine_native::{
    mesh_abi::{
        GEOMETRY_VERTEX_ATTRIBUTES, GEOMETRY_VERTEX_BYTES, INSTANCE_VERTEX_ATTRIBUTES,
        PACKED_INSTANCE_BYTES, SHADOW_FORMAT,
    },
    shadow_cache::ShadowCasterMode,
};

use super::{RasterPipelines, ShadowPipelines, raster::RasterState};

pub(super) fn create_shadow_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
) -> ShadowPipelines {
    ShadowPipelines {
        solid: create_shadow_raster_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            ShadowCasterMode::Solid,
        ),
        mask_plain: create_shadow_raster_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            ShadowCasterMode::MaskPlain,
        ),
        mask_material: create_shadow_raster_pipelines(
            device,
            frame_layout,
            material_layout,
            shader,
            ShadowCasterMode::MaskMaterial,
        ),
    }
}

fn create_shadow_raster_pipelines(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    mode: ShadowCasterMode,
) -> RasterPipelines {
    RasterPipelines {
        regular: create_shadow_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            mode,
            RasterState::REGULAR,
        ),
        mirrored: create_shadow_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            mode,
            RasterState::MIRRORED,
        ),
        double_sided: create_shadow_pipeline(
            device,
            frame_layout,
            material_layout,
            shader,
            mode,
            RasterState::DOUBLE_SIDED,
        ),
    }
}

fn create_shadow_pipeline(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    mode: ShadowCasterMode,
    raster: RasterState,
) -> wgpu::RenderPipeline {
    let uses_material = mode == ShadowCasterMode::MaskMaterial;
    let bind_group_layouts = if uses_material {
        vec![Some(frame_layout), Some(material_layout)]
    } else {
        vec![Some(frame_layout)]
    };
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native shadow pipeline layout"),
        bind_group_layouts: &bind_group_layouts,
        immediate_size: 0,
    });
    let vertex_buffers = vertex_buffers();
    let fragment_entry = match mode {
        ShadowCasterMode::Solid => Some("shadow_section"),
        ShadowCasterMode::MaskPlain => Some("shadow_mask_plain"),
        ShadowCasterMode::MaskMaterial => Some("shadow_mask_material"),
    };
    let label = format!(
        "Deep Engine native {mode:?} {} shadow pipeline",
        raster.label
    );
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&label),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("shadow_mask_main"),
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
            format: SHADOW_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: wgpu::DepthBiasState {
                constant: 2,
                slope_scale: 2.0,
                clamp: 0.0,
            },
        }),
        multisample: Default::default(),
        fragment: fragment_entry.map(|entry_point| wgpu::FragmentState {
            module: shader,
            entry_point: Some(entry_point),
            compilation_options: Default::default(),
            targets: &[],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn vertex_buffers() -> [Option<wgpu::VertexBufferLayout<'static>>; 2] {
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
    ]
}
