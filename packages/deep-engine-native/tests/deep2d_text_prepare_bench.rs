//! R6-2 A1 裁决基准:真实文字工作负载的 Deep2D CPU prepare(纯 CPU,无 GPU)。
//!
//! fixture:`fixtures/deep2d_runtime_chart_text_v1.json`,由
//! `examples/gen_deep2d_text_fixture.rs` 用生产链路生成:8 系列 × 8192 行 chart IR →
//! Hover 武装真实 tooltip → `present_chart`(cosmic-text shaping + swash 栅格化 +
//! 整段 RGBA atlas base64)→ overlay 文字切片(tooltip + 轴标签 + 图例 + 状态描边,
//! 不含 8192 点系列折线重几何)。32 个文字/图像 run,275,400 解码后 atlas 字节。
//!
//! 常规测试(随 cargo test 全量跑):fixture 解码 + prepare 冒烟 + 真实栅格内容断言。
//!
//! `#[ignore]` 基准(Release 显式运行):
//! `cargo test --release --locked --manifest-path packages/deep-engine-native/Cargo.toml
//!   --test deep2d_text_prepare_bench -- --ignored --nocapture --test-threads=1`
//!
//! 分节:
//! 1. 文字 fixture prepare:decode ×3、冷 ×1、热 ×9、`Deep2dPathCache` 复用 ×8;
//! 2. atlas-only 对照(`deep2d_runtime_atlas_v1.json`)同协议,同进程可比;
//! 3. 生产文字链分段(8×8192 活体图表,文字变更帧 = 交替 Hover;静态帧 = 重复同一
//!    Hover):tooltip/axes/state/legend 分段、`TextRasterizer` profile(measure=shaping
//!    / raster=栅格化)、全链 present→prepare、全帧 prepare vs 文字切片 prepare。
//!
//! 边界:纯 CPU;不含 GPU 上传/stage/present/编码提交;JSON decode 属夹具装载,
//! 不计入每帧口径(生产路径 present 输出内存 display list,无 JSON 往返)。
#![allow(dead_code)] // include 的 perf support 模块带有本基准走不到的辅助函数
use deep_engine_native::chart::{
    ChartAction, ChartRuntime, axis_render, legend_render, presentation::present_chart,
    state_render, tooltip_render,
};
use deep_engine_native::deep2d::{
    Deep2dPathCache, Deep2dRuntimeContent, decode_runtime_content, prepare_runtime_content,
    prepare_runtime_content_cached,
};
use deep_engine_native::native_ui::design_tokens::{DesignTokenSnapshot, validate_design_tokens};
use deep_engine_native::platform_text::TextRasterizer;
use serde_json::json;
use std::time::Instant;

const ROWS: usize = 8192;

#[path = "support/chart_e2e_fixture.rs"]
mod perf_fixture;

fn median(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.total_cmp(b));
    samples[samples.len() / 2]
}

fn ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// 常规回归:真实文字 fixture 必须可解码、可 prepare,且携带真实栅格内容。
#[test]
fn deep2d_text_fixture_prepares_with_real_text_volume() {
    let content = decode_runtime_content(include_bytes!(
        "../fixtures/deep2d_runtime_chart_text_v1.json"
    ))
    .expect("text fixture must parse");
    let Deep2dRuntimeContent::DisplayList(list) = &content else {
        panic!("text fixture must be a display list");
    };
    assert!(
        list.commands.len() >= 40 && list.atlases.len() >= 24,
        "text workload slice too small: commands={} atlases={}",
        list.commands.len(),
        list.atlases.len()
    );
    let prepared = prepare_runtime_content(&content).expect("prepare must pass");
    let summary = &prepared.summary;
    assert!(
        summary.image_quads >= 24,
        "text runs must exist: {summary:?}"
    );
    assert!(
        summary.glyph_quads == 0,
        "chart 文字走整段 image 通道,无 per-glyph quad"
    );
    assert!(
        summary.atlas_bytes >= 200_000,
        "real CJK raster bytes expected"
    );
    assert!(summary.render_chunks > 0 && summary.path.vertices > 0);
    // 真实栅格内容:每个 atlas 都必须有非零像素(空白位图=伪造)。
    for atlas in &prepared.atlases {
        assert!(
            atlas.data.iter().any(|&byte| byte != 0),
            "atlas {} must contain real rasterized pixels",
            atlas.id
        );
    }
}

