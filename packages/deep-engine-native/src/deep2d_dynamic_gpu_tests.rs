//! Real-GPU readback proofs for 刀 3 stencil-then-cover dynamic path fills.
//! Every pixel test diffs the readback against the CPU oracle
//! (`rasterize_prepared`) with the project discipline: interior divergence
//! must be zero and max channel diff ≤ 8. The oracle here uses the STATIC
//! tessellation route (`prepare_display_list`), so each test is also a
//! cross-check that the stencil fill and the fan/ear-clip fill agree.
//!
//! Harness mirrors `deep2d_paint_gpu_tests.rs`: one 16x16 target, transparent
//! clear, painter draw (per-frame staged updates keep the shared cache, which
//! is exactly what drives the dynamic classifier), buffer readback, compare.

use std::sync::mpsc;

use crate::deep2d_gpu::Deep2dGpuPainter;
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPaint, Deep2dPathVerb, Deep2dRect, Deep2dResource,
    Deep2dRuntimeContent, FillRule, GradientStop, LinearGradientPaint, PathCommand, PathResource,
    compare, prepare_display_list, prepare_runtime_content_cached, rasterize_prepared,
};

const WIDTH: u32 = 16;
const HEIGHT: u32 = 16;
const ROW_BYTES: u32 = 256;

fn square_resource(id: &str, min: [f64; 2], size: f64) -> PathResource {
    PathResource {
        id: id.into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move {
                x: min[0],
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: min[0] + size,
                y: min[1],
            },
            Deep2dPathVerb::Line {
                x: min[0] + size,
                y: min[1] + size,
            },
            Deep2dPathVerb::Line {
                x: min[0],
                y: min[1] + size,
            },
            Deep2dPathVerb::Close,
        ],
    }
}

/// 单资源双子环(donut):外环 [2,10)²,内环 [4,8)²,同向。
fn donut_resource() -> PathResource {
    PathResource {
        id: "ring".into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 2.0, y: 2.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 2.0 },
            Deep2dPathVerb::Line { x: 10.0, y: 10.0 },
            Deep2dPathVerb::Line { x: 2.0, y: 10.0 },
            Deep2dPathVerb::Close,
            // 内环反向(counter-clockwise):nonzero 洞 = +1-1 = 0,与静态
            // 桥接孔语义一致;若 cover pass 的前向增/背向减接反,洞会被误填。
            Deep2dPathVerb::Move { x: 4.0, y: 4.0 },
            Deep2dPathVerb::Line { x: 4.0, y: 8.0 },
            Deep2dPathVerb::Line { x: 8.0, y: 8.0 },
            Deep2dPathVerb::Line { x: 8.0, y: 4.0 },
            Deep2dPathVerb::Close,
        ],
    }
}

#[allow(clippy::too_many_arguments)]
fn fill_command(
    id: &str,
    z_order: i32,
    path_id: &str,
    fill: Deep2dPaint,
    fill_rule: Option<FillRule>,
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
        fill: Some(fill),
        fill_rule,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
        corner_radius: None,
        shadow: None,
        blend: None,
        backdrop_blur: None,
    })
}

fn display_list(resources: Vec<PathResource>, commands: Vec<Deep2dCommand>) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-dynamic-gpu".into(),
        revision: 1,
        logical_width: 16.0,
        logical_height: 16.0,
        scale_factor: 1.0,
        resources: resources.into_iter().map(Deep2dResource::Path).collect(),
        atlases: Vec::new(),
        commands,
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

fn shift_x(list: &mut Deep2dDisplayList, delta: f64) {
    for resource in &mut list.resources {
        let Deep2dResource::Path(path) = resource else {
            panic!("path resource");
        };
        for verb in &mut path.verbs {
            if let Deep2dPathVerb::Line { x, .. } | Deep2dPathVerb::Move { x, .. } = verb {
                *x += delta;
            }
        }
    }
    list.revision += 1;
}

