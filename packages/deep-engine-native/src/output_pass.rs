use wgpu::util::DeviceExt;

use deep_engine_native::mesh_abi::FRAME_UNIFORM_BYTES;

const PLAIN_SHADER: &str = include_str!("../assets/shaders/native_output_v1.wgsl");
const BLOOM_SHADER: &str = include_str!("../assets/shaders/native_output_bloom_v1.wgsl");
const FOG_SHADER: &str = include_str!("../assets/shaders/native_output_fog_v1.wgsl");
const BLOOM_FOG_SHADER: &str = include_str!("../assets/shaders/native_output_bloom_fog_v1.wgsl");

/// 作者色彩分级 uniform 字节数：3 × vec4（switches/grading/whiteBalance），
/// 与 Web `packPbrAuthorColorEffects` 的 12-float 布局逐位一致。
const AUTHOR_GRADING_BYTES: u64 = std::mem::size_of::<[f32; 12]>() as u64;

pub struct OutputPass {
    texture_layout: wgpu::BindGroupLayout,
    texture_bind_group: wgpu::BindGroup,
    pipeline: wgpu::RenderPipeline,
    bloom_intensity: Option<wgpu::Buffer>,
    bloom_sampler: Option<wgpu::Sampler>,
    grading_buffer: wgpu::Buffer,
    fog_enabled: bool,
}

impl OutputPass {
    pub fn new(
        device: &wgpu::Device,
        surface_format: wgpu::TextureFormat,
        hdr_view: &wgpu::TextureView,
        bloom: Option<(&wgpu::TextureView, f32)>,
        fog: Option<(&wgpu::TextureView, &wgpu::Buffer)>,
        // 作者色彩分级的 12-float 打包；None（未启用或六通道全零中性）时
        // 上传全零 uniform——shader 分支精确恒等，宿主不改变任何管线状态。
        grading: Option<[f32; 12]>,
    ) -> Self {
        let bloom_enabled = bloom.is_some();
        let fog_enabled = fog.is_some();
        let texture_layout = create_layout(device, bloom_enabled, fog_enabled);
        let bloom_intensity = bloom.map(|(_, intensity)| {
            device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Deep Engine native bloom output controls"),
                contents: bytemuck::cast_slice(&[intensity, 0.0_f32, 0.0, 0.0]),
                usage: wgpu::BufferUsages::UNIFORM,
            })
        });
        let bloom_sampler = bloom.map(|_| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some("Deep Engine native bloom output sampler"),
                mag_filter: wgpu::FilterMode::Linear,
                min_filter: wgpu::FilterMode::Linear,
                ..Default::default()
            })
        });
        let grading_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Deep Engine native author color grading controls"),
            contents: bytemuck::bytes_of(&grading.unwrap_or([0.0; 12])),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Deep Engine native HDR output shader v1"),
            source: wgpu::ShaderSource::Wgsl(output_shader(bloom_enabled, fog_enabled).into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Deep Engine native output pipeline layout"),
            bind_group_layouts: &[Some(&texture_layout)],
            immediate_size: 0,
        });
        let pipeline = create_pipeline(device, surface_format, &pipeline_layout, &shader);
        let texture_bind_group = create_texture_bind_group(
            device,
            &texture_layout,
            hdr_view,
            bloom.map(|(view, _)| view),
            bloom_sampler.as_ref(),
            bloom_intensity.as_ref(),
            &grading_buffer,
            fog,
        );
        Self {
            texture_layout,
            texture_bind_group,
            pipeline,
            bloom_intensity,
            bloom_sampler,
            grading_buffer,
            fog_enabled,
        }
    }

    pub fn uses_bloom(&self) -> bool {
        self.bloom_intensity.is_some()
    }

    pub fn uses_fog(&self) -> bool {
        self.fog_enabled
    }

    pub fn prepare_rebind(
        &self,
        device: &wgpu::Device,
        hdr_view: &wgpu::TextureView,
        bloom_view: Option<&wgpu::TextureView>,
        fog: Option<(&wgpu::TextureView, &wgpu::Buffer)>,
    ) -> Result<wgpu::BindGroup, String> {
        if self.uses_bloom() != bloom_view.is_some() {
            return Err("output bloom mode cannot change during a resize transaction".into());
        }
        if self.uses_fog() != fog.is_some() {
            return Err("output fog mode cannot change during a resize transaction".into());
        }
        Ok(create_texture_bind_group(
            device,
            &self.texture_layout,
            hdr_view,
            bloom_view,
            self.bloom_sampler.as_ref(),
            self.bloom_intensity.as_ref(),
            &self.grading_buffer,
            fog,
        ))
    }

    pub fn publish_rebind(&mut self, binding: wgpu::BindGroup) {
        self.texture_bind_group = binding;
    }

    pub fn draw(&self, encoder: &mut wgpu::CommandEncoder, surface_view: &wgpu::TextureView) {
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: surface_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep Engine native ACES output pass"),
            color_attachments: &color_attachments,
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.texture_bind_group, &[]);
        pass.draw(0..3, 0..1);
    }
}

