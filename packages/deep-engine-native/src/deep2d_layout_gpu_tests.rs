//! Real-GPU readback proof for the 刀 2 component layout engine: the minimal
//! component sample (rounded card with shadow + gradient header + icon and
//! text placeholders in a flex row) is solved through the app wiring seam
//! (`app::deep2d_context::layout_content`), painted on a real GPU and diffed
//! per-pixel against the CPU mirror oracle — same discipline as
//! `deep2d_paint_gpu_tests.rs`: interior divergence must be zero, max channel
//! diff ≤ 8.
//!
//! Sample geometry (logical 96x64, scale 2 → 192x128 physical, byte-exact):
//! card 96x64 r=8 shadow(0,6,16), padding 6, column;
//!   header 84x16 linear gradient at (6,6);
//!   body 84x30 row gap=12 align=center at (6,22);
//!     icon 12x12 r=6 orange at (6,31);
//!     text placeholder 48x12 r=4 gray at (30,31).

use std::sync::mpsc;

use deep_engine_native::deep2d::layout::{
    LayoutAlign, LayoutBoxVisual, LayoutDirection, LayoutEdges, LayoutJustify, LayoutNode,
    LayoutStyle, LayoutTree, NodeId,
};
use deep_engine_native::deep2d::{
    BoxShadow, Deep2dPaint, Deep2dRuntimeContent, GradientStop, LinearGradientPaint,
};
use crate::app::deep2d_context::layout_content;
use crate::deep2d_gpu::Deep2dGpuPainter;

const WIDTH: u32 = 192;
const HEIGHT: u32 = 128;
const ROW_BYTES: u32 = 768; // 192 * 4, aligned to 256.

