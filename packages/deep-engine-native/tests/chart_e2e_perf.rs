//! P1-10 端到端 CPU/GPU 性能基线:真实窗口(Vulkan,1280×720)下 8 系列 × 8192 行
//! 折线图的七类场景。渲染走生产入口 `chart::presentation::present_chart`(几何 +
//! tooltip 文字 + 图例同链路),每帧拆分:CPU prepare(内容变更、栅格化、stage、编码
//! 与提交)、present 延迟(上一帧 present → 本帧 acquire 完成,含 Fifo 排队)、GPU 帧
//! timestamp(设备支持时)、上传字节(renderer 现有 vertex_transfer_stats)与显存峰值
//! 估计(顶点驻留 + 细分缓存 + 后台缓冲;不含图集纹理与管线对象,估计口径偏低)。
//! 单机单卡固定夹具:不含跨设备对比、不含 FPS 结论、显存为估计值。仅 Release 显式运行:
//! cargo test --release --locked --manifest-path packages/deep-engine-native/Cargo.toml
//!   --test chart_e2e_perf -- --ignored --nocapture --test-threads=1
#![allow(dead_code)] // include 的生产模块带有测试环境走不到的观测访问器
#[path = "../src/deep2d_atlas_gpu.rs"]
mod deep2d_atlas_gpu;
#[path = "../src/deep2d_gpu.rs"]
mod deep2d_gpu;
// deep2d_gpu.rs 的 Windows 绘制签名引用本模块（#[path] 重组装的 bin 侧模块族，
// 缺声明会使测试 crate 内 `crate::dashboard_video_gpu` 解析失败）。
#[path = "../src/dashboard_video_gpu.rs"]
mod dashboard_video_gpu;
#[path = "../src/deep2d_gpu_cache.rs"]
mod deep2d_gpu_cache;
#[path = "../src/deep2d_scissor.rs"]
mod deep2d_scissor;
#[path = "support/chart_e2e_environment.rs"]
mod environment;
#[path = "support/chart_e2e_fixture.rs"]
mod fixture;
#[path = "support/chart_e2e_measurements.rs"]
mod measurements;
#[path = "support/chart_e2e_scenarios.rs"]
mod scenarios;
use deep_engine_native::chart::ChartIR;
use environment::Env;
use fixture::{make_ir, rows};
use measurements::scenario_row;
use serde_json::json;

const WIDTH: u32 = 1280;
const HEIGHT: u32 = 720;
const WARMUP: usize = 5;
const SAMPLES: usize = 30;
const ROWS: usize = 8192;
const TS_SLOTS: usize = 512;
const SLOT_STRIDE: u64 = wgpu::QUERY_RESOLVE_BUFFER_ALIGNMENT;

#[test]
#[cfg(target_os = "windows")]
#[ignore = "explicit Release real-GPU baseline; run with --ignored --nocapture --test-threads=1"]
fn chart_e2e_perf_baseline() {
    let mut env = Env::new();
    let ts_supported = env.ts.is_some();
    let pool: Vec<ChartIR> = (0..4).map(make_ir).collect();
    let local_rows = vec![rows(0), rows(1)];
    println!(
        "{}",
        json!({
            "scenario": "__meta__", "adapter": env.adapter, "backend": "vulkan", "present_mode": "fifo",
            "resolution": format!("{WIDTH}x{HEIGHT}"), "fixture": format!("8 series x {ROWS} rows line chart via present_chart"),
            "declare": "单机单卡固定夹具; 不含跨设备对比与 FPS 结论; est_vram 为估计口径(顶点驻留+细分缓存+后台缓冲, 不含图集纹理与管线); present_delay=上一帧present到本帧acquire完成(含Fifo排队)",
        })
    );
    let rounds = std::env::var("DEEP_CHART_PERF_ROUNDS")
        .map(|value| {
            value
                .parse::<usize>()
                .expect("DEEP_CHART_PERF_ROUNDS must be an integer")
        })
        .unwrap_or(1);
    assert!((1..=20).contains(&rounds), "rounds must be in 1..=20");
    for round in 0..rounds {
        if std::env::var_os("DEEP_CHART_PERF_PROFILE").is_some() {
            env.rasterizer.start_profile();
        }
        if let Some(ts) = &mut env.ts {
            ts.frame = 0;
        }
        run_round(&mut env, &pool, &local_rows, ts_supported, round);
    }
}

fn run_round(
    env: &mut Env,
    pool: &[ChartIR],
    local_rows: &[Vec<Vec<serde_json::Value>>],
    ts_supported: bool,
    round: usize,
) {
    let scenarios = scenarios::scenarios();
    let mut results = Vec::new();
    let mut all_cpu_ms = 0.0;
    for (name, run) in scenarios {
        env.runtime = None;
        env.painter = None;
        env.prev_present = None; // resize 场景把 surface 留在 960;每场景归位 1280 保证后台缓冲口径一致
        env.config.width = WIDTH;
        env.surface.configure(&env.device, &env.config);
        let mut samples = Vec::new();
        let ts_from = env.ts.as_ref().map_or(0, |ts| ts.frame);
        for i in 0..WARMUP + SAMPLES {
            run(env, i, pool, local_rows);
            all_cpu_ms += env.last_sample.as_ref().unwrap().cpu_prepare_ms;
            if i >= WARMUP {
                samples.push(env.last_sample.take().expect("每帧产生一个采样"));
            }
        }
        let period = env.ts_period_ns;
        let gpu_ms = env
            .ts
            .as_ref()
            .map(|ts| ts.collect(&env.device, &env.queue, period, ts_from + WARMUP, ts.frame));
        let mut row = scenario_row(name, samples, gpu_ms, ts_supported);
        row["round"] = json!(round);
        if name == "static_repeat" {
            assert_eq!(row["staged_frames"], 0, "unchanged charts must not restage");
            assert_eq!(row["uploaded_bytes_avg_per_stage"], 0);
        }
        println!("{row}");
        results.push(row);
    }
    println!("--- 汇总(机器可读,一行一个 JSON) ---");
    for row in &results {
        println!("{row}");
    }
    if let Some(profile) = env.rasterizer.profile() {
        println!(
            "{}",
            json!({"scenario":"__meta__", "round":round, "text_profile":profile, "cpu_prepare_total_including_warmup_ms":all_cpu_ms})
        );
    }
}
