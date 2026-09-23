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
// deep2d_gpu.rs 的 Windows 绘制签名引用本模块（#[path] 重组装的 bin 侧模块族）。
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu;
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache;
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor;

use deep_engine_native::deep2d::{BakedGlyphPlacement, Deep2dCommand, compare};
use std::sync::Arc;

#[path = "support/deep2d_mixed_content_fixture.rs"]
mod fixture;
use fixture::{SWAPPED_TILES, base_list, content};
#[path = "support/deep2d_mixed_content_gpu_readback.rs"]
mod readback;
use readback::{assert_frame, draw_and_read, gpu_device, synthetic_reference};

const WIDTH: u32 = 20;
const HEIGHT: u32 = 20;
const ROW_PIXELS: usize = 64; // 256-byte aligned copy rows
const BG: [u8; 4] = [255, 0, 0, 255];

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
