//! RTX readback for direct baked Text commands and failed-candidate rollback.

use std::sync::{Arc, mpsc};

use deep_engine_native::deep2d::{
    BakedGlyphPlacement, Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand,
    Deep2dDisplayList, Deep2dResource, Deep2dRuntimeContent, FontResource, FontStyle,
    ImageSampling, TextCommand,
};

use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};

const WIDTH: u32 = 4;
const ROW_BYTES: u32 = 256;

fn display_list(valid: bool) -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "direct-text-gpu".into(),
        revision: u64::from(valid) + 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Font(FontResource {
            id: "font:probe".into(),
            revision: 1,
            asset_id: "embedded:probe".into(),
            family: "Probe".into(),
            weight: 400,
            style: FontStyle::Normal,
        })],
        atlases: vec![Deep2dAtlas {
            id: "glyphs".into(),
            revision: 1,
            kind: Deep2dAtlasKind::Glyph,
            format: Deep2dAtlasFormat::R8Unorm,
            width: 1,
            height: 1,
            sampling: ImageSampling::Nearest,
            data_base64: "/w==".into(),
        }],
        commands: vec![Deep2dCommand::Text(TextCommand {
            id: "draw:glyph".into(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: None,
            hit_id: None,
            text: "A".into(),
            x: 0.0,
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
                source: if valid { [0, 0, 1, 1] } else { [1, 0, 1, 1] },
                destination: [0.0, 0.0, 2.0, 1.0],
            }]),
        })],
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_direct_text_draws_and_failed_update_keeps_active() {
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
        let active_content = Deep2dRuntimeContent::DisplayList(display_list(true));
        let active = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &active_content,
            &cache,
        )
        .expect("valid baked text");
        let invalid = Deep2dRuntimeContent::DisplayList(display_list(false));
        let error =
            match active.stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &invalid) {
                Ok(_) => panic!("out-of-bounds glyph candidate was accepted"),
                Err(error) => error,
            };
        assert!(error.contains("Glyph source"), "{error}");

        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("direct text readback target"),
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
            label: Some("direct text readback buffer"),
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
        active.draw(&mut encoder, &view, (WIDTH, 1));
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
            "Direct baked Text readback OK: adapter={:?} pixels={pixels:?} rollback={error}",
            info.name
        );
    });
}
