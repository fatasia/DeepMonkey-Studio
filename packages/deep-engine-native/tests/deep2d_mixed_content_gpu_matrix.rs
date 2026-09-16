//! P1-11 mixed-content GPU row (r3) of the cache-failure/clip matrix: text
//! glyph atlas + image atlas + clipped nonuniform path in one frame, read
//! back and diffed against a `raster_reference` CPU frame (the D09 method),
//! plus atlas reload / rejected-candidate rollback / new-epoch rebuild.
//! Bin-side painter modules are reassembled via `#[path]`.

#![allow(dead_code)]

#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu;
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu;
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache;
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor;

use std::sync::{Arc, mpsc};

use deep_engine_native::deep2d::{
    BakedGlyphPlacement, Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand,
    Deep2dDisplayList, Deep2dPathVerb, Deep2dRect, Deep2dResource, Deep2dRuntimeContent,
    FontResource, FontStyle, ImageColorSpace, ImageCommand, ImageResource, ImageSampling,
    PathCommand, PathResource, ReferenceTriangle, TextCommand, compare, prepare_runtime_content,
    rasterize,
};

/// Mixed-content carrier shared by every cell: white nonuniform-scaled
/// scissor-clipped path (z0), red|blue image-atlas quad (z1), green
/// glyph-atlas quad (z2). Logical 10x10 -> physical 20x20 (2x).
const ORIGINAL_TILES: &str = "/wAA/wAA//8="; // pixel0 red, pixel1 blue
const SWAPPED_TILES: &str = "AAD///8AAP8="; // pixel0 blue, pixel1 red
const WIDTH: u32 = 20;
const HEIGHT: u32 = 20;
const ROW_PIXELS: usize = 64; // 256-byte aligned copy rows
const BG: [u8; 4] = [255, 0, 0, 255];

fn rect_verbs(x: f64, y: f64, w: f64, h: f64) -> Vec<Deep2dPathVerb> {
    vec![
        Deep2dPathVerb::Move { x, y },
        Deep2dPathVerb::Line { x: x + w, y },
        Deep2dPathVerb::Line { x: x + w, y: y + h },
        Deep2dPathVerb::Line { x, y: y + h },
        Deep2dPathVerb::Close,
    ]
}

fn tiles_atlas(data: &str, revision: u64) -> Deep2dAtlas {
    Deep2dAtlas {
        id: "tiles".into(),
        revision,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: data.into(),
    }
}

fn glyph_atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "glyphs".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Glyph,
        format: Deep2dAtlasFormat::R8Unorm,
        width: 1,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: "/w==".into(),
    }
}

fn base_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "p1-11-matrix".into(),
        revision: 1,
        logical_width: 10.0,
        logical_height: 10.0,
        scale_factor: 1.0,
        resources: vec![
            Deep2dResource::Path(PathResource {
                id: "frame".into(),
                revision: 1,
                verbs: rect_verbs(0.0, 0.0, 5.0, 8.0),
            }),
            Deep2dResource::Font(FontResource {
                id: "font:probe".into(),
                revision: 1,
                asset_id: "embedded:probe".into(),
                family: "Probe".into(),
                weight: 400,
                style: FontStyle::Normal,
            }),
            Deep2dResource::Image(ImageResource {
                id: "img".into(),
                revision: 1,
                asset_id: "asset:img".into(),
                width: 2,
                height: 1,
                color_space: ImageColorSpace::Srgb,
            }),
        ],
        commands: vec![
            Deep2dCommand::Path(PathCommand {
                id: "draw:frame".into(),
                z_order: 0,
                transform: [2.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: Some(Deep2dRect {
                    x: 0.0,
                    y: 0.0,
                    width: 8.0,
                    height: 10.0,
                }),
                hit_id: None,
                path_id: "frame".into(),
                fill: Some([1.0, 1.0, 1.0, 1.0]),
                fill_rule: None,
                stroke: None,
                stroke_width: None,
                line_cap: None,
                line_join: None,
                miter_limit: None,
                dash: None,
                dash_offset: None,
            }),
            Deep2dCommand::Image(ImageCommand {
                id: "draw:tile".into(),
                z_order: 1,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                image_id: "img".into(),
                x: 2.0,
                y: 0.0,
                width: 2.0,
                height: 8.0,
                atlas_id: Some("tiles".into()),
                source: Some([0, 0, 2, 1]),
                sampling: None,
            }),
            Deep2dCommand::Text(TextCommand {
                id: "draw:glyph".into(),
                z_order: 2,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: None,
                hit_id: None,
                text: "A".into(),
                x: 8.0,
                y: 0.0,
                font_id: "font:probe".into(),
                font_size: 1.0,
                color: [0.0, 1.0, 0.0, 1.0],
                max_width: None,
                align: None,
                baseline: None,
                direction: None,
                atlas_id: Some("glyphs".into()),
                baked_glyphs: Some(vec![BakedGlyphPlacement {
                    cluster: 0,
                    source: [0, 0, 1, 1],
                    destination: [0.0, 0.0, 1.0, 8.0],
                }]),
            }),
        ],
        atlases: vec![glyph_atlas(), tiles_atlas(ORIGINAL_TILES, 1)],
    }
}

