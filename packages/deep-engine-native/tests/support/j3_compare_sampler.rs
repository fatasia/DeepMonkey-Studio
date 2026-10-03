use serde_json::json;
use wgpu::util::DeviceExt;

#[test]
#[ignore = "actual production descriptor compare sampler, independent fixed input precision calibration"]
fn j3_actual_compare_sampler_calibration() {
    pollster::block_on(async {
        let input_bytes =
            std::fs::read(std::env::var("J3_COMPARE_SAMPLER_INPUT").unwrap()).unwrap();
        let input: Vec<f32> = serde_json::from_slice(&input_bytes).unwrap();
        assert_eq!(input.len(), 4 * 4097 * 4);
        let mut runs = vec![];
        for fresh in 0..2 {
            let instance =
                wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
            let adapter = instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::HighPerformance,
                    force_fallback_adapter: false,
                    ..Default::default()
                })
                .await
                .unwrap();
            let info = adapter.get_info();
            assert!(matches!(
                info.device_type,
                wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
            ));
            let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
            let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("fixed comparison calibration depth"),
                size: wgpu::Extent3d {
                    width: 4,
                    height: 4,
                    depth_or_array_layers: 4,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth32Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Deep Engine native shadow comparison sampler"),
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                address_mode_w: wgpu::AddressMode::ClampToEdge,
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                lod_min_clamp: 0.0,
                lod_max_clamp: 0.0,
                compare: Some(wgpu::CompareFunction::LessEqual),
                anisotropy_clamp: 1,
                border_color: None,
            });
            let render_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("j3_compare_sampler_render.wgsl").into(),
                ),
            });
            let render = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: None,
                layout: None,
                vertex: wgpu::VertexState {
                    module: &render_module,
                    entry_point: Some("vertex"),
                    compilation_options: Default::default(),
                    buffers: &[],
                },
                fragment: Some(wgpu::FragmentState {
                    module: &render_module,
                    entry_point: Some("depth"),
                    compilation_options: Default::default(),
                    targets: &[],
                }),
                depth_stencil: Some(wgpu::DepthStencilState {
                    format: wgpu::TextureFormat::Depth32Float,
                    depth_write_enabled: Some(true),
                    depth_compare: Some(wgpu::CompareFunction::Always),
                    stencil: Default::default(),
                    bias: Default::default(),
                }),
                primitive: Default::default(),
                multisample: Default::default(),
                multiview_mask: None,
                cache: None,
            });
            let query = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&input),
                usage: wgpu::BufferUsages::STORAGE,
            });
            let count = input.len() / 4;
            let size = ((count * 2 + 64) * 16) as u64;
            let output = device.create_buffer(&wgpu::BufferDescriptor {
                label: None,
                size,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let read = crate::lod_draw_readback::staging(&device, size);
            let compute_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: None,
                source: wgpu::ShaderSource::Wgsl(
                    include_str!("j3_compare_sampler_compute.wgsl").into(),
                ),
            });
            let compute = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: None,
                layout: None,
                module: &compute_module,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                cache: None,
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor {
                dimension: Some(wgpu::TextureViewDimension::D2Array),
                ..Default::default()
            });
            let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &compute.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: query.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: output.as_entire_binding(),
                    },
                ],
            });
            let mut encoder = device.create_command_encoder(&Default::default());
            for layer in 0..4u32 {
                let mode = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: None,
                    contents: bytemuck::cast_slice(&[layer, 0u32, 0u32, 0u32]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });
                let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: None,
                    layout: &render.get_bind_group_layout(0),
                    entries: &[wgpu::BindGroupEntry {
                        binding: 0,
                        resource: mode.as_entire_binding(),
                    }],
                });
                let layer_view = texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    ..Default::default()
                });
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    color_attachments: &[],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &layer_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    ..Default::default()
                });
                pass.set_pipeline(&render);
                pass.set_bind_group(0, &bindings, &[]);
                pass.draw(0..3, 0..1);
            }
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&compute);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups((count as u32).div_ceil(64), 1, 1);
            }
            encoder.copy_buffer_to_buffer(&output, 0, &read, 0, size);
            queue.submit([encoder.finish()]);
            let result: Vec<f32> =
                bytemuck::cast_slice(&crate::lod_draw_readback::mapped_bytes(&device, &read))
                    .to_vec();
            assert!(validation.pop().await.is_none());
            runs.push(json!({ "freshInstance": fresh, "actualGpu": true, "adapter": format!("{info:?}"), "input": input, "result": result,
                "sampler": { "compare": "less-equal", "minFilter": "linear", "magFilter": "linear", "mipmapFilter": "nearest",
                    "addressModes": "clamp-to-edge", "lodMin": 0, "lodMax": 0 } }));
            device.destroy();
        }
        std::fs::write(
            std::env::var("J3_COMPARE_SAMPLER_OUTPUT").unwrap(),
            serde_json::to_vec(&json!({ "family": "native", "runs": runs })).unwrap(),
        )
        .unwrap();
    });
}
