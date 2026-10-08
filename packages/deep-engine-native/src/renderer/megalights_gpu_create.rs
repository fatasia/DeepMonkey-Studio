use super::*;

impl MegaLightsGpuChain {
    /// 创建(调用方包 error scope;显式尺寸护栏先行,设备拒由 scope 捕获)。
    pub(crate) fn create(
        device: &wgpu::Device,
        depth_view: &wgpu::TextureView,
        ies_words: Option<&[f32]>,
        width: u32,
        height: u32,
        epoch: u64,
    ) -> Result<Self, MegaLightsGpuReject> {
        if width == 0 || height == 0 {
            return Err(MegaLightsGpuReject::ViewportEmpty);
        }
        let resolution=budget::resolution(width,height).ok_or(MegaLightsGpuReject::StorageLimit)?;
        let full=resolution.full;
        let (width,height)=resolution.ris;
        let pixels = u64::from(width) * u64::from(height);
        let limit = u64::from(device.limits().max_storage_buffer_binding_size);
        if pixels * u64::from(SURFACE_STRIDE) * 16 > limit || pixels * 16 > limit {
            return Err(MegaLightsGpuReject::StorageLimit);
        }
        let pixels = pixels as usize;
        let storage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC;
        let uniform = wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST;
        let buffer = |label: &str, size: u64, usage: wgpu::BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size,
                usage,
                mapped_at_creation: false,
            })
        };
        let rebuild_params = buffer("megalights rebuild params", (REBUILD_PARAM_WORDS * 4) as u64, uniform);
        let composite_params = buffer("megalights composite params", (COMPOSITE_PARAM_WORDS * 4) as u64, uniform);
        let ris_params = buffer("megalights ris params", (RIS_PARAM_WORDS * 4) as u64, uniform);
        let surfaces = buffer("megalights surfaces", pixels as u64 * SURFACE_STRIDE as u64 * 16, storage);
        let motion = buffer("megalights motion", pixels as u64 * 16, storage);
        let reservoirs_a = buffer("megalights reservoirs a", pixels as u64 * 16, storage);
        let reservoirs_b = buffer("megalights reservoirs b", pixels as u64 * 16, storage);
        let color = buffer("megalights color", pixels as u64 * 16, storage);
        let color_history = buffer("megalights color history", pixels as u64 * 16, storage);
        let visibility = buffer("megalights winner visibility", pixels as u64 * 4, storage);
        let local_count_switch = buffer("megalights opaque local count switch", 8,
            wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST);
        let lights = buffer("megalights lights", (MEGA_LIGHT_WORDS * 4) as u64, storage);
        // IES 载荷 vec4 对齐字数(runtime 重映射载荷 = spot×4 + 表节×4,天然对齐;
        // None = 最小 -1 占位行)。
        let ies_word_count = ies_words.map_or(4, |words| words.len().max(4));
        let ies = buffer("megalights ies", (ies_word_count * 4) as u64, storage);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("megalights production ris"),
            source: wgpu::ShaderSource::Wgsl(compose_production_shader().into()),
        });
        let build_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("megalights production build"),
            layout: None,
            module: &module,
            entry_point: Some("megaBuildMain"),
            compilation_options: Default::default(),
            cache: None,
        });
        let shade_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("megalights production shade"),
            layout: None,
            module: &module,
            entry_point: Some("megaShadeMain"),
            compilation_options: Default::default(),
            cache: None,
        });
        let rebuild_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("megalights surface rebuild"),
            source: wgpu::ShaderSource::Wgsl(REBUILD_WGSL.into()),
        });
        let rebuild_layout = storage_layout(
            device,
            "megalights rebuild layout",
            wgpu::ShaderStages::COMPUTE,
            wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: true,
            },
        );
        let composite_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("megalights composite layout"),
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
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let rebuild_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("megalights rebuild pipeline layout"),
            bind_group_layouts: &[Some(&rebuild_layout)],
            immediate_size: 0,
        });
        let rebuild_pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("megalights surface rebuild"),
            layout: Some(&rebuild_pipeline_layout),
            module: &rebuild_module,
            entry_point: Some("deepMegaRebuildSurfacesFrame"),
            compilation_options: Default::default(),
            cache: None,
        });
        let composite_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("megalights composite pipeline layout"),
            bind_group_layouts: &[Some(&composite_layout)],
            immediate_size: 0,
        });
        let composite_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("megalights composite"),
            source: wgpu::ShaderSource::Wgsl(COMPOSITE_WGSL.into()),
        });
        let create_composite = |count| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("megalights composite"),
            layout: Some(&composite_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &composite_module,
                entry_point: Some("deepMegaCompositeVertex"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState { count, ..Default::default() },
            multiview_mask: None,
            cache: None,
            fragment: Some(wgpu::FragmentState {
                module: &composite_module,
                entry_point: Some("deepMegaCompositeFragment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: FORWARD_COLOR_FORMAT,
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
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
        });
        let composite_pipeline = create_composite(1);
        let composite_msaa_pipeline = create_composite(deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT);
        let build_bind_layout = build_pipeline.get_bind_group_layout(0);
        let shade_bind_layout = shade_pipeline.get_bind_group_layout(0);
        let bind = |label, layout: &wgpu::BindGroupLayout, entries: &[wgpu::BindGroupEntry<'_>]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some(label),
                layout,
                entries,
            })
        };
        let rebuild_bind = bind(
            "megalights rebuild bindings",
            &rebuild_layout,
            &[
                wgpu::BindGroupEntry { binding: 0, resource: rebuild_params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(depth_view) },
                wgpu::BindGroupEntry { binding: 2, resource: surfaces.as_entire_binding() },
            ],
        );
        let build_bind = bind(
            "megalights build bindings",
            &build_bind_layout,
            &compute_entries(
                &ris_params,
                &lights,
                &surfaces,
                &motion,
                &reservoirs_a,
                &reservoirs_b,
                &color,
                &color_history,
                &ies,
                &visibility,
                true,
            ),
        );
        let shade_bind = bind(
            "megalights shade bindings",
            &shade_bind_layout,
            &compute_entries(
                &ris_params,
                &lights,
                &surfaces,
                &motion,
                &reservoirs_a,
                &reservoirs_b,
                &color,
                &color_history,
                &ies,
                &visibility,
                false,
            ),
        );
        let composite_bind = bind(
            "megalights composite bindings",
            &composite_layout,
            &[
                wgpu::BindGroupEntry { binding: 0, resource: composite_params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: color.as_entire_binding() },
            ],
        );
        Ok(Self {
            width,
            height,
            full,
            epoch,
            rebuild_pipeline,
            build_pipeline,
            shade_pipeline,
            composite_pipeline,
            composite_msaa_pipeline,
            rebuild_params,
            composite_params,
            ris_params,
            surfaces,
            motion,
            reservoirs_a,
            reservoirs_b,
            color,
            color_history,
            lights,
            lights_capacity_words: MEGA_LIGHT_WORDS,
            ies,
            ies_capacity: ies_word_count,
            rebuild_bind,
            build_bind,
            shade_bind,
            composite_bind,
            visibility,
            inputs: None,
            local_count_switch,
        })
    }

}
