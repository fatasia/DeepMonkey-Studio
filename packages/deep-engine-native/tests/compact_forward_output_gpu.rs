#[allow(dead_code)]
#[path = "../src/forward_targets.rs"]
mod forward_targets;
#[allow(dead_code)]
#[path = "../src/output_pass.rs"]
mod output_pass;

use deep_engine_native::mesh_abi::{FORWARD_COLOR_FORMAT, FORWARD_SAMPLE_COUNT};
use forward_targets::ForwardTargets;
use output_pass::OutputPass;
use std::sync::{Arc, Mutex};
use winit::dpi::PhysicalSize;

const fn rgba(r: f64, g: f64, b: f64, a: f64) -> wgpu::Color {
    wgpu::Color { r, g, b, a }
}
const COLORS: [wgpu::Color; 4] = [
    rgba(0.00390625, 0.015625, 0.03125, 1.0),
    rgba(8.0, 2.0, 0.5, 1.0),
    rgba(0.25, 0.5, 1.0, 0.25),
    rgba(0.0, 0.0, 0.0, 0.0),
];
const FORMATS: [wgpu::TextureFormat; 2] = [
    wgpu::TextureFormat::Rgba8Unorm,
    wgpu::TextureFormat::Rgba8UnormSrgb,
];

fn gpu() -> (wgpu::Device, wgpu::Queue, Arc<Mutex<Vec<String>>>) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("real GPU adapter");
    let info = adapter.get_info();
    assert!(
        matches!(
            info.device_type,
            wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu
        ),
        "hardware GPU required: {info:?}"
    );
    println!("compact forward output adapter: {info:?}");
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).unwrap();
    let errors = Arc::new(Mutex::new(Vec::new()));
    let captured = errors.clone();
    device.on_uncaptured_error(Arc::new(move |error| {
        captured.lock().unwrap().push(error.to_string())
    }));
    (device, queue, errors)
}

/// 实际 MSAA 清屏/resolve → 产品 OutputPass → 按行去 padding 的 RGBA8 读回。
fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    size: PhysicalSize<u32>,
    compact: bool,
    format: wgpu::TextureFormat,
    color: wgpu::Color,
    pattern: Option<&wgpu::RenderPipeline>,
) -> Vec<u8> {
    let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let memory = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
    let internal = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let source_size = if compact {
        PhysicalSize::new(1, 1)
    } else {
        size
    };
    let source = ForwardTargets::new(device, source_size);
    assert_eq!(source.resolved_texture().width(), source_size.width);
    assert_eq!(source.resolved_texture().height(), source_size.height);
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("compact forward output readback target"),
        size: wgpu::Extent3d {
            width: size.width,
            height: size.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let output = OutputPass::new(device, format, &source.hdr_view, None, None);
    assert!(!output.uses_bloom() && !output.uses_fog());
    let row_bytes = (size.width * 4).div_ceil(256) * 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("compact forward output pixels"),
        size: u64::from(row_bytes * size.height),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &source.msaa_view,
            depth_slice: None,
            resolve_target: Some(&source.hdr_view),
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(color),
                store: wgpu::StoreOp::Discard,
            },
        })];
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("real forward MSAA resolve"),
            color_attachments: &attachments,
            ..Default::default()
        });
        if let Some(pipeline) = pattern {
            pass.set_pipeline(pipeline);
            pass.draw(0..3, 0..1);
        }
    }
    output.draw(&mut encoder, &target.create_view(&Default::default()));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(size.height),
            },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device
        .poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(std::time::Duration::from_secs(10)),
        })
        .unwrap();
    receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap()
        .unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    let pixels: Vec<u8> = mapped
        .chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..(size.width * 4) as usize].iter().copied())
        .collect();
    drop(mapped);
    readback.unmap();
    for error in [
        pollster::block_on(internal.pop()),
        pollster::block_on(memory.pop()),
        pollster::block_on(validation.pop()),
    ] {
        assert!(error.is_none(), "GPU error: {error:?}");
    }
    pixels
}

#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn compact_hdr_clear_matches_full_size_at_every_output_pixel() {
    let (device, queue, errors) = gpu();
    let mut compared = 0;
    for format in FORMATS {
        for (width, height) in [(1, 1), (3, 7), (65, 9), (127, 31), (9, 65)] {
            let size = PhysicalSize::new(width, height);
            for color in COLORS {
                let full = render(&device, &queue, size, false, format, color, None);
                let compact = render(&device, &queue, size, true, format, color, None);
                assert_eq!(full.len(), (width * height * 4) as usize);
                assert_eq!(
                    compact, full,
                    "format={format:?}, size={size:?}, color={color:?}"
                );
                assert!(full.chunks_exact(4).all(|pixel| pixel == &full[..4]));
                assert_eq!(full[3], (color.a * 255.0).round() as u8);
                if color.a > 0.0 {
                    assert!(full[..3].iter().any(|value| *value > 0));
                }
                compared += width * height;
            }
        }
    }
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    println!("compact/full: 40 cases, {compared} pixels equal, GPU errors=0");
}

fn pattern_pipeline(device: &wgpu::Device) -> wgpu::RenderPipeline {
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("full-size per-pixel HDR control"),
        source: wgpu::ShaderSource::Wgsl(r#"
@vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
    let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3)); return vec4f(p[i],0,1);
}
@fragment fn fs(@builtin(position) p:vec4f) -> @location(0) vec4f {
    let colors=array<vec4f,4>(vec4f(0.00390625,0.015625,0.03125,1),vec4f(8,2,0.5,1),vec4f(0.25,0.5,1,0.25),vec4f(0,0,0,0));
    return colors[(u32(p.x)%2u)+2u*(u32(p.y)%2u)];
}"#.into()),
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("full-size per-pixel HDR control"),
        layout: None,
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
                format: FORWARD_COLOR_FORMAT,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn full_size_hdr_keeps_nonuniform_pixel_coordinates() {
    let (device, queue, errors) = gpu();
    let pattern = pattern_pipeline(&device);
    let mut compared = 0;
    for format in FORMATS {
        let reference: Vec<_> = COLORS
            .iter()
            .map(|color| {
                render(
                    &device,
                    &queue,
                    PhysicalSize::new(1, 1),
                    false,
                    format,
                    *color,
                    None,
                )
            })
            .collect();
        assert_ne!(reference[0], reference[1]);
        assert_ne!(reference[1], reference[2]);
        for (width, height) in [(3, 7), (65, 9), (9, 65)] {
            let pixels = render(
                &device,
                &queue,
                PhysicalSize::new(width, height),
                false,
                format,
                COLORS[0],
                Some(&pattern),
            );
            for y in 0..height {
                for x in 0..width {
                    let index = ((y * width + x) * 4) as usize;
                    assert_eq!(
                        &pixels[index..index + 4],
                        reference[((x % 2) + 2 * (y % 2)) as usize].as_slice(),
                        "{format:?}: ({x},{y}) in {width}x{height}"
                    );
                }
            }
            compared += width * height;
        }
    }
    assert!(
        errors.lock().unwrap().is_empty(),
        "{:?}",
        errors.lock().unwrap()
    );
    println!(
        "full-size nonuniform: 6 cases, {compared} pixels preserve source coordinates, GPU errors=0"
    );
}