fn output_shader(bloom: bool, fog: bool) -> &'static str {
    match (bloom, fog) {
        (false, false) => PLAIN_SHADER,
        (true, false) => BLOOM_SHADER,
        (false, true) => FOG_SHADER,
        (true, true) => BLOOM_FOG_SHADER,
    }
}

fn create_layout(
    device: &wgpu::Device,
    bloom_enabled: bool,
    fog_enabled: bool,
) -> wgpu::BindGroupLayout {
    let texture = |binding, filterable| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let mut entries = vec![texture(0, false)];
    if bloom_enabled {
        entries.push(texture(1, true));
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 2,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
            count: None,
        });
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 3,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(16),
            },
            count: None,
        });
    }
    if fog_enabled {
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 4,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Depth,
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: true,
            },
            count: None,
        });
        entries.push(wgpu::BindGroupLayoutEntry {
            binding: 5,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: wgpu::BufferSize::new(FRAME_UNIFORM_BYTES),
            },
            count: None,
        });
    }
    // 作者色彩分级在全部四个变体上恒定绑定（48 字节）：零值时 shader 分支
    // 精确中性，管线/绑定结构不随分级启用而变化，resize 事务零影响。
    entries.push(wgpu::BindGroupLayoutEntry {
        binding: 6,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(AUTHOR_GRADING_BYTES),
        },
        count: None,
    });
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native output texture layout"),
        entries: &entries,
    })
}

fn create_pipeline(
    device: &wgpu::Device,
    surface_format: wgpu::TextureFormat,
    layout: &wgpu::PipelineLayout,
    shader: &wgpu::ShaderModule,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native ACES output pipeline"),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: shader,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: shader,
            entry_point: Some(if surface_format.is_srgb() {
                "fragment_srgb_target"
            } else {
                "fragment_unorm_target"
            }),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: surface_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn create_texture_bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    hdr_view: &wgpu::TextureView,
    bloom_view: Option<&wgpu::TextureView>,
    sampler: Option<&wgpu::Sampler>,
    intensity: Option<&wgpu::Buffer>,
    grading: &wgpu::Buffer,
    fog: Option<(&wgpu::TextureView, &wgpu::Buffer)>,
) -> wgpu::BindGroup {
    let mut entries = vec![wgpu::BindGroupEntry {
        binding: 0,
        resource: wgpu::BindingResource::TextureView(hdr_view),
    }];
    if let (Some(view), Some(sampler), Some(buffer)) = (bloom_view, sampler, intensity) {
        entries.push(wgpu::BindGroupEntry {
            binding: 1,
            resource: wgpu::BindingResource::TextureView(view),
        });
        entries.push(wgpu::BindGroupEntry {
            binding: 2,
            resource: wgpu::BindingResource::Sampler(sampler),
        });
        entries.push(wgpu::BindGroupEntry {
            binding: 3,
            resource: buffer.as_entire_binding(),
        });
    }
    if let Some((depth, frame)) = fog {
        entries.push(wgpu::BindGroupEntry {
            binding: 4,
            resource: wgpu::BindingResource::TextureView(depth),
        });
        entries.push(wgpu::BindGroupEntry {
            binding: 5,
            resource: frame.as_entire_binding(),
        });
    }
    entries.push(wgpu::BindGroupEntry {
        binding: 6,
        resource: grading.as_entire_binding(),
    });
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Deep Engine native resolved HDR output bindings"),
        layout,
        entries: &entries,
    })
}
