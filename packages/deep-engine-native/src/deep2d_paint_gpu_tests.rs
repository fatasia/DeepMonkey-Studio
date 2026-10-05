//! Real-GPU readback proofs for the GPUI visual trio: linear/radial gradient
//! fills, analytic rounded-rect quads (fill + corner-following stroke) and
//! box shadows. Every pixel test diffs the readback against the CPU mirror
//! (`paint_reference`) with the project oracle discipline: interior
//! divergence must be zero — only blend rounding may differ.
//!
//! Harness mirrors `deep2d_clip_gpu_tests.rs`: one 16x16 target, transparent
//! clear, painter draw, buffer readback, oracle compare.

use std::sync::mpsc;

use deep_engine_native::deep2d::{
    compare, prepare_display_list, prepare_display_list_cached, rasterize_prepared, BoxShadow,
    Deep2dCommand, Deep2dDisplayList, Deep2dPaint, Deep2dPathVerb, Deep2dResource,
    Deep2dRuntimeContent, GradientStop, LinearGradientPaint, PathCommand, PathResource,
    RadialGradientPaint,
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
            Deep2dPathVerb::Move { x: min[0], y: min[1] },
            Deep2dPathVerb::Line { x: max[0], y: min[1] },
            Deep2dPathVerb::Line { x: max[0], y: max[1] },
            Deep2dPathVerb::Line { x: min[0], y: max[1] },
            Deep2dPathVerb::Close,
        ],
    })
}

/// One PathCommand with the full field surface (the trio lives here).
#[allow(clippy::too_many_arguments)]
fn paint_command(
    id: &str,
    z_order: i32,
    path_id: &str,
    fill: Option<Deep2dPaint>,
    stroke: Option<[f64; 4]>,
    stroke_width: Option<f64>,
    corner_radius: Option<f64>,
    shadow: Option<BoxShadow>,
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
        stroke,
        stroke_width,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
        corner_radius,
        shadow,
    })
}

fn display_list(commands: Vec<Deep2dCommand>, resources: Vec<Deep2dResource>) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-paint-gpu".into(),
        revision: 1,
        logical_width: 8.0,
        logical_height: 8.0,
        scale_factor: 2.0,
        resources,
        atlases: Vec::new(),
        commands,
    }
}

fn linear_fill() -> Deep2dPaint {
    Deep2dPaint::LinearGradient(LinearGradientPaint {
        start: [0.0, 0.0],
        end: [8.0, 0.0],
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
    })
}

fn radial_fill() -> Deep2dPaint {
    Deep2dPaint::RadialGradient(RadialGradientPaint {
        center: [4.0, 4.0],
        radius: 4.0,
        stops: vec![
            GradientStop {
                offset: 0.0,
                color: [1.0, 1.0, 1.0, 1.0],
            },
            GradientStop {
                offset: 1.0,
                color: [0.0, 0.0, 0.0, 1.0],
            },
        ],
    })
}

fn assert_matches_oracle(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    painter: &Deep2dGpuPainter,
    list: &Deep2dDisplayList,
    context: &str,
) -> Vec<[u8; 4]> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d paint readback target"),
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
        label: Some("Deep2d paint readback buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d paint readback encoder"),
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
        label: Some("Deep2d paint readback clear"),
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
    let reference = rasterize_prepared(
        [8.0, 8.0],
        [WIDTH, HEIGHT],
        &prepared,
    );
    let report = compare(&reference, &gpu, WIDTH, HEIGHT, 8);
    let mut worst = (0u8, 0usize, [0u8; 4], [0u8; 4]);
    for (index, (reference_pixel, gpu_pixel)) in reference.iter().zip(gpu.iter()).enumerate() {
        let diff = reference_pixel
            .iter()
            .zip(gpu_pixel.iter())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        if diff > worst.0 {
            worst = (diff, index, *gpu_pixel, *reference_pixel);
        }
    }
    println!(
        "{context}: report={report:?} worst_diff={} at ({}, {}) gpu={:?} ref={:?}",
        worst.0,
        worst.1 % WIDTH as usize,
        worst.1 / WIDTH as usize,
        worst.2,
        worst.3
    );
    assert_eq!(
        report.divergent, 0,
        "{context}: interior divergence {report:?}"
    );
    // Smooth ramps make 4-neighbors differ by more than the channel
    // tolerance, so `compare`'s edge-band concept degenerates; the binding
    // gate is the direct per-pixel bound below (same tolerance discipline).
    let max_diff = reference
        .iter()
        .zip(gpu.iter())
        .map(|(reference_pixel, gpu_pixel)| {
            reference_pixel
                .iter()
                .zip(gpu_pixel.iter())
                .map(|(a, b)| a.abs_diff(*b))
                .max()
                .unwrap_or(0)
        })
        .max()
        .unwrap_or(0);
    assert!(max_diff <= 8, "{context}: max channel diff {max_diff}");
    gpu
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

