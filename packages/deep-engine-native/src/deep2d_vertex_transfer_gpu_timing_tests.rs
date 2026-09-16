use super::{content, gpu_context, scatter_source};
use crate::{deep2d_gpu::Deep2dGpuPainter, deep2d_gpu_cache::Deep2dGpuAssetCache};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
