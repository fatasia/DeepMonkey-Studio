//! Real-GPU readback proof for the 刀 4 frosted-glass backdrop blur: a
//! striped background, a rounded glass rect over it, and the full-frame diff
//! against the CPU mirror (`paint_reference::rasterize_backdrop_chunk`, which
//! shares `backdrop_capture_region` and the exact blur kernel with the WGSL).
//!
//! 容差依据(对拍容差,逐级实测口径):每级存储 Rgba8Unorm 量化 ≤1/255
//! (GPU rne 与 CPU round-half-up 仅在精确 .5 处差 1),下采样 1 级 + 扫
//! ≤4 级 + 双线性 1 级 + 最终混合 1 级,最坏线性叠加 ≈6/255;门取 8,
//! 内部分歧(interior)必须为 0。
//!
//! Harness mirrors `deep2d_paint_gpu_tests.rs`.

use std::sync::mpsc;

use deep_engine_native::deep2d::{
    BackdropBlur, Deep2dCommand, Deep2dDisplayList, Deep2dPaint, Deep2dPathVerb, Deep2dResource,
    Deep2dRuntimeContent, PathCommand, PathResource, compare, prepare_display_list,
    rasterize_prepared,
};

use crate::deep2d_gpu::Deep2dGpuPainter;

const WIDTH: u32 = 16;
const HEIGHT: u32 = 16;
const ROW_BYTES: u32 = 256;

fn rect_resource(id: &str, min: [f64; 2], max: [f64; 2]) -> Deep2dResource {
    Deep2dResource::Path(PathResource {
        id: id.into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move {
                x: min[0],
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: max[0],
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: max[0],
                y: max[1],
            },
            Deep2dPathVerb::Line {
                x: min[0],
                y: max[1],
            },
            Deep2dPathVerb::Close,
        ],
    })
}

#[allow(clippy::too_many_arguments)]
fn path_command(
    id: &str,
    z_order: i32,
    path_id: &str,
    fill: Option<Deep2dPaint>,
    corner_radius: Option<f64>,
    backdrop_blur: Option<BackdropBlur>,
) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: id.into(),
        z_order,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        path_id: path_id.into(),
        fill,
        fill_rule: None,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
        corner_radius,
        shadow: None,
        blend: None,
        backdrop_blur,
    })
}

fn glass_frame(blur_radius: f64) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-backdrop-gpu".into(),
        revision: 1,
        logical_width: 8.0,
        logical_height: 8.0,
        scale_factor: 2.0,
        resources: vec![
            rect_resource("canvas", [0.0, 0.0], [8.0, 8.0]),
            rect_resource("left", [0.0, 0.0], [4.0, 8.0]),
            rect_resource("right", [4.0, 0.0], [8.0, 8.0]),
            rect_resource("glass", [2.0, 2.0], [6.0, 6.0]),
        ],
        atlases: Vec::new(),
        commands: vec![
            // Red left half, blue right half: a high-contrast backdrop whose
            // blur mixture is analytically checkable.
            path_command(
                "bg-left",
                0,
                "left",
                Some(Deep2dPaint::Solid([0.9, 0.1, 0.1, 1.0])),
                None,
                None,
            ),
            path_command(
                "bg-right",
                0,
                "right",
                Some(Deep2dPaint::Solid([0.1, 0.1, 0.9, 1.0])),
                None,
                None,
            ),
            // The frosted glass: pure backdrop command (no fill/stroke), box
            // mask via cornerRadius, radius 8 => 4 blur sweeps.
            path_command(
                "glass",
                1,
                "glass",
                None,
                Some(2.0),
                Some(BackdropBlur {
                    radius: blur_radius,
                }),
            ),
        ],
    }
}

fn real_gpu() -> (wgpu::Device, wgpu::Queue, String) {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                ..Default::default()
            })
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "software adapter");
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();
        (device, queue, info.name)
    })
}