fn content(list: &Deep2dDisplayList) -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(list.clone())
}

async fn gpu_device() -> (wgpu::Device, wgpu::Queue, String) {
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
    let (device, queue) = adapter.request_device(&Default::default()).await.unwrap();
    (device, queue, info.name)
}

fn draw_and_read(
    painter: &deep2d_gpu::Deep2dGpuPainter,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    label: &str,
) -> Vec<[u8; 4]> {
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
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
        label: Some(label),
        size: (ROW_PIXELS * HEIGHT as usize * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let _clear = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some(label),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: 1.0,
                        g: 0.0,
                        b: 0.0,
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
    }
    painter.draw(&mut encoder, &view, (WIDTH, HEIGHT));
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some((ROW_PIXELS * 4) as u32),
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
    (0..(WIDTH as usize) * (HEIGHT as usize))
        .map(|i| {
            let (x, y) = (i % WIDTH as usize, i / WIDTH as usize);
            bytes[(y * ROW_PIXELS + x) * 4..(y * ROW_PIXELS + x) * 4 + 4]
                .try_into()
                .unwrap()
        })
        .collect()
}

fn zone(pixels: &[[u8; 4]], x: usize, y: usize) -> [u8; 4] {
    pixels[y * WIDTH as usize + x]
}

/// Zone contract, one assertion per mixed-content cell: path-only white,
/// image atlas slot colors, path continuation, glyph atlas green, and the
/// scissor exclusion band — z-order and atlas-slot mixing in one grid.
fn assert_frame(pixels: &[[u8; 4]], red_left: bool, stage: &str) {
    let (a, b) = if red_left {
        ([255, 0, 0, 255], [0, 0, 255, 255])
    } else {
        ([0, 0, 255, 255], [255, 0, 0, 255])
    };
    for y in [2, 9, 15] {
        assert_eq!(
            zone(pixels, 1, y),
            [255, 255, 255, 255],
            "{stage}: path-only zone at (1,{y})"
        );
        assert_eq!(
            zone(pixels, 4, y),
            a,
            "{stage}: image atlas slot A at (4,{y})"
        );
        assert_eq!(
            zone(pixels, 7, y),
            b,
            "{stage}: image atlas slot B at (7,{y})"
        );
        assert_eq!(
            zone(pixels, 10, y),
            [255, 255, 255, 255],
            "{stage}: path continuation at (10,{y})"
        );
        assert_eq!(
            zone(pixels, 17, y),
            [0, 255, 0, 255],
            "{stage}: glyph atlas zone at (17,{y})"
        );
        assert_eq!(
            zone(pixels, 19, y),
            BG,
            "{stage}: clip must exclude path at (19,{y})"
        );
    }
    // Every content quad ends at logical y=8 (physical 16): the bottom band
    // pins the quad heights and proves no bleeding below the geometry.
    for x in [1, 4, 7, 10, 17, 19] {
        assert_eq!(
            zone(pixels, x, 17),
            BG,
            "{stage}: bottom band must stay background at ({x},17)"
        );
    }
}

