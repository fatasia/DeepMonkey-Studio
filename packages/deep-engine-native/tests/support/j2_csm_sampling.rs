use serde_json::Value;
use wgpu::util::DeviceExt;
#[allow(dead_code)]
#[path = "lod_draw_readback.rs"]
mod readback;
pub(super) async fn sample(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipeline: &wgpu::RenderPipeline,
    f: &Value,
    blend: f64,
    filter: &str,
    edge: bool,
    width: usize,
) -> Vec<f32> {
    let size = f["size"].as_u64().unwrap() as u32;
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: size,
            height: size,
            depth_or_array_layers: 2,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: None,
        size: wgpu::Extent3d {
            width: width as u32,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let mut data = [0.0f32; 84];
    for i in 0..4 {
        data[i * 16..i * 16 + 16].copy_from_slice(&[
            1.,
            0.,
            0.,
            0.,
            0.,
            1.,
            0.,
            0.,
            0.,
            0.,
            0.,
            0.,
            0.,
            0.,
            f["receiverDepth"].as_f64().unwrap() as f32,
            1.,
        ]);
    }
    data[64..68].copy_from_slice(&[2., 4., 4., 4.]);
    data[68..72].copy_from_slice(&[blend as f32, 4., 4., 4.]);
    data[76..80].copy_from_slice(&[2., 0., 1. / size as f32, 0.]);
    data[82] = 1.;
    let uniform = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: None,
        contents: bytemuck::cast_slice(&data),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let mode = if filter == "linear" {
        wgpu::FilterMode::Linear
    } else {
        wgpu::FilterMode::Nearest
    };
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        compare: Some(wgpu::CompareFunction::LessEqual),
        mag_filter: mode,
        min_filter: mode,
        ..Default::default()
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 7,
                resource: uniform.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&depth.create_view(
                    &wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D2Array),
                        ..Default::default()
                    },
                )),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
    });
    let writer = create_writer(device, f);
    let mut encoder = device.create_command_encoder(&Default::default());
    for layer in 0..2 {
        let view = depth.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2),
            base_array_layer: layer,
            array_layer_count: Some(1),
            ..Default::default()
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(
                        f["clearDepths"][layer as usize].as_f64().unwrap() as f32
                    ),
                    store: wgpu::StoreOp::Store,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        if edge {
            pass.set_pipeline(&writer);
            pass.set_scissor_rect(size / 2, 0, size / 2, size);
            pass.draw(0..3, layer..layer + 1);
        }
    }
    {
        let view = target.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: None,
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    let bytes = (width as u32 * 16).div_ceil(256) * 256;
    let read = readback::staging(device, u64::from(bytes));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &read,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes),
                rows_per_image: Some(1),
            },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    let bytes = readback::mapped_bytes(device, &read);
    let lanes: &[f32] = bytemuck::cast_slice(&bytes);
    (0..width).map(|i| lanes[i * 4]).collect()
}
fn create_writer(device: &wgpu::Device, f: &Value) -> wgpu::RenderPipeline {
    let code = format!(
        r#"struct Out {{ @builtin(position) p: vec4f,@location(0) @interpolate(flat) d: f32 }};
@vertex fn v(@builtin(vertex_index) i:u32,@builtin(instance_index) layer:u32)->Out {{
let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var out:Out;out.p=vec4f(p[i],0,1);out.d=select({a},{b},layer==1u);return out;}}
@fragment fn f(in:Out)->@builtin(frag_depth) f32 {{return in.d;}}"#,
        a = f["edgeRightDepths"][0],
        b = f["edgeRightDepths"][1]
    );
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: None,
        source: wgpu::ShaderSource::Wgsl(code.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: None,
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("v"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("f"),
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
    })
}
