const SHADER: &str = include_str!("../assets/shaders/native_outline_composite_v1.wgsl");

use deep_engine_native::mesh_abi::{
    GEOMETRY_VERTEX_ATTRIBUTES, GEOMETRY_VERTEX_BYTES, INSTANCE_VERTEX_ATTRIBUTES,
    PACKED_INSTANCE_BYTES,
};

use crate::forward_targets::{OUTLINE_DEPTH_FORMAT, OUTLINE_MASK_FORMAT};

pub struct OutlinePass {
    layout: wgpu::BindGroupLayout,
    binding: Option<wgpu::BindGroup>,
    pipeline: wgpu::RenderPipeline,
}

pub struct OutlineMaskPipelines([wgpu::RenderPipeline; 3]);

impl OutlineMaskPipelines {
    pub fn new(
        device: &wgpu::Device,
        frame_layout: &wgpu::BindGroupLayout,
        material_layout: &wgpu::BindGroupLayout,
        shader: &wgpu::ShaderModule,
    ) -> Self {
        Self([
            create_mask_pipeline(
                device,
                frame_layout,
                material_layout,
                shader,
                wgpu::FrontFace::Ccw,
                Some(wgpu::Face::Back),
                "regular",
            ),
            create_mask_pipeline(
                device,
                frame_layout,
                material_layout,
                shader,
                wgpu::FrontFace::Cw,
                Some(wgpu::Face::Back),
                "mirrored",
            ),
            create_mask_pipeline(
                device,
                frame_layout,
                material_layout,
                shader,
                wgpu::FrontFace::Ccw,
                None,
                "double-sided",
            ),
        ])
    }

    pub fn raw(&self) -> &[wgpu::RenderPipeline; 3] {
        &self.0
    }
}

fn create_mask_pipeline(
    device: &wgpu::Device,
    frame_layout: &wgpu::BindGroupLayout,
    material_layout: &wgpu::BindGroupLayout,
    shader: &wgpu::ShaderModule,
    front_face: wgpu::FrontFace,
    cull_mode: Option<wgpu::Face>,
    variant: &str,
) -> wgpu::RenderPipeline {
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native outline mask pipeline layout"),
        bind_group_layouts: &[Some(frame_layout), Some(material_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&format!("Deep Engine native outline mask {variant}")),
        layout: Some(&layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[
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
            ],
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            front_face,
            cull_mode,
            ..Default::default()
        },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: OUTLINE_DEPTH_FORMAT,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some("outline_mask_fragment"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: OUTLINE_MASK_FORMAT,
                blend: None,
                write_mask: wgpu::ColorWrites::RED,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl OutlinePass {
    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Deep Engine native object outline layout"),
            entries: &[
                texture_entry(
                    0,
                    false,
                    wgpu::TextureSampleType::Float { filterable: false },
                ),
                texture_entry(1, false, wgpu::TextureSampleType::Depth),
                texture_entry(2, true, wgpu::TextureSampleType::Depth),
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native object outline shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native object outline pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Deep Engine native object outline pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some(if surface_format.is_srgb() {
                    "fragment_srgb_target"
                } else {
                    "fragment_unorm_target"
                }),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        Self {
            layout,
            binding: None,
            pipeline,
        }
    }

    pub fn rebind(
        &mut self,
        device: &wgpu::Device,
        views: Option<(&wgpu::TextureView, &wgpu::TextureView, &wgpu::TextureView)>,
    ) {
        self.binding = views.map(|(mask, selected_depth, scene_depth)| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Deep Engine native object outline inputs"),
                layout: &self.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(mask),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(selected_depth),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(scene_depth),
                    },
                ],
            })
        });
    }

    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, surface: &wgpu::TextureView) {
        let binding = self
            .binding
            .as_ref()
            .expect("outline draw requires active outline targets");
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: surface,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native object outline composite"),
            color_attachments: &attachments,
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, binding, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn texture_entry(
    binding: u32,
    multisampled: bool,
    sample_type: wgpu::TextureSampleType,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type,
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled,
        },
        count: None,
    }
}

#[cfg(test)]
mod tests {
    use super::SHADER;
    #[test]
    fn web_outline_semantics_are_frozen() {
        assert!(SHADER.contains("maximum - minimum"));
        assert!(SHADER.contains("* 2.5"));
        assert!(SHADER.contains("0.3, 0.62, 1.0"));
        assert!(SHADER.contains("0.14, 0.29, 0.44"));
        assert!(SHADER.contains("nearest_selected > scene_depth_at(pixel)"));
    }
}
