use super::fixture::{base_list, content};
use super::{BG, HEIGHT, ROW_PIXELS, WIDTH, deep2d_gpu};
use deep_engine_native::deep2d::{ReferenceTriangle, prepare_runtime_content, rasterize};
use std::sync::mpsc;

pub(super) async fn gpu_device() -> (wgpu::Device, wgpu::Queue, String) {
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

pub(super) fn draw_and_read(
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
pub(super) fn assert_frame(pixels: &[[u8; 4]], red_left: bool, stage: &str) {
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
pub(super) fn synthetic_reference(pixels: &[[u8; 4]]) -> Vec<[u8; 4]> {
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
