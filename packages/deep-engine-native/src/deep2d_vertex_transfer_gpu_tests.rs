use super::{HEIGHT, WIDTH, draw_painter_to_pixels, draw_to_pixels, gpu_context, line_ir};
use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};
use deep_engine_native::{
    chart::{ChartIR, ChartSeriesType, render_chart},
    deep2d::Deep2dRuntimeContent,
};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn content(source: &ChartIR) -> Deep2dRuntimeContent {
    Deep2dRuntimeContent::DisplayList(render_chart(source, WIDTH.into(), HEIGHT.into()).unwrap())
}

/// 128 点网格散点:与既有 staged-copy 用例同一夹具,每次调用都是全新实例。
fn scatter_source() -> ChartIR {
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
    source
}

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

/// P1-06 release 计时:单次候选分配独立成本、三场景 stage 墙钟,持久分配器收益上限的证据。
#[test]
#[ignore = "requires a real Vulkan GPU; timings are only meaningful under --release"]
fn staged_vertex_transfer_stage_timing_report() {
    pollster::block_on(async {
        let (device, queue, adapter) = gpu_context().await;
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let format = wgpu::TextureFormat::Rgba8Unorm;
        let cache = Arc::new(Deep2dGpuAssetCache::new());
        let creates = || cache.stats().vertex_buffer_creates;

        // 单次候选分配独立成本:与复制路径同 usage/尺寸,1000 次均值。
        const PROBE_BYTES: u64 = 55_296;
        let probe_usage = wgpu::BufferUsages::VERTEX
            | wgpu::BufferUsages::COPY_SRC
            | wgpu::BufferUsages::COPY_DST;
        let probe_start = Instant::now();
        for _ in 0..1000 {
            let probe = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Deep2d alloc probe"),
                size: PROBE_BYTES,
                usage: probe_usage,
                mapped_at_creation: false,
            });
            std::hint::black_box(&probe);
        }
        let per_alloc = probe_start.elapsed() / 1000;

        // (a) 冷启动一次。
        let mut source = scatter_source();
        let cold_start = Instant::now();
        let mut painter =
            Deep2dGpuPainter::new(&device, &queue, format, &content(&source), &cache).unwrap();
        let cold = cold_start.elapsed();

        // (b) 链式局部更新:内容逐次唯一,避免整内容缓存命中短路。
        const PARTIAL_STAGES: usize = 256;
        let mut partial = Vec::with_capacity(PARTIAL_STAGES);
        for step in 0..PARTIAL_STAGES {
            source.datasets[0].rows[1][1] = json!(0.2 + step as f64 * 1e-4);
            let next_content = content(&source);
            let stage_start = Instant::now();
            let next = painter
                .stage_update(&device, &queue, format, &next_content)
                .unwrap();
            partial.push(stage_start.elapsed());
            painter = next;
        }

        // (c) 链式全量替换:每轮整组行全部变化。
        const FULL_STAGES: usize = 64;
        let mut full = Vec::with_capacity(FULL_STAGES);
        for step in 0..FULL_STAGES {
            source.datasets[0].rows = (0..128usize)
                .map(|i| {
                    vec![
                        json!(0.025 + (i % 16) as f64 * 0.062),
                        json!(0.31 + (((step * 7 + i / 16) % 64) as f64) * 0.008),
                    ]
                })
                .collect::<Vec<_>>()
                .into();
            let next_content = content(&source);
            let stage_start = Instant::now();
            let next = painter
                .stage_update(&device, &queue, format, &next_content)
                .unwrap();
            full.push(stage_start.elapsed());
            painter = next;
        }
        let stats = painter.vertex_transfer_stats();

        let mean = |samples: &[Duration]| samples.iter().sum::<Duration>() / samples.len() as u32;
        let (partial_mean, partial_min) = (mean(&partial), partial.iter().min().unwrap());
        let (full_mean, full_min) = (mean(&full), full.iter().min().unwrap());
        let adapter_name = adapter.get_info().name;
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        assert!(scope.pop().await.is_none());
        println!(
            "vertex transfer stage timing ({adapter_name:?}): per_alloc={per_alloc:?} cold={cold:?} partial mean={partial_mean:?} min={partial_min:?} full mean={full_mean:?} min={full_min:?} creates={} last(up={} copy={} shadow={})",
            creates(),
            stats.uploaded_bytes,
            stats.copied_bytes,
            stats.shadow_bytes
        );
    });
}