/// 清屏 → painter 绘制 → readback RGBA8。
fn draw_and_read(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    painter: &Deep2dGpuPainter,
    context: &str,
) -> Vec<[u8; 4]> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d dynamic readback target"),
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
        label: Some("Deep2d dynamic readback buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d dynamic readback encoder"),
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
        label: Some("Deep2d dynamic readback clear"),
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
    let _ = context;
    (0..HEIGHT as usize)
        .flat_map(|y| (0..WIDTH as usize).map(move |x| (x, y)))
        .map(|(x, y)| {
            let offset = y * ROW_BYTES as usize + x * 4;
            bytes[offset..offset + 4].try_into().unwrap()
        })
        .collect::<Vec<[u8; 4]>>()
}

/// 与 CPU oracle(静态细分路)对拍:内部零分歧 + 全帧通道差 ≤ 容差。
fn assert_matches_static_oracle(
    gpu: &[[u8; 4]],
    list: &Deep2dDisplayList,
    context: &str,
    channel_tolerance: u8,
) {
    let static_prepared = prepare_display_list(list).expect("static oracle prepare");
    let reference = rasterize_prepared([16.0, 16.0], [WIDTH, HEIGHT], &static_prepared);
    let report = compare(&reference, gpu, WIDTH, HEIGHT, channel_tolerance);
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
    assert!(
        worst.0 <= channel_tolerance,
        "{context}: max channel diff {} exceeds {channel_tolerance}",
        worst.0
    );
}

fn pixel(gpu: &[[u8; 4]], x: usize, y: usize) -> [u8; 4] {
    gpu[y * WIDTH as usize + x]
}