/// A1 裁决基准(显式 Release)。
#[test]
#[ignore = "explicit Release CPU benchmark; run with --ignored --nocapture --test-threads=1"]
fn deep2d_text_prepare_bench() {
    bench_fixture_prepare();
    bench_atlas_only_control();
    bench_live_text_pipeline();
}

/// 分节 1:文字 fixture 的 decode/prepare(冷、热、path-cache 复用)。
fn bench_fixture_prepare() {
    let bytes = include_bytes!("../fixtures/deep2d_runtime_chart_text_v1.json");
    let mut decode_ms = Vec::new();
    let content = loop {
        let started = Instant::now();
        let content = decode_runtime_content(bytes).expect("fixture must parse");
        decode_ms.push(ms(started));
        if decode_ms.len() >= 3 {
            break content;
        }
    };
    println!(
        "{}",
        json!({"bench": "decode_text_fixture", "samplesMs": decode_ms, "note": "夹具装载口径,不计入每帧"})
    );

    let mut cold_ms = 0.0;
    let mut warm = Vec::new();
    for index in 0..10 {
        let started = Instant::now();
        let prepared = prepare_runtime_content(&content).expect("text fixture prepare must pass");
        let elapsed = ms(started);
        assert!(prepared.summary.image_quads >= 24 && prepared.summary.atlas_bytes > 0);
        if index == 0 {
            cold_ms = elapsed;
        } else {
            warm.push(elapsed);
        }
    }
    println!(
        "{}",
        json!({
            "bench": "prepare_text_fixture_uncached",
            "coldMs": cold_ms,
            "warmMs": warm,
            "medianWarmMs": median(&mut warm),
            "atlasBytes": 275400,
            "imageQuads": 32,
        })
    );

    let mut cache = Deep2dPathCache::default();
    let mut cached_first = 0.0;
    let mut cached_warm = Vec::new();
    for index in 0..8 {
        let started = Instant::now();
        let prepared =
            prepare_runtime_content_cached(&content, &mut cache).expect("cached prepare must pass");
        let elapsed = ms(started);
        assert!(prepared.summary.image_quads >= 24);
        if index == 0 {
            cached_first = elapsed;
        } else {
            cached_warm.push(elapsed);
        }
    }
    println!(
        "{}",
        json!({
            "bench": "prepare_text_fixture_path_cache",
            "firstMs": cached_first,
            "warmMs": cached_warm,
            "medianWarmMs": median(&mut cached_warm),
            "cacheStats": cache.stats(),
        })
    );
}

/// 分节 2:atlas-only 对照(deep2d_runtime_atlas_v1.json,既有 0.0348ms 夹具)。
fn bench_atlas_only_control() {
    let bytes = include_bytes!("../fixtures/deep2d_runtime_atlas_v1.json");
    let content = decode_runtime_content(bytes).expect("control fixture must parse");
    let mut warm = Vec::new();
    for _ in 0..6 {
        let started = Instant::now();
        let prepared = prepare_runtime_content(&content).expect("control prepare must pass");
        assert!(prepared.summary.atlas_bytes > 0 && !prepared.chunks.is_empty());
        warm.push(ms(started));
    }
    println!(
        "{}",
        json!({"bench": "prepare_atlas_only_control", "warmMs": warm, "medianWarmMs": median(&mut warm)})
    );

    let mut cache = Deep2dPathCache::default();
    let mut cached_warm = Vec::new();
    for _ in 0..6 {
        let started = Instant::now();
        prepare_runtime_content_cached(&content, &mut cache).expect("cached control must pass");
        cached_warm.push(ms(started));
    }
    println!(
        "{}",
        json!({"bench": "prepare_atlas_only_control_cached", "warmMs": cached_warm, "medianWarmMs": median(&mut cached_warm)})
    );
}

