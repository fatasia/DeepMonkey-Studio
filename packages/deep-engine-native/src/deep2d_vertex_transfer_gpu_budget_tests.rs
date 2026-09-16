use super::{content, draw_painter_to_pixels, draw_to_pixels, gpu_context, scatter_source};
use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};
use serde_json::json;
use std::sync::Arc;

/// P1-06 三场景基线:(a) 冷启动 (b) 局部改 1 点 (c) 全量替换。
/// 固化字节预算与「旧帧只读」围栏语义;分配次数由 cache creates 增量作证。
#[test]
#[ignore = "requires a real Vulkan GPU"]
fn transfer_scenarios_byte_budgets_and_old_frame_protection() {
    pollster::block_on(async {
        let (device, queue, _) = gpu_context().await;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let creates = |cache: &Deep2dGpuAssetCache| cache.stats().vertex_buffer_creates;

        // (a) 冷启动:恰好一次候选分配,全量 CPU 上传,零 GPU 复制。
        let cold_content = content(&scatter_source());
        let cold = Deep2dGpuPainter::new(&device, &queue, format, &cold_content, &cache).unwrap();
        let total = cold.summary.path.vertices * 24;
        let cold_stats = cold.vertex_transfer_stats();
        assert_eq!(creates(&cache), 1);
        assert_eq!(cold_stats.buffer_allocations, 1);
        assert_eq!(cold_stats.uploaded_bytes, total);
        assert_eq!(cold_stats.copied_bytes, 0);

        // (b) 局部改 1 点:一次分配;传输覆盖全部字节但 CPU 上传只占零头;批次不变。
        let mut partial_source = scatter_source();
        partial_source.datasets[0].rows[1][1] = json!(0.09);
        let partial = cold
            .stage_update(&device, &queue, format, &content(&partial_source))
            .unwrap();
        let partial_stats = partial.vertex_transfer_stats();
        assert_eq!(creates(&cache), 2);
        assert_eq!(partial_stats.buffer_allocations, 1);
        assert_eq!(
            partial_stats.uploaded_bytes + partial_stats.copied_bytes,
            total
        );
        assert!(partial_stats.uploaded_bytes > 0 && partial_stats.uploaded_bytes < total / 2);
        assert!(partial_stats.copied_bytes > total / 2);
        assert_eq!(partial_stats.shadow_bytes, total, "旧帧 CPU 影子随候选保留");
        assert_eq!(
            partial.summary.render_chunks, cold.summary.render_chunks,
            "传输策略不得增删绘制批次"
        );

        // 围栏语义:stage 后旧 painter 逐像素等于冷启动内容(旧缓冲只读 + Arc 生命期)。
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &cold).unwrap(),
            draw_to_pixels(&device, &queue, &cold_content).unwrap()
        );

        // (c) 全量替换:一次分配,零复制,全量上传;局部 CPU 上传严格更小。
        let mut full_source = scatter_source();
        full_source.datasets[0].rows = (0..128usize)
            .map(|i| {
                vec![
                    json!(0.025 + (i % 16) as f64 * 0.062),
                    json!(0.31 + (i / 16) as f64 * 0.011),
                ]
            })
            .collect::<Vec<_>>()
            .into();
        let full = partial
            .stage_update(&device, &queue, format, &content(&full_source))
            .unwrap();
        let full_stats = full.vertex_transfer_stats();
        assert_eq!(creates(&cache), 3);
        assert_eq!(full_stats.buffer_allocations, 1);
        assert_eq!(full_stats.uploaded_bytes, total);
        assert_eq!(full_stats.copied_bytes, 0);
        assert!(partial_stats.uploaded_bytes < full_stats.uploaded_bytes);

        // 候选像素一致;整内容重复 stage 走缓存零分配;旧帧在后续 stage 后仍完好。
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &full).unwrap(),
            draw_to_pixels(&device, &queue, &content(&full_source)).unwrap()
        );
        let again = full
            .stage_update(&device, &queue, format, &content(&full_source))
            .unwrap();
        let again_stats = again.vertex_transfer_stats();
        assert_eq!(again_stats.reused_bytes, total);
        assert_eq!(again_stats.buffer_allocations, 0, "整内容命中零分配");
        assert_eq!(creates(&cache), 3, "整内容命中不得再分配");
        assert_eq!(
            draw_painter_to_pixels(&device, &queue, &cold).unwrap(),
            draw_to_pixels(&device, &queue, &cold_content).unwrap()
        );

        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(scope.pop().await.is_none());
        println!(
            "transfer scenarios: total={total} partial(upload={} copy={}) full(upload={}) allocations={}",
            partial_stats.uploaded_bytes,
            partial_stats.copied_bytes,
            full_stats.uploaded_bytes,
            creates(&cache)
        );
    });
}
