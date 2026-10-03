use super::super::SIZE;
use deep_engine_native::mesh_abi::FORWARD_SAMPLE_COUNT;
use wgpu::util::DeviceExt;
/// The CPU blend enters as float32 texels. This pass performs only the actual
/// target conversion and four-sample resolve; no BRDF, textures or layer mix.
pub(super) fn hardware_store(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    colors: &[[f64; 3]],
) -> Vec<[f32; 3]> {
    assert_eq!(colors.len(), (SIZE * SIZE) as usize);
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let extent = wgpu::Extent3d {
        width: SIZE,
        height: SIZE,
        depth_or_array_layers: 1,
    };
    let input = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("I23 CPU blend float32"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let data: Vec<[f32; 4]> = colors
        .iter()
        .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32, 1.0])
        .collect();
    queue.write_texture(
        input.as_image_copy(),
        bytemuck::cast_slice(&data),
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(SIZE * 16),
            rows_per_image: Some(SIZE),
        },
        extent,
    );
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("I23 store oracle layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        }],
    });
    let view = input.create_view(&Default::default());
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("I23 store oracle"),
        layout: &layout,
        entries: &[wgpu::BindGroupEntry {
            binding: 0,
            resource: wgpu::BindingResource::TextureView(&view),
        }],
    });
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("I23 store-only shader"),
        source: wgpu::ShaderSource::Wgsl(STORE_WGSL.into()),
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("I23 store pipeline"),
        bind_group_layouts: &[Some(&layout)],
        immediate_size: 0,
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("I23 store-only rgba16f"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: Default::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState {
            count: FORWARD_SAMPLE_COUNT,
            ..Default::default()
        },
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: deep_engine_native::mesh_abi::FORWARD_COLOR_FORMAT,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    let make = |samples, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: Some("I23 store target"),
            size: extent,
            mip_level_count: 1,
            sample_count: samples,
            dimension: wgpu::TextureDimension::D2,
            format: deep_engine_native::mesh_abi::FORWARD_COLOR_FORMAT,
            usage,
            view_formats: &[],
        })
    };
    let msaa = make(FORWARD_SAMPLE_COUNT, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let resolved = make(
        1,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
    );
    let msaa_view = msaa.create_view(&Default::default());
    let resolved_view = resolved.create_view(&Default::default());
    let readback = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("I23 store readback"),
        contents: &vec![0u8; (SIZE * SIZE * 8) as usize],
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("I23 only storage conversion"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &msaa_view,
                depth_slice: None,
                resolve_target: Some(&resolved_view),
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Discard,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    encoder.copy_texture_to_buffer(
        resolved.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(SIZE * 8),
                rows_per_image: Some(SIZE),
            },
        },
        extent,
    );
    queue.submit([encoder.finish()]);
    let bytes = super::super::map_readback(device, &readback);
    let result = super::super::decode_hdr(&bytes);
    assert!(
        pollster::block_on(validation.pop()).is_none(),
        "I23 store oracle validation"
    );
    result
}

const STORE_WGSL: &str = r#"
@group(0) @binding(0) var reference: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) index:u32)->@builtin(position) vec4f {
 let positions=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));
 return vec4f(positions[index],0.0,1.0);
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {
 return textureLoad(reference,vec2i(p.xy),0);
}
"#;
