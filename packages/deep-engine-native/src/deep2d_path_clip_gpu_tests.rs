//! RTX readback proving a `clipPathIds` polygon reaches the native draw.

use std::sync::{Arc, mpsc};

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dResource, Deep2dRuntimeContent,
    PathCommand, PathResource,
};

use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};

const WIDTH: u32 = 4;
const ROW_BYTES: u32 = 256;

fn rectangle(id: &str, width: f64) -> Deep2dResource {
    Deep2dResource::Path(PathResource {
        id: id.into(),
        revision: 1,
        verbs: vec![
            Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
            Deep2dPathVerb::Line { x: width, y: 0.0 },
            Deep2dPathVerb::Line { x: width, y: 1.0 },
            Deep2dPathVerb::Line { x: 0.0, y: 1.0 },
            Deep2dPathVerb::Close,
        ],
    })
}

fn content() -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(Deep2dDisplayList {
        schema_version: 1,
        id: "path-clip-gpu".into(),
        revision: 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 1.0,
        resources: vec![rectangle("canvas", 4.0), rectangle("left", 2.0)],
        commands: vec![Deep2dCommand::Path(PathCommand {
            id: "draw:clipped".into(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: Some(vec!["left".into()]),
            clip_rect: None,
            hit_id: None,
            path_id: "canvas".into(),
            fill: Some([0.0, 1.0, 0.0, 1.0]),
            fill_rule: None,
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        })],
        atlases: vec![],
    })
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_path_clip_limits_real_draw_pixels() {
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
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let painter = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content(),
            &cache,
        )
        .expect("path-clipped painter");
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("path clip readback target"),
            size: wgpu::Extent3d {
                width: WIDTH,
                height: 1,
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
            label: Some("path clip readback buffer"),
            size: u64::from(ROW_BYTES),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        let attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::RED),
                store: wgpu::StoreOp::Store,
            },
        })];
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &attachments,
            ..Default::default()
        }));
        painter.draw(&mut encoder, &view, (WIDTH, 1));
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(ROW_BYTES),
                    rows_per_image: Some(1),
                },
            },
            wgpu::Extent3d {
                width: WIDTH,
                height: 1,
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
        let pixels = (0..WIDTH as usize)
            .map(|x| bytes[x * 4..x * 4 + 4].try_into().unwrap())
            .collect::<Vec<[u8; 4]>>();
        assert_eq!(
            pixels,
            vec![
                [0, 255, 0, 255],
                [0, 255, 0, 255],
                [255, 0, 0, 255],
                [255, 0, 0, 255]
            ]
        );
        println!(
            "Deep2d path clip readback OK: adapter={:?} pixels={pixels:?}",
            info.name
        );
    });
}