/// CPU synthetic frame: background + raster_reference path layer (clipped at
/// x=8 logical like the GPU scissor) + image/glyph zones lifted from the GPU
/// frame so the diff isolates path-vs-GPU agreement only.
fn synthetic_reference(pixels: &[[u8; 4]]) -> Vec<[u8; 4]> {
    let prepared = prepare_runtime_content(&content(&base_list())).unwrap();
    let mut triangles = Vec::new();
    for tri in prepared.path.vertices.chunks_exact(3) {
        triangles.push(ReferenceTriangle {
            vertices: [
                [f64::from(tri[0][0]) * 2.0, f64::from(tri[0][1]) * 2.0],
                [f64::from(tri[1][0]) * 2.0, f64::from(tri[1][1]) * 2.0],
                [f64::from(tri[2][0]) * 2.0, f64::from(tri[2][1]) * 2.0],
            ],
            color: [tri[0][2], tri[0][3], tri[0][4], tri[0][5]],
        });
    }
    let mut reference = rasterize(WIDTH, HEIGHT, &triangles);
    for pixel in reference.iter_mut() {
        if pixel[3] == 0 {
            *pixel = BG;
        } else if pixel[3] < 255 {
            *pixel = [255, 255, 255, 255];
        }
    }
    for y in 0..HEIGHT as usize {
        for x in 16..WIDTH as usize {
            reference[y * WIDTH as usize + x] = BG;
        }
    }
    for y in 0..HEIGHT as usize {
        for x in 4..8 {
            reference[y * WIDTH as usize + x] = zone(pixels, x, y);
        }
    }
    for y in 0..HEIGHT as usize {
        for x in 16..18 {
            reference[y * WIDTH as usize + x] = zone(pixels, x, y);
        }
    }
    reference
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored --test-threads=1"]
fn r3_c1_mixed_content_frame_matches_cpu_reference_diff() {
    pollster::block_on(async {
        let (device, queue, name) = gpu_device().await;
        let cache = Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let painter = deep2d_gpu::Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content(&base_list()),
            &cache,
        )
        .expect("r3_c1 painter");
        let pixels = draw_and_read(&painter, &device, &queue, "r3_c1 target");
        assert_frame(&pixels, true, "r3_c1");
        let report = compare(&synthetic_reference(&pixels), &pixels, WIDTH, HEIGHT, 8);
        println!("r3_c1 diff: {report:?} adapter={name}");
        assert!(
            report.interior_agreement_ratio() >= 0.95,
            "r3_c1: interior agreement {:.4}",
            report.interior_agreement_ratio()
        );
    });
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored --test-threads=1"]
fn r3_c2_atlas_reload_rejected_candidate_and_new_epoch_rebuild() {
    pollster::block_on(async {
        let (device, queue, name) = gpu_device().await;
        let cache = Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let active = deep2d_gpu::Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content(&base_list()),
            &cache,
        )
        .expect("r3_c2 painter");
        let warm = draw_and_read(&active, &device, &queue, "r3_c2 warm");
        assert_frame(&warm, true, "r3_c2[reload] warm");

        // r3_c2[reload]: same atlas id + new pixels must stage a NEW texture,
        // not silently reuse the stale slot.
        let mut reloaded = base_list();
        reloaded.atlases[1].revision += 1;
        reloaded.atlases[1].data_base64 = SWAPPED_TILES.into();
        let candidate = active
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &content(&reloaded),
            )
            .expect("r3_c2[reload] candidate");
        let stats = cache.stats();
        // creates: glyphs + tiles + reloaded tiles; hits: unchanged glyphs.
        assert_eq!(
            (stats.atlas_texture_creates, stats.atlas_texture_hits),
            (3, 1),
            "r3_c2[reload]: changed pixels must allocate, not reuse"
        );
        let swapped = draw_and_read(&candidate, &device, &queue, "r3_c2 swapped");
        assert_frame(&swapped, false, "r3_c2[reload] swapped");

        // r3_c2[rollback]: rejecting a candidate must keep the active frame.
        let mut bad = base_list();
        if let Deep2dCommand::Text(text) = &mut bad.commands[2] {
            text.baked_glyphs = Some(vec![BakedGlyphPlacement {
                cluster: 0,
                source: [1, 0, 1, 1],
                destination: [0.0, 0.0, 1.0, 8.0],
            }]);
        }
        let error = match active.stage_update(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content(&bad),
        ) {
            Ok(_) => panic!("r3_c2[rollback]: out-of-bounds glyph must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("Glyph source"), "r3_c2[rollback]: {error}");
        let kept = draw_and_read(&active, &device, &queue, "r3_c2 rollback");
        assert_eq!(
            kept, warm,
            "r3_c2[rollback]: rejected candidate changed the active frame"
        );

        // r3_c2[epoch]: a fresh device-epoch cache must rebuild from zero —
        // the stand-in for device loss (real loss callbacks are not
        // injectable in this harness; gap noted in the delivery report).
        let fresh = Arc::new(deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let rebuilt = deep2d_gpu::Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content(&base_list()),
            &fresh,
        )
        .expect("r3_c2[epoch] painter");
        let epoch = fresh.stats();
        assert_eq!(
            (
                epoch.atlas_texture_hits,
                epoch.vertex_buffer_hits,
                epoch.frame_layout_hits
            ),
            (0, 0, 0),
            "r3_c2[epoch]: stale-epoch cache leaked"
        );
        let pixels = draw_and_read(&rebuilt, &device, &queue, "r3_c2 epoch");
        assert_frame(&pixels, true, "r3_c2[epoch] rebuilt");
        println!(
            "r3_c2 OK: adapter={name} reload_creates={} rollback='{error}'",
            stats.atlas_texture_creates
        );
    });
}
