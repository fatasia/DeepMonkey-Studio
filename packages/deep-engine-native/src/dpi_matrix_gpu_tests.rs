//! Full-tier DPI matrix (painter level): the same logical display list is
//! presented at 100/125/150/200% scale factors, and the letterbox mapping
//! must land a probe rectangle at the mathematically expected physical
//! pixels on every tier. True-window interaction (winit resize/ime) stays
//! in the app lane; this matrix proves the renderer half of the contract.

use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dPathVerb, Deep2dRect, Deep2dResource,
    Deep2dRuntimeContent, PathCommand, PathResource,
};

use crate::deep2d_gpu::Deep2dGpuPainter;
use crate::deep2d_gpu_cache::Deep2dGpuAssetCache;

fn probe_display_list() -> Deep2dDisplayList {
    // One red square in logical space: [10, 10, 20, 20] on a 100x100 canvas.
    Deep2dDisplayList {
        schema_version: 1,
        id: "dpi-matrix".into(),
        revision: 1,
        logical_width: 100.0,
        logical_height: 100.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Path(PathResource {
            id: "probe".into(),
            revision: 1,
            verbs: vec![
                Deep2dPathVerb::Move { x: 10.0, y: 10.0 },
                Deep2dPathVerb::Line { x: 30.0, y: 10.0 },
                Deep2dPathVerb::Line { x: 30.0, y: 30.0 },
                Deep2dPathVerb::Line { x: 10.0, y: 30.0 },
                Deep2dPathVerb::Close,
            ],
        })],
        commands: vec![Deep2dCommand::Path(PathCommand {
            id: "draw:probe".into(),
            z_order: 0,
            transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            opacity: None,
            clip_path_ids: None,
            clip_rect: Some(Deep2dRect {
                x: 10.0,
                y: 10.0,
                width: 20.0,
                height: 20.0,
            }),
            hit_id: None,
            path_id: "probe".into(),
            fill: Some([1.0, 0.0, 0.0, 1.0]),
            fill_rule: None,
            stroke: None,
            stroke_width: None,
            line_cap: None,
            line_join: None,
            miter_limit: None,
            dash: None,
            dash_offset: None,
        })],
        atlases: Vec::new(),
    }
}

/// Expected letterbox geometry: scale = min(pw/100, ph/100); with a square
/// target the probe occupies scale*20 pixels starting at scale*10.
fn expected_probe_span(physical: u32) -> (u32, u32) {
    let scale = f64::from(physical) / 100.0;
    let start = (10.0 * scale).floor() as u32;
    let end = (30.0 * scale).ceil().min(f64::from(physical)) as u32;
    (start, end - start)
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_probe_square_lands_on_expected_pixels_across_dpi_tiers() {
    pollster::block_on(async {
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = wgpu::Backends::VULKAN;
        let instance = wgpu::Instance::new(descriptor);
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions::default())
            .await
            .expect("real GPU adapter");
        let info = adapter.get_info();
        assert_ne!(info.device_type, wgpu::DeviceType::Cpu);
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .unwrap();

        for (tier_name, physical) in [
            ("100%", 100u32),
            ("125%", 125),
            ("150%", 150),
            ("200%", 200),
        ] {
            let cache = std::sync::Arc::new(Deep2dGpuAssetCache::new());
            let painter = Deep2dGpuPainter::new(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &Deep2dRuntimeContent::DisplayList(probe_display_list()),
                &cache,
            )
            .expect("probe list prepares");
            let target = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("dpi probe target"),
                size: wgpu::Extent3d {
                    width: physical,
                    height: physical,
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
            let mut encoder = device.create_command_encoder(&Default::default());
            painter.draw(&mut encoder, &view, (physical, physical));
            // COPY_BYTES_PER_ROW_ALIGNMENT (256) must hold even when the
            // tier's row width does not: pad the row and size the buffer
            // for the padded stride.
            let row_stride = physical * 4;
            let padded_stride = row_stride.div_ceil(256) * 256;
            let readback = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("dpi readback"),
                size: u64::from(padded_stride * physical),
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            });
            encoder.copy_texture_to_buffer(
                target.as_image_copy(),
                wgpu::TexelCopyBufferInfo {
                    buffer: &readback,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(padded_stride),
                        rows_per_image: Some(physical),
                    },
                },
                wgpu::Extent3d {
                    width: physical,
                    height: physical,
                    depth_or_array_layers: 1,
                },
            );
            queue.submit([encoder.finish()]);
            readback.map_async(wgpu::MapMode::Read, .., |result| {
                result.expect("map");
            });
            device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            let mapped = readback
                .get_mapped_range(..)
                .map_err(|error| format!("map: {error}"))
                .unwrap();
            let pixels: Vec<[u8; 4]> = mapped
                .chunks_exact(4)
                .map(|chunk| [chunk[0], chunk[1], chunk[2], chunk[3]])
                .collect();
            drop(mapped);
            readback.unmap();
            drop(painter);

            // Count red pixels; the probe square must cover ~ (20*scale)^2.
            let red = pixels
                .iter()
                .filter(|pixel| pixel[0] > 200 && pixel[3] == 255)
                .count();
            let (start, span) = expected_probe_span(physical);
            let expected = span * span;
            let tolerance = (expected as f64 * 0.15) as u32;
            assert!(
                (red as i64 - expected as i64).abs() <= i64::from(tolerance),
                "tier {tier_name}: red={red} expected≈{expected} (probe at [{start},+{span}])"
            );
            println!(
                "DPI tier {tier_name} @{physical}px: probe span={span} red_pixels={red} expected≈{expected} OK"
            );
        }
    });
}
