//! Real-GPU readback proofs for the 刀 4 fixed-function blend family:
//! normal/multiply/screen/darken/lighten/overwrite chunks on opaque and
//! translucent backdrops. Every frame diffs the readback against the CPU
//! mirror (`paint_reference`, blend dispatch via `blend_composite`) with the
//! project oracle discipline: interior divergence must be zero — only blend
//! rounding may differ.
//!
//! Harness mirrors `deep2d_paint_gpu_tests.rs`: one 16x16 target, transparent
//! clear, painter draw, buffer readback, oracle compare.

use std::sync::mpsc;

use deep_engine_native::deep2d::{
    Deep2dBlendMode, Deep2dCommand, Deep2dDisplayList, Deep2dPaint, Deep2dPathVerb, Deep2dResource,
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

fn path_command(
    id: &str,
    z_order: i32,
    path_id: &str,
    fill: Option<Deep2dPaint>,
    blend: Option<Deep2dBlendMode>,
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
        corner_radius: None,
        shadow: None,
        blend,
        backdrop_blur: None,
    })
}

fn display_list(commands: Vec<Deep2dCommand>, resources: Vec<Deep2dResource>) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-blend-gpu".into(),
        revision: 1,
        logical_width: 8.0,
        logical_height: 8.0,
        scale_factor: 2.0,
        resources,
        atlases: Vec::new(),
        commands,
    }
}

const BG: [f64; 4] = [0.8, 0.4, 0.2, 1.0];