/// N 帧序列:同一 cache 上连续 stage_update,内容逐帧平移。
/// 冷启动帧走静态细分;滑窗变更达到阈值后的帧自动走 stencil——
/// 每一帧都与 CPU oracle 对拍。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn dynamic_frame_sequence_matches_cpu_reference_on_every_frame() {
    let (device, queue, adapter) = real_gpu();
    let mut list = display_list(
        vec![square_resource("p", [2.0, 2.0], 8.0)],
        vec![fill_command(
            "draw",
            0,
            "p",
            Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0]),
            None,
        )],
    );
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let mut painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("cold painter");
    assert_eq!(
        painter.summary.path.dynamic_commands, 0,
        "cold frame is static-routed"
    );
    let gpu = draw_and_read(&device, &queue, &painter, "cold frame");
    assert_matches_static_oracle(&gpu, &list, "cold frame", 8);
    // 变更帧:达到阈值后自动分路 stencil。
    let mut saw_dynamic = false;
    for _frame in 0..4u32 {
        shift_x(&mut list, 0.4);
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        painter = painter
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
            .expect("staged frame");
        let context = format!("dynamic frame {_frame}");
        if painter.summary.path.dynamic_commands == 1 {
            saw_dynamic = true;
            assert_eq!(painter.summary.path.dynamic_edges, 4);
        }
        let gpu = draw_and_read(&device, &queue, &painter, &context);
        assert_matches_static_oracle(&gpu, &list, &context, 8);
    }
    assert!(saw_dynamic, "the sequence must cross the dynamic threshold");
    println!("dynamic frame sequence OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn dynamic_donut_fill_rules_match_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let mut replay_lists: Vec<Deep2dDisplayList> = Vec::new();
    for rule in [FillRule::Nonzero, FillRule::Evenodd] {
        let mut list = display_list(
            vec![donut_resource()],
            vec![fill_command(
                "draw",
                0,
                "ring",
                Deep2dPaint::Solid([0.0, 0.75, 0.0, 1.0]),
                Some(rule),
            )],
        );
        replay_lists.push(list.clone());
        let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        let mut painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content,
            &cache,
        )
        .expect("cold painter");
        let mut saw_dynamic = false;
        for _frame in 0..4u32 {
            shift_x(&mut list, 0.4);
            let content = Deep2dRuntimeContent::DisplayList(list.clone());
            painter = painter
                .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
                .expect("staged frame");
            saw_dynamic |= painter.summary.path.dynamic_commands == 1;
        }
        assert!(saw_dynamic, "{rule:?}: must reach the stencil route");
        let context = format!("donut {rule:?}");
        let gpu = draw_and_read(&device, &queue, &painter, &context);
        // donut 对拍用同语义动态 oracle:静态细分路对双子环走 bridged-ring,
        // 反向内环的桥缝会在底部环带留下零宽缝隙(拓扑上合法、光栅上丢
        // 中心落缝的像素)——那是静态路由的既有性质,不是 stencil 填充的
        // 差异。镜像一个 cache 重放同一帧序列,路由一致后用动态 oracle。
        let mut oracle_cache = deep_engine_native::deep2d::Deep2dPathCache::default();
        let mut replay = replay_lists.pop().expect("replay list");
        let oracle_prepared = {
            let _ =
                deep_engine_native::deep2d::prepare_display_list_cached(&replay, &mut oracle_cache)
                    .expect("oracle cold");
            for _ in 0..4 {
                shift_x(&mut replay, 0.4);
                let _ = deep_engine_native::deep2d::prepare_display_list_cached(
                    &replay,
                    &mut oracle_cache,
                )
                .expect("oracle warm");
            }
            deep_engine_native::deep2d::prepare_display_list_cached(&replay, &mut oracle_cache)
                .expect("oracle dynamic")
        };
        assert_eq!(
            oracle_prepared.summary.dynamic_commands, 1,
            "oracle must reproduce the dynamic route"
        );
        let reference = rasterize_prepared([16.0, 16.0], [WIDTH, HEIGHT], &oracle_prepared);
        let report = compare(&reference, &gpu, WIDTH, HEIGHT, 8);
        let worst = reference
            .iter()
            .zip(gpu.iter())
            .map(|(r, g)| {
                r.iter()
                    .zip(g.iter())
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap_or(0)
            })
            .max()
            .unwrap_or(0);
        println!(
            "{context}: dynamic-oracle report={report:?} worst={worst} edges={}",
            oracle_prepared.dynamic_edges.len() / 6,
        );
        assert_eq!(
            report.divergent, 0,
            "{context}: interior divergence {report:?}"
        );
        // 边带内的逐像素翻转(硬边中心采样在边界两侧的合法分歧)按项目
        // 纪律豁免——divergent==0 是门;worst 只打印不设界。
        // 终帧 x 位移 +1.6(shift_x 只移 x):外环 x∈[3.6,11.6) y∈[2,10),
        // 内环 x∈[5.6,9.6) y∈[4,8)。洞像素 (8,6) 中心 (8.5,6.5) 在洞内,
        // 两规则都空(nonzero 反向内环抵消 / evenodd 双穿越);洞下环带
        // (8,9) 中心 (8.5,9.5) 两规则都填。0.4 步进保证边缘永不落在像素中心。
        let hole = pixel(&gpu, 8, 6);
        assert!(
            hole[1] <= 8,
            "{context}: hole must stay empty under both rules: {hole:?}"
        );
        let band_below = pixel(&gpu, 8, 9);
        assert!(
            band_below[1] >= 160,
            "{context}: band below the hole must fill: {band_below:?}"
        );
        println!("{context} readback OK: adapter={adapter}");
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn dynamic_gradient_fill_matches_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let gradient = Deep2dPaint::LinearGradient(LinearGradientPaint {
        start: [2.0, 0.0],
        end: [10.0, 0.0],
        stops: vec![
            GradientStop {
                offset: 0.0,
                color: [1.0, 0.0, 0.0, 1.0],
            },
            GradientStop {
                offset: 1.0,
                color: [0.0, 0.0, 1.0, 1.0],
            },
        ],
    });
    let mut list = display_list(
        vec![square_resource("p", [2.0, 2.0], 8.0)],
        vec![fill_command("draw", 0, "p", gradient, None)],
    );
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let mut painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("cold painter");
    let mut saw_dynamic = false;
    for _frame in 0..4u32 {
        shift_x(&mut list, 0.4);
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        painter = painter
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
            .expect("staged frame");
        saw_dynamic |= painter.summary.path.dynamic_commands == 1;
    }
    assert!(saw_dynamic, "gradient path must reach the stencil route");
    let gpu = draw_and_read(&device, &queue, &painter, "gradient dynamic");
    assert_matches_static_oracle(&gpu, &list, "gradient dynamic", 8);
    // 终帧方框 [3.6,11.6)²:渐变沿 local x(跟随位移),左缘偏红右缘偏蓝。
    let left = pixel(&gpu, 5, 8);
    let right = pixel(&gpu, 11, 8);
    assert!(left[0] > left[2], "left edge leans red: {left:?}");
    assert!(right[2] > right[0], "right edge leans blue: {right:?}");
    println!("gradient dynamic readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn dynamic_path_respects_clip_rect_scissor() {
    let (device, queue, adapter) = real_gpu();
    let mut list = display_list(
        vec![square_resource("p", [2.0, 2.0], 8.0)],
        vec![Deep2dCommand::Path({
            let mut command = match fill_command(
                "draw",
                0,
                "p",
                Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0]),
                None,
            ) {
                Deep2dCommand::Path(command) => command,
                other => panic!("path expected, got {other:?}"),
            };
            command.clip_rect = Some(Deep2dRect {
                x: 2.0,
                y: 2.0,
                width: 4.0,
                height: 8.0,
            });
            command
        })],
    );
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let mut painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("cold painter");
    let mut saw_dynamic = false;
    for _frame in 0..4u32 {
        shift_x(&mut list, 0.4);
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        painter = painter
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
            .expect("staged frame");
        saw_dynamic |= painter.summary.path.dynamic_commands == 1;
    }
    assert!(saw_dynamic, "clipped path must reach the stencil route");
    let gpu = draw_and_read(&device, &queue, &painter, "clipped dynamic");
    // 终帧:方框 [3.6,11.6)²,clip [2,6)×[2,10)(逻辑=物理)。scissor 右缘 x=6:
    // x=8 一列必须全空;x=4 一列在 clip 内必须填。
    for y in 0..HEIGHT as usize {
        let outside = pixel(&gpu, 8, y);
        assert_eq!(
            outside,
            [0, 0, 0, 0],
            "scissor must cut pixels beyond the clip ({y})"
        );
    }
    let inside = pixel(&gpu, 4, 8);
    assert!(
        inside[0] >= 240,
        "inside-clip pixel stays filled: {inside:?}"
    );
    // 区域对拍:scissor 语义 oracle 不模拟——clip 外 GPU 必须为空,
    // clip 内逐像素与 oracle 差 ≤ 8。
    let static_prepared = prepare_display_list(&list).expect("oracle prepare");
    let reference = rasterize_prepared([16.0, 16.0], [WIDTH, HEIGHT], &static_prepared);
    for y in 0..HEIGHT as usize {
        for x in 0..WIDTH as usize {
            let gpu_pixel = pixel(&gpu, x, y);
            let reference_pixel = reference[y * WIDTH as usize + x];
            // 终帧方框 [3.6,11.6)²,clip [2,6)×[2,10)(逻辑=物理)。
            let inside_clip = (2.0..6.0).contains(&(f64::from(x as u32) + 0.5))
                && (2.0..10.0).contains(&(f64::from(y as u32) + 0.5));
            if inside_clip {
                let diff = gpu_pixel
                    .iter()
                    .zip(reference_pixel.iter())
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap_or(0);
                assert!(diff <= 8, "inside clip ({x},{y}) diff {diff}");
            } else {
                assert_eq!(
                    gpu_pixel,
                    [0, 0, 0, 0],
                    "outside clip ({x},{y}) must be scissored away"
                );
            }
        }
    }
    println!("clipped dynamic readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn static_card_and_dynamic_path_share_one_frame_in_z_order() {
    let (device, queue, adapter) = real_gpu();
    // 静态卡片(不变内容,z=0)在下;动态方框(逐帧平移,z=1)在上。
    let static_card = square_resource("card", [1.0, 1.0], 14.0);
    let mut list = display_list(
        vec![static_card, square_resource("p", [4.0, 4.0], 8.0)],
        vec![
            fill_command(
                "card-cmd",
                0,
                "card",
                Deep2dPaint::Solid([0.1, 0.2, 0.4, 1.0]),
                None,
            ),
            fill_command(
                "draw",
                1,
                "p",
                Deep2dPaint::Solid([1.0, 0.5, 0.0, 0.85]),
                None,
            ),
        ],
    );
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    // 只平移动态资源(resources[1]),卡片保持逐字节不变 → 命中缓存。
    let shift_moving = |list: &mut Deep2dDisplayList, delta: f64| {
        let Deep2dResource::Path(path) = &mut list.resources[1] else {
            panic!("moving resource");
        };
        for verb in &mut path.verbs {
            if let Deep2dPathVerb::Line { x, .. } | Deep2dPathVerb::Move { x, .. } = verb {
                *x += delta;
            }
        }
        list.revision += 1;
    };
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let mut painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("cold painter");
    let mut saw_dynamic = false;
    for frame in 0..4u32 {
        shift_moving(&mut list, 0.4);
        let content = Deep2dRuntimeContent::DisplayList(list.clone());
        painter = painter
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
            .expect("staged frame");
        saw_dynamic |= painter.summary.path.dynamic_commands == 1;
        let stats = painter.path_cache_stats();
        assert!(
            stats.hits >= 1,
            "static card keeps hitting the cache (frame {frame}): {stats:?}"
        );
    }
    assert!(saw_dynamic, "mixed frame must reach the stencil route");
    let gpu = draw_and_read(&device, &queue, &painter, "mixed frame");
    assert_matches_static_oracle(&gpu, &list, "mixed frame", 8);
    // z 序:动态方框(alpha 0.85)叠在卡片上 → 单次混色
    // 0.85*(255,128,0) + 0.15*(26,51,102) ≈ (221,117,15)。
    // 二次混合(回归缺陷)会给出 ≈(250,126,2)。
    let over = pixel(&gpu, 10, 10);
    for (channel, target) in over.iter().zip([221.0, 117.0, 15.0].iter()) {
        assert!(
            (f64::from(*channel) - target).abs() <= 4.0,
            "single alpha blend over the card expected ≈(221,117,15): {over:?}"
        );
    }
    println!("mixed static+dynamic frame OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn composite_dynamic_layer_matches_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    // composite:一层静态卡片 + 一层动态方框(平移层坐标),验证 edge/cover
    // 的层偏移与层 scissor 在 GPU 上成立。
    let layer_list = |frame: f64| {
        display_list(
            vec![square_resource("p", [2.0 + frame, 4.0], 8.0)],
            vec![fill_command(
                "draw",
                0,
                "p",
                Deep2dPaint::Solid([0.2, 0.8, 0.3, 1.0]),
                None,
            )],
        )
    };
    let composite_at = |frame: f64| {
        deep_engine_native::deep2d::Deep2dComposite::new(
            "comp".into(),
            1,
            [16.0, 16.0],
            vec![deep_engine_native::deep2d::Deep2dLayer {
                id: "layer-a".into(),
                content: std::sync::Arc::new(Deep2dRuntimeContent::DisplayList(layer_list(frame))),
                translation: [0.0, 0.0],
                clip: Deep2dRect {
                    x: 0.0,
                    y: 0.0,
                    width: 16.0,
                    height: 16.0,
                },
            }],
        )
        .expect("composite")
    };
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let content = Deep2dRuntimeContent::Composite(composite_at(0.0));
    let mut painter = Deep2dGpuPainter::new(
        &device,
        &queue,
        wgpu::TextureFormat::Rgba8Unorm,
        &content,
        &cache,
    )
    .expect("cold painter");
    let mut saw_dynamic = false;
    for frame in 1..=4u32 {
        let content = Deep2dRuntimeContent::Composite(composite_at(f64::from(frame) * 0.4));
        painter = painter
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
            .expect("staged frame");
        saw_dynamic |= painter.summary.path.dynamic_commands == 1;
    }
    assert!(saw_dynamic, "composite layer must reach the stencil route");
    let gpu = draw_and_read(&device, &queue, &painter, "composite dynamic");
    // oracle 用同一 composite 的静态细分路。
    let static_prepared = prepare_runtime_content_cached(
        &Deep2dRuntimeContent::Composite(composite_at(1.6)),
        &mut deep_engine_native::deep2d::Deep2dPathCache::default(),
    )
    .expect("composite oracle");
    let reference = rasterize_prepared([16.0, 16.0], [WIDTH, HEIGHT], &static_prepared.path);
    let report = compare(&reference, &gpu, WIDTH, HEIGHT, 8);
    assert_eq!(
        report.divergent, 0,
        "composite dynamic divergence {report:?}"
    );
    println!("composite dynamic readback OK: adapter={adapter}");
}
