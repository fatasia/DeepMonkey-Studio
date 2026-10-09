//! Actual material-aware full-resolution RIS composite, including MSAA retention.
use super::megalights_gbuffer::MegaLightsGBuffer;
pub(super) struct Composite {
    params: wgpu::Buffer,
    bind: wgpu::BindGroup,
    single: wgpu::RenderPipeline,
    msaa: wgpu::RenderPipeline,
}
impl Composite {
    pub fn create(
        device: &wgpu::Device,
        gbuffer: &MegaLightsGBuffer,
        depth: &wgpu::TextureView,
        color: &wgpu::Buffer,
        surfaces: &wgpu::Buffer,
    ) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("MegaLights bilateral composite"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("../../assets/shaders/native_megalights_composite.wgsl").into(),
            ),
        });
        let entries = (0..6)
            .map(|binding| wgpu::BindGroupLayoutEntry {
                binding,
                visibility: wgpu::ShaderStages::FRAGMENT,
                count: None,
                ty: match binding {
                    0 => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    1 | 2 => wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    5 => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: true,
                    },
                    _ => wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                },
            })
            .collect::<Vec<_>>();
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &entries,
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let make = |count| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("MegaLights bilateral composite"),
                layout: Some(&layout),
                vertex: wgpu::VertexState {
                    module: &shader,
                    entry_point: Some("vs"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                primitive: Default::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState {
                    count,
                    ..Default::default()
                },
                multiview_mask: None,
                cache: None,
                fragment: Some(wgpu::FragmentState {
                    module: &shader,
                    entry_point: Some("fs"),
                    compilation_options: Default::default(),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: deep_engine_native::mesh_abi::FORWARD_COLOR_FORMAT,
                        write_mask: wgpu::ColorWrites::ALL,
                        blend: Some(wgpu::BlendState {
                            color: wgpu::BlendComponent {
                                src_factor: wgpu::BlendFactor::One,
                                dst_factor: wgpu::BlendFactor::One,
                                operation: wgpu::BlendOperation::Add,
                            },
                            alpha: wgpu::BlendComponent {
                                src_factor: wgpu::BlendFactor::One,
                                dst_factor: wgpu::BlendFactor::One,
                                operation: wgpu::BlendOperation::Add,
                            },
                        }),
                    })],
                }),
            })
        };
        let single = make(1);
        let msaa = make(deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT);
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 96,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("MegaLights bilateral composite"),
            layout: &single.get_bind_group_layout(0),
            entries: &[
                buffer(0, &params),
                buffer(1, color),
                buffer(2, surfaces),
                texture(3, &gbuffer.base_metal),
                texture(4, &gbuffer.normal_rough),
                texture(5, depth),
            ],
        });
        Self {
            params,
            bind,
            single,
            msaa,
        }
    }
    // Explicit GPU binding and uniform ABI inputs.
    #[allow(clippy::too_many_arguments)]
    pub fn encode(
        &self,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        full: (u32, u32),
        ris: (u32, u32),
        clip: &[[f32; 4]; 4],
        exposure: f32,
        hdr: &wgpu::TextureView,
        msaa: Option<&wgpu::TextureView>,
    ) {
        let mut words = [0u32; 24];
        words[..4].copy_from_slice(&[full.0, full.1, ris.0, ris.1]);
        words[4] = exposure.to_bits();
        for (i, v) in clip.iter().flatten().enumerate() {
            words[8 + i] = v.to_bits();
        }
        queue.write_buffer(&self.params, 0, bytemuck::cast_slice(&words));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("MegaLights bilateral composite"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: msaa.unwrap_or(hdr),
                depth_slice: None,
                resolve_target: msaa.map(|_| hdr),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(if msaa.is_some() {
            &self.msaa
        } else {
            &self.single
        });
        pass.set_bind_group(0, &self.bind, &[]);
        deep_engine_native::benchmark_observer::note_draw();
        pass.draw(0..3, 0..1);
    }
}
fn buffer(binding: u32, resource: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: resource.as_entire_binding(),
    }
}
fn texture(binding: u32, resource: &wgpu::TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry {
        binding,
        resource: wgpu::BindingResource::TextureView(resource),
    }
}
