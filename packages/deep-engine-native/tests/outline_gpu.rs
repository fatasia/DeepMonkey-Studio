#[path = "../src/forward_targets.rs"]
mod forward_targets;
#[path = "../src/frame_bindings.rs"]
mod frame_bindings;
#[path = "../src/outline_pass.rs"]
mod outline_pass;

use forward_targets::ForwardTargets;
use outline_pass::{OutlineMaskPipelines, OutlinePass};
use winit::dpi::PhysicalSize;

const WIDTH: u32 = 16;
const HEIGHT: u32 = 8;

fn gpu() -> (wgpu::Device, wgpu::Queue) {
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backends = wgpu::Backends::VULKAN | wgpu::Backends::DX12;
    let instance = wgpu::Instance::new(descriptor);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        ..Default::default()
    }))
    .expect("hardware GPU adapter");
    pollster::block_on(adapter.request_device(&Default::default())).unwrap()
}

fn depth_texture(device: &wgpu::Device, samples: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: samples,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn clear_depth(encoder: &mut wgpu::CommandEncoder, texture: &wgpu::Texture, value: f32) {
    let view = texture.create_view(&Default::default());
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("outline test depth clear"),
        color_attachments: &[],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &view,
            depth_ops: Some(wgpu::Operations {
                load: wgpu::LoadOp::Clear(value),
                store: wgpu::StoreOp::Store,
            }),
            stencil_ops: None,
        }),
        ..Default::default()
    }));
}

fn render(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    mask_pixels: &[u8],
    selected_depth_value: f32,
    scene_depth_value: f32,
) -> Vec<u8> {
    let mask = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("outline test object mask"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        mask.as_image_copy(),
        mask_pixels,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(WIDTH),
            rows_per_image: Some(HEIGHT),
        },
        mask.size(),
    );
    let selected_depth = depth_texture(device, 1, "outline test selected depth");
    let scene_depth = depth_texture(device, 4, "outline test scene depth");
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("outline test RGBA target"),
        size: mask.size(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let mut pass = OutlinePass::new(device, wgpu::TextureFormat::Rgba8Unorm);
    let mask_view = mask.create_view(&Default::default());
    let selected_depth_view = selected_depth.create_view(&Default::default());
    let scene_depth_view = scene_depth.create_view(&Default::default());
    pass.rebind(
        device,
        Some((&mask_view, &selected_depth_view, &scene_depth_view)),
    );
    let row_bytes = 256;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("outline test readback"),
        size: u64::from(row_bytes * HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    clear_depth(&mut encoder, &selected_depth, selected_depth_value);
    clear_depth(&mut encoder, &scene_depth, scene_depth_value);
    {
        let view = target.create_view(&Default::default());
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })];
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("outline baseline clear"),
            color_attachments: &attachments,
            ..Default::default()
        }));
    }
    pass.draw(&mut encoder, &target.create_view(&Default::default()));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(HEIGHT),
            },
        },
        target.size(),
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = std::sync::mpsc::channel();
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        sender.send(result).unwrap()
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let mapped = readback.get_mapped_range(..).unwrap();
    let pixels = mapped
        .chunks_exact(row_bytes as usize)
        .flat_map(|row| row[..(WIDTH * 4) as usize].iter().copied())
        .collect();
    drop(mapped);
    readback.unmap();
    pixels
}

fn selected_mask() -> Vec<u8> {
    let mut mask = vec![0_u8; (WIDTH * HEIGHT) as usize];
    for y in 2..6 {
        for x in 3..7 {
            mask[(y * WIDTH + x) as usize] = 255;
        }
    }
    mask
}

#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn visible_hidden_and_unselected_pixels_match_web_outline_semantics() {
    let (device, queue) = gpu();
    let visible = render(&device, &queue, &selected_mask(), 0.4, 0.6);
    let hidden = render(&device, &queue, &selected_mask(), 0.4, 0.2);
    let transparent_mask: Vec<u8> = selected_mask()
        .into_iter()
        .map(|coverage| if coverage == 0 { 0 } else { 64 })
        .collect();
    let transparent = render(&device, &queue, &transparent_mask, 0.4, 0.6);
    let pixel = |pixels: &[u8], x: u32, y: u32| -> [u8; 4] {
        let i = ((y * WIDTH + x) * 4) as usize;
        pixels[i..i + 4].try_into().unwrap()
    };
    let visible_edge = pixel(&visible, 2, 3);
    let hidden_edge = pixel(&hidden, 2, 3);
    let transparent_edge = pixel(&transparent, 2, 3);
    assert!(
        visible_edge[2] > hidden_edge[2] + 50,
        "visible edge must keep Web's brighter blue"
    );
    assert!(
        hidden_edge[2] > 100,
        "occluded selected edge must retain the hidden-edge blue"
    );
    assert!(
        transparent_edge[2] > 0 && transparent_edge[2] < visible_edge[2],
        "selected transparent coverage must attenuate, not replace, the background"
    );
    assert_eq!(
        pixel(&visible, 13, 3),
        [0, 0, 0, 255],
        "unselected second-object region must remain untouched"
    );
    assert_eq!(
        pixel(&hidden, 13, 3),
        [0, 0, 0, 255],
        "hidden-edge classification must not create a global outline"
    );
}

#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn scenes_without_outlines_allocate_no_mask_or_selected_depth_targets() {
    let (device, _queue) = gpu();
    let plain = ForwardTargets::new(&device, PhysicalSize::new(WIDTH, HEIGHT), false);
    assert!(
        plain.outline.is_none(),
        "default scenes must not pay R8/depth attachment bandwidth"
    );
    let outlined = ForwardTargets::new(&device, PhysicalSize::new(WIDTH, HEIGHT), true);
    assert!(
        outlined.outline.is_some(),
        "authored outlines allocate their dedicated targets"
    );
}

#[test]
#[ignore = "requires hardware GPU; run explicitly with --ignored"]
fn production_object_mask_pipeline_compiles_with_one_r8_attachment() {
    let (device, _queue) = gpu();
    let frame = frame_bindings::create_frame_layouts(&device);
    let texture = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    };
    let sampler = |binding| wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
        count: None,
    };
    let material = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("outline test production material layout"),
        entries: &[
            texture(0),
            sampler(1),
            texture(2),
            sampler(3),
            wgpu::BindGroupLayoutEntry {
                binding: 4,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(
                        deep_engine_native::mesh_abi::MATERIAL_UNIFORM_BYTES,
                    ),
                },
                count: None,
            },
            texture(5),
            sampler(6),
            texture(7),
            sampler(8),
            texture(9),
            sampler(10),
        ],
    });
    let shader = frame_bindings::create_native_mesh_shader(&device);
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let pipelines = OutlineMaskPipelines::new(&device, &frame.frame, &material, &shader);
    assert_eq!(pipelines.raw().len(), 3);
    assert!(pollster::block_on(scope.pop()).is_none());
}