/// 分节 3:生产文字链分段(活体 8×8192 图表,perf 同款标签)。
///
/// 文字变更帧:交替 Hover(data_index 0/1)→ tooltip 文本逐帧重 shape/重栅格;
/// 静态文字帧:重复同一 Hover → shaping 仍逐帧发生(fit/measure),swash 缓存命中。
/// 两种帧各自 20 采样(5 预热),采样段落:分段 compose、present 全链、
/// 文字切片 prepare、全帧 prepare(含 8×8191 段折线细分)。
fn bench_live_text_pipeline() {
    let mut chart = ChartRuntime::new(perf_fixture::make_ir(0), 1280.0, 720.0).unwrap();
    let base = chart.frame().display_list().clone();
    let (base_commands, base_resources) = (base.commands.len(), base.resources.len());
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    validate_design_tokens(&tokens).unwrap();

    let started = Instant::now();
    let mut rasterizer = TextRasterizer::new();
    let font_init_ms = ms(started);
    let warmup = 5usize;
    let samples = 20usize;

    let mut result = Vec::new();
    for (phase, changing) in [("text_change_frames", true), ("static_text_frames", false)] {
        let (mut tooltip, mut axes, mut state, mut legend) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let (mut present, mut prepare_slice, mut prepare_full) =
            (Vec::new(), Vec::new(), Vec::new());
        let (mut measure_calls, mut measure_nanos, mut raster_calls, mut raster_nanos) =
            (0u64, 0u128, 0u64, 0u128);
        let mut slice_atlas_bytes: Option<usize> = None;
        for index in 0..warmup + samples {
            let hover_index = if changing { index % 2 } else { 0 };
            chart
                .dispatch(ChartAction::Hover {
                    series_id: "series-0".into(),
                    data_index: hover_index,
                    x_label: format!("设备-{hover_index}"),
                    value: format!("{hover_index}.00"),
                })
                .map(|_| ())
                .unwrap();
            rasterizer.start_profile();

            let t = Instant::now();
            let mut list = tooltip_render::compose_tooltip(
                &chart,
                &mut rasterizer,
                &tokens.themes.dark,
                [100.0, 100.0],
            )
            .unwrap();
            let tooltip_ms = ms(t);
            let t = Instant::now();
            axis_render::append_axes(&mut list, &chart, &mut rasterizer, &tokens.themes.dark)
                .unwrap();
            let axes_ms = ms(t);
            let t = Instant::now();
            state_render::append_state_outlines(&mut list, &chart, &tokens.themes.dark).unwrap();
            let state_ms = ms(t);
            let t = Instant::now();
            legend_render::append_legend(
                &mut list,
                &chart,
                &mut rasterizer,
                &tokens.themes.dark,
                0,
                None,
            )
            .unwrap();
            let legend_ms = ms(t);
            let t = Instant::now();
            let full = present_chart(&chart, &mut rasterizer, 0, [100.0, 100.0], None).unwrap();
            let present_ms = ms(t);

            // 文字切片 prepare(overlay 命令 + 被引用资源,不含系列折线)。
            let slice = overlay_slice(&full, base_commands);
            let t = Instant::now();
            let prepared_slice =
                prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(slice)).unwrap();
            let slice_ms = ms(t);
            assert!(prepared_slice.summary.image_quads >= 24);
            if index == 0 {
                slice_atlas_bytes = Some(prepared_slice.summary.atlas_bytes);
            }
            // 全帧 prepare(含 8 系列 × 8191 段折线细分)。
            let t = Instant::now();
            let prepared_full =
                prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(full)).unwrap();
            let full_ms = ms(t);
            assert!(prepared_full.summary.path.vertices > prepared_slice.summary.path.vertices);

            if index >= warmup {
                tooltip.push(tooltip_ms);
                axes.push(axes_ms);
                state.push(state_ms);
                legend.push(legend_ms);
                present.push(present_ms);
                prepare_slice.push(slice_ms);
                prepare_full.push(full_ms);
                if let Some(profile) = rasterizer.profile() {
                    measure_calls += profile.measure_calls;
                    measure_nanos += profile.measure_nanos;
                    raster_calls += profile.raster_calls;
                    raster_nanos += profile.raster_nanos;
                }
            }
        }
        result.push(json!({
            "phase": phase,
            "composeStageMedianMs": {
                "tooltip": median(&mut tooltip),
                "axes": median(&mut axes),
                "state": median(&mut state),
                "legend": median(&mut legend),
            },
            "presentTotalMedianMs": median(&mut present),
            "prepareSliceTextMedianMs": median(&mut prepare_slice),
            "prepareFullFrameMedianMs": median(&mut prepare_full),
            "sliceAtlasBytes": slice_atlas_bytes,
            "rasterProfileTotalsMeasuredFramesOnly": {
                "measureCalls": measure_calls,
                "measureNanos": measure_nanos,
                "rasterCalls": raster_calls,
                "rasterNanos": raster_nanos,
            },
        }));
    }

    // 定界探针:同一进程、全热状态下重跑 fixture prepare——判定
    // "fixture 首节 prepare vs 活体切片 prepare" 的差异是机器状态还是内容差异。
    let content = decode_runtime_content(include_bytes!(
        "../fixtures/deep2d_runtime_chart_text_v1.json"
    ))
    .expect("fixture must parse");
    let mut reprise = Vec::new();
    for _ in 0..6 {
        let started = Instant::now();
        prepare_runtime_content(&content).expect("reprise prepare must pass");
        reprise.push(ms(started));
    }
    println!(
        "{}",
        json!({
            "bench": "prepare_text_fixture_reprise_after_live",
            "warmMs": reprise,
            "medianWarmMs": median(&mut reprise),
            "declare": "与 bench_fixture_prepare 同一 content;区别仅是进程内执行时点",
        })
    );
    println!(
        "{}",
        json!({
            "bench": "text_pipeline_live_8x8192",
            "fontInitColdMs": font_init_ms,
            "baseFrameCommands": base_commands,
            "baseFrameResources": base_resources,
            "phases": result,
            "declare": "纯 CPU;tooltip 值/轴/图例/状态为生产分段函数;prepareSlice 为文字工作负载口径,prepareFull 含折线几何细分;不含 GPU",
        })
    );
}