fn golden_card() -> LayoutTree {
    let card = LayoutBoxVisual {
        background: Some(Deep2dPaint::Solid([0.08, 0.09, 0.11, 1.0])),
        corner_radius: 8.0,
        shadow: Some(BoxShadow {
            offset_x: 0.0,
            offset_y: 6.0,
            blur_radius: 16.0,
            spread: 0.0,
            color: [0.0, 0.0, 0.0, 0.45],
            corner_radius: None,
        }),
        blend: None,
        backdrop_blur: None,
    };
    let header = LayoutBoxVisual {
        background: Some(Deep2dPaint::LinearGradient(LinearGradientPaint {
            start: [0.0, 0.0],
            end: [84.0, 0.0],
            stops: vec![
                GradientStop {
                    offset: 0.0,
                    color: [0.16, 0.35, 0.85, 1.0],
                },
                GradientStop {
                    offset: 1.0,
                    color: [0.45, 0.2, 0.8, 1.0],
                },
            ],
        })),
        corner_radius: 4.0,
        shadow: None,
        blend: None,
        backdrop_blur: None,
    };
    let mut tree = LayoutTree::new(
        LayoutNode::box_node(LayoutStyle {
            direction: LayoutDirection::Column,
            justify: LayoutJustify::FlexStart,
            align_items: LayoutAlign::Start,
            padding: LayoutEdges::uniform(6.0),
            ..LayoutStyle::size(96.0, 64.0)
        })
        .with_visual(card),
    );
    tree.append(
        NodeId::ROOT,
        LayoutNode::box_node(LayoutStyle::size(84.0, 16.0)).with_visual(header),
    )
    .expect("header");
    let body = tree
        .append(
            NodeId::ROOT,
            LayoutNode::box_node(LayoutStyle {
                column_gap: 12.0,
                align_items: LayoutAlign::Center,
                ..LayoutStyle::size(84.0, 30.0)
            }),
        )
        .expect("body");
    tree.append(
        body,
        LayoutNode::box_node(LayoutStyle::size(12.0, 12.0)).with_visual(LayoutBoxVisual {
            background: Some(Deep2dPaint::Solid([0.95, 0.62, 0.18, 1.0])),
            corner_radius: 6.0,
            shadow: None,
            blend: None,
            backdrop_blur: None,
        }),
    )
    .expect("icon");
    tree.append(
        body,
        LayoutNode::box_node(LayoutStyle::size(48.0, 12.0)).with_visual(LayoutBoxVisual {
            background: Some(Deep2dPaint::Solid([0.22, 0.25, 0.3, 1.0])),
            corner_radius: 4.0,
            shadow: None,
            blend: None,
            backdrop_blur: None,
        }),
    )
    .expect("text placeholder");
    tree
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
fn layout_card_sample_matches_cpu_reference_pixelwise() {
    let (device, queue, adapter) = real_gpu();
    let content = layout_content(&golden_card(), [96.0, 64.0], "layout-gpu-card", 1, &[], None)
        .expect("layout content");
    let Deep2dRuntimeContent::DisplayList(list) = &content else {
        panic!("layout content is a display list");
    };
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("layout card painter");

    // Render + readback (transparent clear, letterbox 1:1 at scale 2).
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d layout readback target"),
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
        label: Some("Deep2d layout readback buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d layout readback encoder"),
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
        label: Some("Deep2d layout readback clear"),
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
    let gpu: Vec<[u8; 4]> = (0..HEIGHT as usize)
        .flat_map(|y| (0..WIDTH as usize).map(move |x| (x, y)))
        .map(|(x, y)| {
            let offset = y * ROW_BYTES as usize + x * 4;
            bytes[offset..offset + 4].try_into().unwrap()
        })
        .collect();

    // CPU mirror oracle: identical letterbox, same prepared frame.
    let prepared = deep_engine_native::deep2d::prepare_display_list(list).expect("oracle prepare");
    let reference = deep_engine_native::deep2d::rasterize_prepared([96.0, 64.0], [WIDTH, HEIGHT], &prepared);
    let report = deep_engine_native::deep2d::compare(&reference, &gpu, WIDTH, HEIGHT, 8);
    println!("layout card: report={report:?}");
    assert_eq!(report.divergent, 0, "interior divergence {report:?}");
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
    assert!(max_diff <= 8, "max channel diff {max_diff}");

    // Analytic pixels: the layout SOLVE put every component where the math
    // says (bit-pinned in deep2d::layout::golden_tests); here we prove the
    // solved geometry actually landed as pixels.
    // Card top-left rounded corner (r=8): pixel center (0.25, 0.25) is deep
    // outside the arc → the card FILL must not cover it. The box shadow
    // (blur 16) bleeds through here, so the point is neither transparent nor
    // the card solid — the binding property is: not the opaque card fill
    // (a failed corner cut would paint the solid card background alpha=255).
    let corner = pixel(&gpu, [0.25, 0.25]);
    assert!(
        corner[3] < 255
            && !(corner[0].abs_diff(20) <= 2 && corner[1].abs_diff(23) <= 2),
        "cut corner must not show opaque card fill: {corner:?}"
    );
    // Card body above the header (y<6): card solid background.
    assert_near(pixel(&gpu, [48.0, 3.25]), [0.08, 0.09, 0.11, 1.0], "card body");
    // Header gradient midpoint: t = (48-6)/84 = 0.5 on the ramp.
    assert_near(
        pixel(&gpu, [48.0, 14.25]),
        [0.305, 0.275, 0.825, 1.0],
        "header gradient mid",
    );
    // Icon (fully rounded 12x12 → circle): interior keeps the solid orange.
    assert_near(pixel(&gpu, [11.25, 36.25]), [0.95, 0.62, 0.18, 1.0], "icon");
    // Text placeholder band.
    assert_near(pixel(&gpu, [60.0, 36.25]), [0.22, 0.25, 0.3, 1.0], "text placeholder");
    println!("layout card readback OK: adapter={adapter}");
}

/// 刀 3 收尾:最小组件样例截图留档(任务书线级验收)。复用 `golden_card`
/// 同一渲染路径,把真 GPU readback 逐字节写成 PNG
/// (`test-output/deep2d-layout-sample-20261005.png`)。web 端无 native
/// 命令通路(wasm 桥接不存在),按任务书指令以 GPU readback 像素证据
/// 留档——PNG 由本测试内置的无依赖编码器写出(stored-deflate)。
#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn layout_card_sample_writes_png_evidence() {
    let (device, queue, _adapter) = real_gpu();
    let content = layout_content(&golden_card(), [96.0, 64.0], "layout-gpu-card", 1, &[], None)
        .expect("layout content");
    let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
    let painter = Deep2dGpuPainter::new(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content, &cache)
        .expect("layout card painter");
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Deep2d layout evidence target"),
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
        label: Some("Deep2d layout evidence buffer"),
        size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Deep2d layout evidence encoder"),
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
        label: Some("Deep2d layout evidence clear"),
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

    // 行主 RGBA(剔除行尾对齐填充),叠到中性深灰底便于查看。
    let mut rgba = Vec::with_capacity(WIDTH as usize * HEIGHT as usize * 4);
    for y in 0..HEIGHT as usize {
        for x in 0..WIDTH as usize {
            let offset = y * ROW_BYTES as usize + x * 4;
            let [r, g, b, a] = bytes[offset..offset + 4].try_into().unwrap();
            let over = |fg: u8, bg: u8| {
                ((f64::from(fg) * f64::from(a) + f64::from(bg) * (f64::from(255u8) - f64::from(a)))
                    / 255.0
                    + 0.5) as u8
            };
            let background = 38u8;
            rgba.extend_from_slice(&[
                over(r, background),
                over(g, background),
                over(b, background),
                255,
            ]);
        }
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test-output/deep2d-layout-sample-20261005.png");
    write_rgba_png(&path, WIDTH, HEIGHT, &rgba).expect("write png evidence");
    println!("layout card PNG evidence: {}", path.display());
}

/// 无依赖 PNG 编码器:RGBA8,zlib stored 块(无压缩),filter 0。
fn write_rgba_png(path: &std::path::Path, width: u32, height: u32, rgba: &[u8]) -> std::io::Result<()> {
    fn crc32(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for (index, entry) in table.iter_mut().enumerate() {
            let mut value = index as u32;
            for _ in 0..8 {
                value = if value & 1 != 0 { 0xEDB8_8320 ^ (value >> 1) } else { value >> 1 };
            }
            *entry = value;
        }
        let mut crc = 0xFFFF_FFFFu32;
        for byte in data {
            crc = table[((crc ^ u32::from(*byte)) & 0xff) as usize] ^ (crc >> 8);
        }
        crc ^ 0xFFFF_FFFF
    }
    fn adler32(data: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for byte in data {
            a = (a + u32::from(*byte)) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }
    fn chunk(out: &mut Vec<u8>, tag: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(tag);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(tag);
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }
    // 原始扫描线:每行 filter 0 + RGBA。
    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in 0..height as usize {
        raw.push(0u8);
        raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    // zlib 流:0x78 0x01 + stored 块(每块 ≤65535)+ adler32。
    let mut zlib = vec![0x78u8, 0x01];
    let mut offset = 0usize;
    loop {
        let take = (raw.len() - offset).min(65535);
        let last = offset + take >= raw.len();
        zlib.push(u8::from(last));
        zlib.extend_from_slice(&(take as u16).to_le_bytes());
        zlib.extend_from_slice(&(!take as u16).to_le_bytes());
        zlib.extend_from_slice(&raw[offset..offset + take]);
        offset += take;
        if last {
            break;
        }
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &zlib);
    chunk(&mut png, b"IEND", &[]);
    std::fs::write(path, png)
}