fn draw_and_compare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    painter: &Deep2dGpuPainter,
    list: &Deep2dDisplayList,
    context: &str,
    pixel_bound: u8,
) -> Vec<[u8; 4]> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d backdrop readback target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        // COPY_SRC is required for the backdrop capture chain AND the readback.
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep2d backdrop readback buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d backdrop readback encoder"),
    });
    let clear = [Some(wgpu::RenderPassColorAttachment {
        view: &view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            store: wgpu::StoreOp::Store,
        },
    })];
    drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("Deep2d backdrop readback clear"),
        color_attachments: &clear,
        depth_stencil_attachment: None,
        ..Default::default()
    }));
    painter.draw(&mut encoder, &view, (WIDTH, HEIGHT));
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &target,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ROW_BYTES),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );
    queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    readback.map_async(wgpu::MapMode::Read, .., move |result| {
        let _ = sender.send(result);
    });
    device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    receiver.recv().unwrap().unwrap();
    let bytes = readback.get_mapped_range(..).unwrap().to_vec();
    readback.unmap();
    let gpu = (0..HEIGHT as usize)
        .flat_map(|y| (0..WIDTH as usize).map(move |x| (x, y)))
        .map(|(x, y)| {
            let offset = y * ROW_BYTES as usize + x * 4;
            bytes[offset..offset + 4].try_into().unwrap()
        })
        .collect::<Vec<[u8; 4]>>();
    let prepared = prepare_display_list(list).expect("oracle prepare");
    let reference = rasterize_prepared([8.0, 8.0], [WIDTH, HEIGHT], &prepared);
    let report = compare(&reference, &gpu, WIDTH, HEIGHT, 8);
    let mut worst = (0u8, 0usize);
    for (index, (reference_pixel, gpu_pixel)) in reference.iter().zip(gpu.iter()).enumerate() {
        let diff = reference_pixel
            .iter()
            .zip(gpu_pixel.iter())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        if diff > worst.0 {
            worst = (diff, index);
        }
    }
    println!(
        "{context}: report={report:?} worst_diff={} at ({}, {}) gpu={:?} ref={:?}",
        worst.0,
        worst.1 % WIDTH as usize,
        worst.1 / WIDTH as usize,
        gpu[worst.1],
        reference[worst.1]
    );
    assert_eq!(
        report.divergent, 0,
        "{context}: interior divergence {report:?}"
    );
    assert!(worst.0 <= pixel_bound, "{context}: max diff {}", worst.0);
    gpu
}

fn pixel(gpu: &[[u8; 4]], logical: [f64; 2]) -> [u8; 4] {
    let x = (logical[0] * 2.0) as usize;
    let y = (logical[1] * 2.0) as usize;
    gpu[y * WIDTH as usize + x]
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn frosted_glass_matches_cpu_blur_oracle() {
    let (device, queue, adapter) = real_gpu();
    let list = glass_frame(8.0);
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("backdrop painter");
    assert_eq!(painter.summary.path.backdrop_commands, 1);
    let gpu = draw_and_compare(&device, &queue, &painter, &list, "glass r8", 8);
    // The glass covers the red/blue seam: the blurred center must be a MIX
    // of both stripes — clearly neither pure red nor pure blue.
    let center = pixel(&gpu, [4.0, 4.0]);
    assert!(
        center[0] > 60 && center[2] > 60,
        "glass center must mix both stripes: {center:?}"
    );
    // Outside the glass the background stripes are untouched. GPU unorm
    // 存储在精确 .5 处的舍入与 CPU round-half-up 可能差 1(实测 DX12 下
    // 0.9 存为 229),容差 ±1。
    let expected = (0.9_f64 * 255.0).round() as i32;
    assert!(
        (i32::from(pixel(&gpu, [1.0, 4.0])[0]) - expected).abs() <= 1,
        "left stripe must stay untouched"
    );
    assert!(
        (i32::from(pixel(&gpu, [7.0, 4.0])[2]) - expected).abs() <= 1,
        "right stripe must stay untouched"
    );
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn single_sweep_glass_matches_cpu_blur_oracle() {
    // radius 2 => 1 iteration (clamped minimum); exercises the shortest
    // capture chain and the region-size-miss rebuild path of the chain cache.
    let (device, queue, adapter) = real_gpu();
    let list = glass_frame(2.0);
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("backdrop painter");
    let gpu = draw_and_compare(&device, &queue, &painter, &list, "glass r2", 8);
    let center = pixel(&gpu, [4.0, 4.0]);
    assert!(
        center[0] > 60 && center[2] > 60,
        "glass center must mix both stripes: {center:?}"
    );
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn two_glass_panels_bracket_in_draw_order() {
    // Two glass commands on one frame: the capture chain must re-run per
    // command (the second glass blurs the FIRST glass' output region too —
    // stacked translucency), and both brackets stay in draw order.
    let (device, queue, adapter) = real_gpu();
    let mut list = glass_frame(4.0);
    list.resources
        .push(rect_resource("glass2", [5.0, 5.0], [8.0, 8.0]));
    list.commands.push(path_command(
        "glass-2",
        2,
        "glass2",
        None,
        Some(2.0),
        Some(BackdropBlur { radius: 4.0 }),
    ));
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("backdrop painter");
    assert_eq!(painter.summary.path.backdrop_commands, 2);
    draw_and_compare(&device, &queue, &painter, &list, "glass x2", 8);
    println!("adapter={adapter}");
}
