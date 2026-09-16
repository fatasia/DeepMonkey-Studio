//! Real-GPU readback proof for a high-DPI Deep2D Image command: an unclipped
//! path fills the target and a blue image clipped to the logical left half may
//! only touch the corresponding physical pixels.

use std::sync::mpsc;

use deep_engine_native::deep2d::{
    Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand, Deep2dDisplayList,
    Deep2dPathVerb, Deep2dRect, Deep2dResource, Deep2dRuntimeContent, ImageColorSpace,
    ImageCommand, ImageResource, ImageSampling, PathCommand, PathResource,
};

use crate::deep2d_gpu::Deep2dGpuPainter;

const WIDTH: u32 = 8;
const HEIGHT: u32 = 2;
const ROW_BYTES: u32 = 256;
const LEFT_CLIP: Deep2dRect = Deep2dRect {
    x: 0.0,
    y: 0.0,
    width: 2.0,
    height: 1.0,
};
const EXPECTED_ROW: [[u8; 4]; 8] = [
    [0, 0, 255, 255],
    [0, 0, 255, 255],
    [0, 0, 255, 255],
    [0, 0, 255, 255],
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [255, 0, 0, 255],
    [255, 0, 0, 255],
];

fn clipped_fill(
    id: &str,
    z_order: i32,
    color: [f64; 4],
    clip: Option<Deep2dRect>,
) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: id.into(),
        z_order,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: clip,
        hit_id: None,
        path_id: "canvas".into(),
        fill: Some(color),
        fill_rule: None,
        stroke: None,
        stroke_width: None,
        line_cap: None,
        line_join: None,
        miter_limit: None,
        dash: None,
        dash_offset: None,
    })
}

fn display_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-clip-gpu".into(),
        revision: 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 2.0,
        resources: vec![
            Deep2dResource::Path(PathResource {
                id: "canvas".into(),
                revision: 1,
                verbs: vec![
                    Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                    Deep2dPathVerb::Line { x: 4.0, y: 0.0 },
                    Deep2dPathVerb::Line { x: 4.0, y: 1.0 },
                    Deep2dPathVerb::Line { x: 0.0, y: 1.0 },
                    Deep2dPathVerb::Close,
                ],
            }),
            Deep2dResource::Image(ImageResource {
                id: "blue".into(),
                revision: 1,
                asset_id: "embedded:blue".into(),
                width: 1,
                height: 1,
                color_space: ImageColorSpace::Srgb,
            }),
        ],
        atlases: vec![Deep2dAtlas {
            id: "blue-atlas".into(),
            revision: 1,
            kind: Deep2dAtlasKind::Image,
            format: Deep2dAtlasFormat::Rgba8UnormSrgb,
            width: 1,
            height: 1,
            sampling: ImageSampling::Nearest,
            data_base64: "AAD//w==".into(),
        }],
        commands: vec![
            clipped_fill("draw:base", 0, [1.0, 0.0, 0.0, 1.0], None),
            Deep2dCommand::Image(ImageCommand {
                id: "draw:blue".into(),
                z_order: 1,
                transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                opacity: None,
                clip_path_ids: None,
                clip_rect: Some(LEFT_CLIP),
                hit_id: None,
                image_id: "blue".into(),
                x: 0.0,
                y: 0.0,
                width: 4.0,
                height: 1.0,
                atlas_id: Some("blue-atlas".into()),
                source: Some([0, 0, 1, 1]),
                sampling: None,
            }),
        ],
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_high_dpi_image_clip_maps_to_physical_pixels() {
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

        let content = Deep2dRuntimeContent::DisplayList(display_list());
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep2d clip readback target"),
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
        let cache = std::sync::Arc::new(crate::deep2d_gpu_cache::Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content,
            &cache,
        )
        .expect("clipped Deep2d painter");

        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Deep2d clip readback buffer"),
            size: u64::from(ROW_BYTES) * u64::from(HEIGHT),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Deep2d clip readback encoder"),
        });
        let clear_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                store: wgpu::StoreOp::Store,
            },
        })];
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Deep2d clip readback clear"),
            color_attachments: &clear_attachments,
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

        let mut pixels = Vec::<[u8; 4]>::new();
        for y in 0..HEIGHT as usize {
            for x in 0..WIDTH as usize {
                let offset = y * ROW_BYTES as usize + x * 4;
                pixels.push(bytes[offset..offset + 4].try_into().unwrap());
            }
        }
        assert_eq!(&pixels[..8], &EXPECTED_ROW);
        assert_eq!(&pixels[8..], &EXPECTED_ROW);
        println!(
            "Deep2d clip readback OK: adapter={:?} pixels={pixels:?} clip={LEFT_CLIP:?}",
            info.name
        );
    });
}
