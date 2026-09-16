//! Real-GPU proof for the Deep2d cross-frame asset cache: rebuilding painters
//! over changed display lists must reuse atlas textures (same id+data), reuse
//! vertex buffers when vertex bytes are identical, and upload only what changed.

use std::sync::Arc;

use deep_engine_native::deep2d::{
    Deep2dAtlas, Deep2dAtlasFormat, Deep2dAtlasKind, Deep2dCommand, Deep2dDisplayList,
    Deep2dPathVerb, Deep2dRect, Deep2dResource, Deep2dRuntimeContent, ImageColorSpace,
    ImageCommand, ImageResource, ImageSampling, PathCommand, PathResource,
};

use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};

const TILE_ATLAS_BASE64: &str = "/wAA/wAA//8=";

fn atlas() -> Deep2dAtlas {
    Deep2dAtlas {
        id: "tiles".into(),
        revision: 1,
        kind: Deep2dAtlasKind::Image,
        format: Deep2dAtlasFormat::Rgba8UnormSrgb,
        width: 2,
        height: 1,
        sampling: ImageSampling::Nearest,
        data_base64: TILE_ATLAS_BASE64.into(),
    }
}

fn image_command(id: &str, x: f64, atlas_id: Option<&str>) -> Deep2dCommand {
    Deep2dCommand::Image(ImageCommand {
        id: id.into(),
        z_order: 0,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: None,
        hit_id: None,
        image_id: "img".into(),
        x,
        y: 0.0,
        width: 2.0,
        height: 1.0,
        atlas_id: atlas_id.map(str::to_owned),
        source: atlas_id.map(|_| [0u32, 0, 2, 1]),
        sampling: None,
    })
}

fn path_command(id: &str, x: f64) -> Deep2dCommand {
    Deep2dCommand::Path(PathCommand {
        id: id.into(),
        z_order: 1,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        opacity: None,
        clip_path_ids: None,
        clip_rect: Some(Deep2dRect {
            x,
            y: 0.0,
            width: 1.0,
            height: 1.0,
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
    })
}

fn display_list(image_x: f64, with_path: bool) -> Deep2dDisplayList {
    let mut commands = vec![image_command("draw:tile", image_x, Some("tiles"))];
    if with_path {
        commands.push(path_command("draw:clip", 3.0));
    }
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-cache-gpu".into(),
        revision: 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Image(ImageResource {
            id: "img".into(),
            revision: 1,
            asset_id: "asset:img".into(),
            width: 2,
            height: 1,
            color_space: ImageColorSpace::Srgb,
        })],
        commands,
        atlases: vec![atlas()],
    }
}

fn path_only_display_list() -> Deep2dDisplayList {
    Deep2dDisplayList {
        schema_version: 1,
        id: "deep2d-cache-gpu".into(),
        revision: 1,
        logical_width: 4.0,
        logical_height: 1.0,
        scale_factor: 1.0,
        resources: vec![Deep2dResource::Path(PathResource {
            id: "frame".into(),
            revision: 1,
            verbs: vec![
                Deep2dPathVerb::Move { x: 0.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 4.0, y: 0.0 },
                Deep2dPathVerb::Line { x: 4.0, y: 1.0 },
                Deep2dPathVerb::Line { x: 0.0, y: 1.0 },
                Deep2dPathVerb::Close,
            ],
        })],
        commands: vec![path_command("draw:solo", 0.0)],
        atlases: Vec::new(),
    }
}

#[test]
#[ignore = "requires a real GPU; run explicitly with --ignored"]
fn nvidia_deep2d_cache_reuses_across_display_list_updates() {
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

        // A: image quad at x=0 with the atlas.
        let content_a = Deep2dRuntimeContent::DisplayList(display_list(0.0, false));
        let painter_a = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &content_a,
            &cache,
        )
        .expect("painter A");
        let stats_a = cache.stats();
        assert_eq!(stats_a.atlas_texture_creates, 1);
        assert_eq!(stats_a.vertex_buffer_creates, 1);
        let atlas_ptr = Arc::as_ptr(painter_a.resident_atlas(0).expect("resident atlas"));

        // B: same atlas, image moved — atlas texture reused, image vertices re-uploaded.
        let content_b = Deep2dRuntimeContent::DisplayList(display_list(2.0, false));
        let painter_b = painter_a
            .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &content_b)
            .expect("painter B");
        let stats_b = cache.stats();
        assert_eq!(stats_b.frame_layout_creates, 1);
        assert_eq!(stats_b.frame_layout_hits, 1);
        assert_eq!(stats_b.atlas_pipeline_hits, 1);
        assert_eq!(stats_b.atlas_texture_creates, 1, "same id+data must reuse");
        assert_eq!(stats_b.atlas_texture_hits, 1);
        assert_eq!(
            stats_b.vertex_buffer_creates, 2,
            "moved image changes vertices"
        );
        let reused_ptr = Arc::as_ptr(painter_b.resident_atlas(0).expect("resident atlas"));
        assert_eq!(
            atlas_ptr, reused_ptr,
            "atlas texture must be the same object"
        );

        // A again: identical vertex bytes reuse the original upload.
        let content_a_again = Deep2dRuntimeContent::DisplayList(display_list(0.0, false));
        let painter_a2 = painter_b
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &content_a_again,
            )
            .expect("painter A rebuilt");
        let stats_a2 = cache.stats();
        assert_eq!(stats_a2.vertex_buffer_creates, 2, "identical bytes reuse");
        assert_eq!(stats_a2.vertex_buffer_hits, 1);

        // D06: every staged painter shares the same logical size, so the
        // frame uniform buffer + bind group must be reused, not rebuilt.
        assert_eq!(stats_a2.frame_buffer_creates, 1, "one frame upload");
        assert_eq!(
            stats_a2.frame_buffer_hits, 2,
            "B and A-again both hit the frame resources created by A"
        );
        assert_eq!(
            Arc::as_ptr(painter_b.frame_resources_test()) as usize,
            Arc::as_ptr(painter_a2.frame_resources_test()) as usize,
            "frame buffer/bind group must be the same object across updates"
        );
        drop(painter_a);

        // A path-only display list after image content still builds through the
        // same cache without touching atlas counters.
        let content_path = Deep2dRuntimeContent::DisplayList(path_only_display_list());
        let painter_path = painter_a2
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &content_path,
            )
            .expect("path-only painter");
        let stats_path = cache.stats();
        assert_eq!(stats_path.atlas_texture_creates, 1);
        assert_eq!(
            stats_path.path_pipeline_creates, 1,
            "one path pipeline per format"
        );
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Deep2D cache compatibility target"),
            size: wgpu::Extent3d {
                width: 4,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let validation = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut encoder = device.create_command_encoder(&Default::default());
        painter_b.draw(&mut encoder, &view, (4, 1));
        queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(
            validation.pop().await.is_none(),
            "reused pipeline layout must draw"
        );
        drop(painter_a2);
        drop(painter_b);
        drop(painter_path);

        println!(
            "Deep2d cache reuse OK: adapter={:?} atlas_creates={} atlas_hits={} vertex_creates={} vertex_hits={}",
            info.name,
            stats_path.atlas_texture_creates,
            stats_path.atlas_texture_hits,
            stats_path.vertex_buffer_creates,
            stats_path.vertex_buffer_hits
        );
    });
}