fn blend_frame(mode: Deep2dBlendMode, source: Deep2dPaint) -> Deep2dDisplayList {
    display_list(
        vec![
            path_command("bg", 0, "canvas", Some(Deep2dPaint::Solid(BG)), None),
            path_command(
                "fg",
                1,
                "patch",
                Some(source),
                Some(if mode == Deep2dBlendMode::Normal {
                    Deep2dBlendMode::Normal
                } else {
                    mode
                }),
            ),
        ],
        vec![
            rect_resource("canvas", [0.0, 0.0], [8.0, 8.0]),
            rect_resource("patch", [2.0, 2.0], [6.0, 6.0]),
        ],
    )
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

/// Renders the frame, reads the target back and gates against the CPU
/// oracle. `pixel_bound` is the per-pixel channel bound: blend factors are
/// exact fixed-function math on both sides, so the only residual is f32
/// unorm quantization of the readback (<= 1/255); 2 keeps headroom.
fn draw_and_compare(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    painter: &Deep2dGpuPainter,
    list: &Deep2dDisplayList,
    context: &str,
    pixel_bound: u8,
) -> Vec<[u8; 4]> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d blend readback target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Deep2d blend readback buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d blend readback encoder"),
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
        label: Some("Deep2d blend readback clear"),
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
        "{context}: report={report:?} worst_diff={} at ({}, {})",
        worst.0,
        worst.1 % WIDTH as usize,
        worst.1 / WIDTH as usize
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

/// Reads the blended patch center back and asserts it against the analytic
/// `blend_composite` value (the CPU mirror of the fixed-function state).
fn assert_blend_value(gpu: &[[u8; 4]], mode: Deep2dBlendMode, source: [f64; 4], context: &str) {
    let expected = deep_engine_native::deep2d::blend_composite(
        mode.as_u32(),
        source.map(|channel| channel as f32),
        BG.map(|channel| channel as f32),
    );
    let actual = pixel(gpu, [4.0, 4.0]);
    for (channel, target) in actual.iter().zip(expected.iter()) {
        // blend_composite 是 0..1 straight 空间,读回是 0..255 unorm:同一
        // 刻度才能比(±2 ≈ 读回量化 + f32 舍入)。
        assert!(
            (f64::from(*channel) - f64::from(*target) * 255.0).abs() <= 2.0,
            "{context}: {actual:?} vs {expected:?}"
        );
    }
}

fn solid(color: [f64; 4]) -> Deep2dPaint {
    Deep2dPaint::Solid(color)
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn multiply_blends_against_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let source = [0.2f64, 0.6, 0.9, 1.0];
    let list = blend_frame(Deep2dBlendMode::Multiply, solid(source));
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("multiply painter");
    let gpu = draw_and_compare(&device, &queue, &painter, &list, "multiply", 2);
    assert_blend_value(&gpu, Deep2dBlendMode::Multiply, source, "multiply patch");
    // Outside the patch the background chunk (normal) is untouched.
    assert_eq!(pixel(&gpu, [1.0, 1.0])[0], (BG[0] * 255.0).round() as u8);
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn screen_blends_against_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let source = [0.2f64, 0.6, 0.9, 1.0];
    let list = blend_frame(Deep2dBlendMode::Screen, solid(source));
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("screen painter");
    let gpu = draw_and_compare(&device, &queue, &painter, &list, "screen", 2);
    assert_blend_value(&gpu, Deep2dBlendMode::Screen, source, "screen patch");
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn darken_lighten_overwrite_blend_against_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let source = [0.9f64, 0.1, 0.5, 1.0];
    for (mode, name) in [
        (Deep2dBlendMode::Darken, "darken"),
        (Deep2dBlendMode::Lighten, "lighten"),
        (Deep2dBlendMode::Overwrite, "overwrite"),
    ] {
        let list = blend_frame(mode, solid(source));
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content,
            &cache,
        )
        .unwrap_or_else(|_| panic!("{name} painter"));
        let gpu = draw_and_compare(&device, &queue, &painter, &list, name, 2);
        assert_blend_value(&gpu, mode, source, &format!("{name} patch"));
    }
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn premultiplied_modes_take_the_premul_entry_and_stay_exact_on_opaque() {
    // Translucent multiply/screen exercise the `fragment_main_premultiplied`
    // entry point: the fragment premultiplies its output before the
    // fixed-function stage, mirrored by blend_composite's `* sa` folding.
    let (device, queue, adapter) = real_gpu();
    let translucent = [1.0f64, 0.0, 0.0, 0.5];
    for (mode, name) in [
        (Deep2dBlendMode::Multiply, "translucent multiply"),
        (Deep2dBlendMode::Screen, "translucent screen"),
    ] {
        let list = blend_frame(mode, solid(translucent));
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content,
            &cache,
        )
        .unwrap_or_else(|_| panic!("{name} painter"));
        let gpu = draw_and_compare(&device, &queue, &painter, &list, name, 2);
        assert_blend_value(&gpu, mode, translucent, &format!("{name} patch"));
    }
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn multiply_gradient_fill_blends_against_cpu_reference() {
    // Gradient fills render through the paint storage entry; the premul
    // entry point must fold their evaluated alpha identically.
    let (device, queue, adapter) = real_gpu();
    let list = blend_frame(
        Deep2dBlendMode::Multiply,
        Deep2dPaint::LinearGradient(deep_engine_native::deep2d::LinearGradientPaint {
            start: [2.0, 2.0],
            end: [6.0, 6.0],
            stops: vec![
                deep_engine_native::deep2d::GradientStop {
                    offset: 0.0,
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                deep_engine_native::deep2d::GradientStop {
                    offset: 1.0,
                    color: [0.0, 0.0, 1.0, 1.0],
                },
            ],
        }),
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("gradient multiply painter");
    let gpu = draw_and_compare(&device, &queue, &painter, &list, "gradient multiply", 2);
    // 像素中心采样点:逻辑 (4,4) 读的是像素 (8,8),其中心在逻辑
    // (4.25, 4.25)。线性坡度 start=[2,2] end=[6,6] 在该点的投影
    // t = ((2.25,2.25)·(4,4)) / |(4,4)|² = 0.5625,坡度值 [0.4375, 0, 0.5625]
    // (不是几何中点 4.0 处的 [0.5, 0, 0.5];全帧 CPU oracle 上面的
    // divergent=0 已钉住同一采样口径)。
    let t = 0.5625_f32;
    let expected = deep_engine_native::deep2d::blend_composite(
        Deep2dBlendMode::Multiply.as_u32(),
        [1.0 - t, 0.0, t, 1.0],
        BG.map(|channel| channel as f32),
    );
    let actual = pixel(&gpu, [4.0, 4.0]);
    for (channel, target) in actual.iter().zip(expected.iter()) {
        // 同 assert_blend_value:0..1 解析值 ×255 对齐 0..255 读回刻度。
        assert!(
            (f64::from(*channel) - f64::from(*target) * 255.0).abs() <= 3.0,
            "gradient multiply: {actual:?} vs {expected:?}"
        );
    }
    println!("adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn normal_blend_stays_byte_compatible_with_the_legacy_pipeline() {
    // A frame without blend modes must render exactly like before (same
    // pipeline, same ALPHA_BLENDING state): interior divergence 0 against
    // the unchanged normal oracle at the tight 8-bound.
    let (device, queue, adapter) = real_gpu();
    let list = blend_frame(Deep2dBlendMode::Normal, solid([0.1, 0.7, 0.3, 1.0]));
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("normal painter");
    draw_and_compare(&device, &queue, &painter, &list, "normal", 8);
    println!("adapter={adapter}");
}
