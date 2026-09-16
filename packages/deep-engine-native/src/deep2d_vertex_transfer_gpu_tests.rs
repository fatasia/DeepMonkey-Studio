use super::{HEIGHT, WIDTH, draw_painter_to_pixels, draw_to_pixels, gpu_context, line_ir};
use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};
use deep_engine_native::{chart::ChartSeriesType, deep2d::Deep2dRuntimeContent};
use serde_json::json;
use std::sync::Arc;

#[path = "deep2d_vertex_transfer_gpu_fixtures.rs"]
mod fixtures;
use fixtures::{content, scatter_source};
#[path = "deep2d_vertex_transfer_gpu_budget_tests.rs"]
mod budgets;
#[path = "deep2d_vertex_transfer_gpu_timing_tests.rs"]
mod timing;

#[test]
#[ignore = "requires a real Vulkan GPU"]
fn staged_vertex_copies_preserve_pixels_old_buffer_and_draw_batches() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let mut source = line_ir(
            (0..128)
                .map(|i| {
                    (
                        0.025 + (i % 16) as f64 * 0.062,
                        0.05 + (i / 16) as f64 * 0.12,
                    )
                })
                .collect(),
        );
        source.legend.visible = false;
        source.series[0].series_type = ChartSeriesType::Scatter;
        for axis in &mut source.axes {
            axis.min = Some(0.0);
            axis.max = Some(1.0);
        }
        let original_content = content(&source);
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let original = Deep2dGpuPainter::new(
            &device,
            &queue,
            wgpu::TextureFormat::Rgba8Unorm,
            &original_content,
            &cache,
        )
        .unwrap();
        let cache_before = original.path_cache_stats();
        let original_pixels = draw_painter_to_pixels(&device, &queue, &original).unwrap();
        source.datasets[0].rows[1][1] = json!(0.09);
        let changed_content = content(&source);
        let changed = original
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &changed_content,
            )
            .unwrap();
        let stats = changed.vertex_transfer_stats();
        let tessellation = changed.path_cache_stats();
        assert_eq!(tessellation.misses - cache_before.misses, 1);
        assert_eq!(tessellation.hits - cache_before.hits, 127);
        assert!(stats.uploaded_bytes > 0 && stats.copied_bytes > 0);
        assert_eq!(
            stats.uploaded_bytes + stats.copied_bytes,
            changed.summary.path.vertices * 24
        );
        assert_eq!(
            changed.summary.render_chunks,
            original.summary.render_chunks
        );
        let changed_pixels = draw_painter_to_pixels(&device, &queue, &changed).unwrap();
        assert_ne!(changed_pixels, original_pixels);
        assert_eq!(
            changed_pixels,
            draw_to_pixels(&device, &queue, &changed_content).unwrap()
        );
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &original).unwrap(),
            original_pixels
        );

        source.datasets[0].rows.swap(0, 127);
        let reordered_content = content(&source);
        let reordered = changed
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &reordered_content,
            )
            .unwrap();
        assert_eq!(reordered.vertex_transfer_stats().uploaded_bytes, 0);
        assert_eq!(
            reordered.vertex_transfer_stats().copied_bytes,
            reordered.summary.path.vertices * 24
        );
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &reordered).unwrap(),
            draw_to_pixels(&device, &queue, &reordered_content).unwrap()
        );

        let same = reordered
            .stage_update(
                &device,
                &queue,
                wgpu::TextureFormat::Rgba8Unorm,
                &reordered_content,
            )
            .unwrap();
        assert_eq!(
            same.vertex_transfer_stats().reused_bytes,
            same.summary.path.vertices * 24
        );
        assert_eq!(same.vertex_transfer_stats().uploaded_bytes, 0);
        let mut invalid = reordered_content.clone();
        let Deep2dRuntimeContent::DisplayList(list) = &mut invalid else {
            unreachable!()
        };
        list.scale_factor = 0.0;
        let before_invalid = reordered.path_cache_stats();
        assert!(
            reordered
                .stage_update(&device, &queue, wgpu::TextureFormat::Rgba8Unorm, &invalid)
                .is_err()
        );
        assert_eq!(reordered.path_cache_stats(), before_invalid);
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &original).unwrap(),
            original_pixels
        );
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(scope.pop().await.is_none());
        println!(
            "Deep2d vertex transfer GPU {:?}: uploaded={} copied={} total={} chunks={} path_hits={} path_misses={}",
            adapter.get_info().name,
            stats.uploaded_bytes,
            stats.copied_bytes,
            changed.summary.path.vertices * 24,
            changed.summary.render_chunks,
            tessellation.hits - cache_before.hits,
            tessellation.misses - cache_before.misses
        );
    });
}