/// overlay 文字切片:去掉 baseline 几何命令与未被引用的资源(与生成器同规则)。
fn overlay_slice(
    full: &deep_engine_native::deep2d::Deep2dDisplayList,
    base_commands: usize,
) -> deep_engine_native::deep2d::Deep2dDisplayList {
    use deep_engine_native::deep2d::{Deep2dCommand, Deep2dResource};
    let mut keep = std::collections::BTreeSet::new();
    for command in &full.commands {
        match command {
            Deep2dCommand::Path(path) => {
                keep.insert(path.path_id.clone());
                if let Some(clips) = &path.clip_path_ids {
                    keep.extend(clips.iter().cloned());
                }
            }
            Deep2dCommand::Text(text) => {
                keep.insert(text.font_id.clone());
                if let Some(atlas) = &text.atlas_id {
                    keep.insert(atlas.clone());
                }
                if let Some(clips) = &text.clip_path_ids {
                    keep.extend(clips.iter().cloned());
                }
            }
            Deep2dCommand::Image(image) => {
                keep.insert(image.image_id.clone());
                if let Some(atlas) = &image.atlas_id {
                    keep.insert(atlas.clone());
                }
                if let Some(clips) = &image.clip_path_ids {
                    keep.extend(clips.iter().cloned());
                }
            }
        }
    }
    let mut sliced = full.clone();
    sliced.commands = full.commands[base_commands..].to_vec();
    sliced.resources = full
        .resources
        .iter()
        .filter(|resource| {
            let id = match resource {
                Deep2dResource::Path(path) => &path.id,
                Deep2dResource::Font(font) => &font.id,
                Deep2dResource::Image(image) => &image.id,
            };
            keep.contains(id)
        })
        .cloned()
        .collect();
    sliced.atlases = full
        .atlases
        .iter()
        .filter(|atlas| keep.contains(&atlas.id))
        .cloned()
        .collect();
    sliced
}