fn pixel(gpu: &[[u8; 4]], logical: [f64; 2]) -> [u8; 4] {
    // Letterbox 1:1 at scale 2: physical = logical * 2.
    let x = (logical[0] * 2.0) as usize;
    let y = (logical[1] * 2.0) as usize;
    gpu[y * WIDTH as usize + x]
}

fn assert_near(actual: [u8; 4], expected: [f64; 4], context: &str) {
    for (channel, target) in actual.iter().zip(expected.iter()) {
        assert!(
            (f64::from(*channel) - target * 255.0).abs() <= 4.0,
            "{context}: {actual:?} vs {expected:?}"
        );
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn linear_gradient_ramp_matches_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let list = display_list(
        vec![paint_command(
            "draw:ramp",
            0,
            "canvas",
            Some(linear_fill()),
            None,
            None,
            None,
            None,
        )],
        vec![rect_resource("canvas", [0.0, 0.0], [8.0, 8.0])],
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("gradient painter");
    let gpu = assert_matches_oracle(&device, &queue, &painter, &list, "linear ramp");
    // Ramp endpoints and midpoint carry analytic values (pixel centers at
    // logical 0.75 / 4.0 / 7.25 on the [0, 8] ramp).
    assert_near(pixel(&gpu, [0.75, 4.25]), [0.90625, 0.0, 0.09375, 1.0], "left");
    assert_near(pixel(&gpu, [4.25, 4.25]), [0.46875, 0.0, 0.53125, 1.0], "mid");
    assert_near(pixel(&gpu, [7.25, 4.25]), [0.09375, 0.0, 0.90625, 1.0], "right");
    println!("linear gradient readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn radial_gradient_falloff_matches_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let list = display_list(
        vec![paint_command(
            "draw:radial",
            0,
            "canvas",
            Some(radial_fill()),
            None,
            None,
            None,
            None,
        )],
        vec![rect_resource("canvas", [0.0, 0.0], [8.0, 8.0])],
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("radial painter");
    let gpu = assert_matches_oracle(&device, &queue, &painter, &list, "radial falloff");
    // Pixel center (4.25, 4.25): t = hypot(0.25, 0.25)/4 ≈ 0.0884 on the
    // white->black ramp -> 255 * (1 - t) ≈ 232.
    assert_near(pixel(&gpu, [4.25, 4.25]), [0.910, 0.910, 0.910, 1.0], "near center");
    // Corner center (0.75, 0.75): t = hypot(3.25, 3.25)/4 > 1 -> clamped black.
    let corner = pixel(&gpu, [0.75, 0.75]);
    assert!(corner[0] <= 40 && corner[1] <= 40, "far corner nears black: {corner:?}");
    println!("radial gradient readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn rounded_rect_corners_and_stroke_are_analytic() {
    let (device, queue, adapter) = real_gpu();
    let list = display_list(
        vec![paint_command(
            "draw:card",
            0,
            "canvas",
            Some(Deep2dPaint::Solid([0.0, 0.75, 0.0, 1.0])),
            Some([0.0, 0.0, 0.0, 1.0]),
            Some(1.0),
            Some(1.0),
            None,
        )],
        vec![rect_resource("canvas", [2.0, 2.0], [6.0, 6.0])],
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("rounded rect painter");
    let gpu = assert_matches_oracle(&device, &queue, &painter, &list, "rounded rect");
    // Cut corner: (1.25, 1.25) sits deep outside the corner arc -> fully
    // transparent. A sharp-corner rasterizer would have painted it.
    let cut = pixel(&gpu, [1.25, 1.25]);
    assert!(cut[3] <= 8, "corner arc must cut the corner: {cut:?}");
    // Straight edge midpoints: stroke band straddles the edge.
    let band = pixel(&gpu, [2.0, 4.25]);
    assert!(band[3] >= 240, "edge stroke band is opaque: {band:?}");
    // Interior keeps the fill.
    let interior = pixel(&gpu, [4.25, 4.25]);
    assert_near(interior, [0.0, 0.75, 0.0, 1.0], "interior fill");
    println!("rounded rect readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn box_shadow_offset_and_blur_match_cpu_reference() {
    let (device, queue, adapter) = real_gpu();
    let list = display_list(
        vec![paint_command(
            "draw:shadow",
            0,
            "canvas",
            Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])),
            None,
            None,
            Some(1.0),
            Some(BoxShadow {
                offset_x: 1.0,
                offset_y: 0.0,
                blur_radius: 2.0,
                spread: 0.5,
                color: [0.0, 0.0, 1.0, 0.8],
                corner_radius: None,
            }),
        )],
        vec![rect_resource("canvas", [2.0, 2.0], [6.0, 6.0])],
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("shadow painter");
    let gpu = assert_matches_oracle(&device, &queue, &painter, &list, "box shadow");
    // Interior: opaque fill hides the shadow underneath.
    assert_near(pixel(&gpu, [4.25, 4.25]), [1.0, 0.0, 0.0, 1.0], "fill over shadow");
    // Shadow-only band right of the quad: analytic smoothstep falloff
    // (coverage ~0.55 at (7.75, 4.25) under blur 2).
    let band = pixel(&gpu, [7.75, 4.25]);
    assert!(
        band[2] >= 60 && band[0] == 0,
        "shadow-only band is blue and partial: {band:?}"
    );
    // Far beyond the blur reach (falloff ends 2 local units past the shadow
    // box edge at x = 2.5): transparent.
    let far = pixel(&gpu, [0.25, 4.25]);
    assert!(far[3] == 0, "beyond the shadow reach stays empty: {far:?}");
    println!("box shadow readback OK: adapter={adapter}");
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn cache_hit_frames_render_gradients_identically_to_fresh_prepare() {
    let (device, queue, adapter) = real_gpu();
    // Two cards sharing one gradient definition: frame 1 tessellates, frame 2
    // must hit the cache and still land byte-identical pixels.
    let shared_gradient = || {
        Deep2dPaint::LinearGradient(LinearGradientPaint {
            start: [2.0, 0.0],
            end: [6.0, 0.0],
            stops: vec![
                GradientStop {
                    offset: 0.0,
                    color: [1.0, 0.5, 0.0, 1.0],
                },
                GradientStop {
                    offset: 1.0,
                    color: [0.0, 0.5, 1.0, 1.0],
                },
            ],
        })
    };
    let list = display_list(
        vec![
            paint_command(
                "draw:card-a",
                0,
                "canvas-a",
                Some(shared_gradient()),
                None,
                None,
                Some(1.0),
                None,
            ),
            paint_command(
                "draw:card-b",
                1,
                "canvas-b",
                Some(shared_gradient()),
                None,
                None,
                Some(1.0),
                None,
            ),
        ],
        vec![
            rect_resource("canvas-a", [2.0, 2.0], [6.0, 6.0]),
            rect_resource("canvas-b", [2.0, 2.0], [6.0, 6.0]),
        ],
    );
    let content = Deep2dRuntimeContent::DisplayList(list.clone());
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("cache frame 1");
    let first = assert_matches_oracle(&device, &queue, &painter, &list, "cache frame 1");
    let stats = painter.path_cache_stats();
    assert_eq!(stats.misses, 2, "frame 1 tessellates both cards");
    let staged = painter
        .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content)
        .expect("cache frame 2");
    let stats = staged.path_cache_stats();
    assert_eq!(stats.hits, 2, "frame 2 hits the cache: {stats:?}");
    let second = assert_matches_oracle(&device, &queue, &staged, &list, "cache frame 2");
    assert_eq!(first, second, "cache hit pixels equal fresh pixels");
    println!("cache parity readback OK: adapter={adapter}");
}

#[test]
fn cache_prepare_matches_fresh_prepare_for_all_three_commands() {
    // CPU-side guard (no GPU): cached prepare must be byte-identical to a
    // fresh prepare across gradient fills, rounded rects and shadows.
    let list = display_list(
        vec![
            paint_command(
                "draw:ramp",
                0,
                "canvas",
                Some(linear_fill()),
                None,
                None,
                None,
                None,
            ),
            paint_command(
                "draw:card",
                1,
                "canvas",
                Some(radial_fill()),
                Some([0.0, 0.0, 0.0, 1.0]),
                Some(1.0),
                Some(1.0),
                Some(BoxShadow {
                    offset_x: 1.0,
                    offset_y: 1.0,
                    blur_radius: 1.5,
                    spread: 0.0,
                    color: [0.0, 0.0, 0.0, 0.6],
                    corner_radius: None,
                }),
            ),
        ],
        vec![rect_resource("canvas", [0.0, 0.0], [8.0, 8.0])],
    );
    let fresh = prepare_display_list(&list).expect("fresh");
    let mut cache = deep_engine_native::deep2d::Deep2dPathCache::default();
    let first = prepare_display_list_cached(&list, &mut cache).expect("cold");
    assert!(first.paints.len() > 2, "gradient + quad entries exist");
    let second = prepare_display_list_cached(&list, &mut cache).expect("warm");
    // Slot ordering may legitimately differ between fresh and cache-hit
    // registration; the parity contract is rendered pixels, not slot ids.
    let render = |prepared: &deep_engine_native::deep2d::PreparedDeep2d| {
        rasterize_prepared([8.0, 8.0], [WIDTH, HEIGHT], prepared)
    };
    assert_eq!(render(&fresh), render(&second), "cache-hit pixels equal fresh pixels");
    assert_eq!(render(&first), render(&fresh), "cold prepare pixels equal too");
    assert_eq!(second.paints.len(), fresh.paints.len(), "same paint entry count");
}

#[test]
fn gradient_stops_survive_wire_round_trip_through_display_list() {
    // JSON round trip: solid stays an array, gradients stay tagged objects.
    let list = display_list(
        vec![paint_command(
            "draw:ramp",
            0,
            "canvas",
            Some(linear_fill()),
            None,
            None,
            None,
            None,
        )],
        vec![rect_resource("canvas", [0.0, 0.0], [8.0, 8.0])],
    );
    let json = serde_json::to_string(&list).expect("serialize");
    assert!(json.contains(r#""fill":{"kind":"linear""#));
    assert!(json.contains("\"stops\""));
    let back: Deep2dDisplayList = serde_json::from_str(&json).expect("parse");
    assert_eq!(back, list);
    // Solid wire shape unchanged for legacy producers.
    let solid = display_list(
        vec![paint_command(
            "draw:solid",
            0,
            "canvas",
            Some(Deep2dPaint::Solid([1.0, 0.0, 0.0, 1.0])),
            None,
            None,
            None,
            None,
        )],
        vec![rect_resource("canvas", [0.0, 0.0], [8.0, 8.0])],
    );
    let json = serde_json::to_string(&solid).expect("serialize solid");
    assert!(json.contains(r#""fill":[1.0,0.0,0.0,1.0]"#), "{json}");
}

#[test]
fn oracle_and_paint_formulas_agree_on_a_known_shadow_profile() {
    // CPU mirror self-check: shadow falloff at the analytic midpoints.
    use deep_engine_native::deep2d::{quad_fragment, Deep2dPaintData};
    let entry = Deep2dPaintData {
        kind: deep_engine_native::deep2d::DEEP2D_PAINT_KIND_QUAD,
        p0: [4.0, 4.0],
        p1: [2.0, 2.0],
        radius: 1.0,
        color: [1.0, 0.0, 0.0, 1.0],
        shadow_offset: [1.0, 0.0],
        shadow_blur: 2.0,
        shadow_spread: 0.5,
        shadow_radius: 1.0,
        shadow_color: [0.0, 0.0, 1.0, 0.8],
        aa_scale: 2.0,
        ..Default::default()
    };
    let paints = [entry];
    // Deep inside the shadow-only band: full shadow coverage. Straight-alpha
    // RGB stays at the pure color; coverage lives in the alpha channel.
    let shadow = quad_fragment(&entry, &paints, [7.25, 4.25]);
    assert_near_straight(shadow, [0.0, 0.0, 1.0, 0.8]);
    // Exactly one local unit past the shadow box edge: smoothstep(0.5) = 0.5
    // coverage -> alpha 0.8 * 0.5 = 0.4.
    let falloff = quad_fragment(&entry, &paints, [8.5, 4.25]);
    assert_near_straight(falloff, [0.0, 0.0, 1.0, 0.4]);
    // Outside the reach: empty.
    let empty = quad_fragment(&entry, &paints, [0.25, 4.25]);
    assert_eq!(empty, [0.0, 0.0, 0.0, 0.0]);
    // Interior: opaque fill wins.
    let fill = quad_fragment(&entry, &paints, [4.25, 4.25]);
    assert_near_straight(fill, [1.0, 0.0, 0.0, 1.0]);
}

fn assert_near_straight(actual: [f32; 4], expected: [f64; 4]) {
    for (channel, target) in actual.iter().zip(expected.iter()) {
        assert!(
            (f64::from(*channel) - target).abs() < 1e-3,
            "{actual:?} vs {expected:?}"
        );
    }
}
