//! P1-05 有界 chunk/view ABI 的克隆与惰性视图度量:
//! ChartRuntime 克隆只复制句柄;增量更新按 chunk 句柄复用;扁平视图
//! 首次读取物化一次。8 系列 x 8192 行,release 基准仿 chart_rows_snapshot.rs。
use deep_engine_native::chart::{
    ChartDataUpdate, ChartIR, ChartRuntime, DatasetRowsUpdate, parse_chart_ir,
};
use deep_engine_native::deep2d::Deep2dDisplayList;
use serde_json::json;
use std::{hint::black_box, time::Instant};

fn fixture(rows: usize) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    let line = ir.series.iter().find(|s| s.id == "line").unwrap().clone();
    let dataset = ir.datasets[0].clone();
    ir.series.clear();
    ir.datasets.clear();
    for i in 0..8 {
        let mut series = line.clone();
        let mut dataset = dataset.clone();
        series.id = format!("line-{i}");
        series.dataset_id = series.id.clone();
        dataset.id = series.id.clone();
        dataset.rows = (0..rows)
            .map(|x| {
                vec![
                    json!(x),
                    json!(4.0 + (x as f64 * 0.03 + i as f64).sin()),
                    json!(0.5),
                    json!("泵"),
                ]
            })
            .collect();
        ir.series.push(series);
        ir.datasets.push(dataset);
    }
    ir
}

fn patch_first_series(chart: &mut ChartRuntime) {
    let revision = chart.data_revision();
    chart
        .update_data(ChartDataUpdate {
            expected_data_revision: revision,
            data_revision: revision + 1,
            datasets: vec![DatasetRowsUpdate::Replace {
                dataset_id: "line-0".into(),
                rows: vec![vec![json!(0), json!(7.5), json!(0.5), json!("泵")]],
            }],
        })
        .unwrap();
}

#[test]
fn runtime_clone_shares_the_frame_handle_and_reads_share_the_materialized_view() {
    let chart = ChartRuntime::new(fixture(64), 640.0, 360.0).unwrap();
    let snapshot = chart.clone();
    assert!(
        std::ptr::eq(chart.frame(), snapshot.frame()),
        "克隆共享同一帧,不复制任何命令内存"
    );
    let view: *const Deep2dDisplayList = chart.frame().display_list();
    assert!(std::ptr::eq(chart.frame().display_list(), view));
    assert!(
        snapshot.frame().display_list().commands.len()
            == chart.frame().display_list().commands.len()
    );
}

#[test]
#[ignore = "explicit CPU benchmark; run with --release --ignored --nocapture"]
fn benchmark_runtime_clone_and_lazy_view_materialize() {
    let chart = ChartRuntime::new(fixture(8192), 1280.0, 720.0).unwrap();
    let mut clones = Vec::new();
    let mut patches = Vec::new();
    let mut firsts = Vec::new();
    let mut repeats = Vec::new();
    for round in 0..25 {
        let record = round >= 5;
        // (a) 运行时快照克隆:Arc 句柄 + 交互状态,与帧大小无关。
        let start = Instant::now();
        let snapshot = chart.clone();
        let clone_elapsed = start.elapsed().as_secs_f64() * 1000.0;
        black_box(&snapshot);
        if record {
            clones.push(clone_elapsed);
        }
        // (b) 局部数据更新:重建 line-0,其余 7 系列只克隆 chunk 句柄;
        //     旧实现在此复制全部未变系列的命令/资源(全量 memcpy)。
        let mut working = chart.clone();
        let start = Instant::now();
        patch_first_series(&mut working);
        let patch_elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if record {
            patches.push(patch_elapsed);
        }
        // (c) 首次读取扁平视图:把 chunk 拼接为一份(旧实现把它计入每次 prepare)。
        let start = Instant::now();
        black_box(working.frame().display_list());
        let first_elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if record {
            firsts.push(first_elapsed);
        }
        // (d) 重复读取:缓存命中,不重建。
        let start = Instant::now();
        black_box(working.frame().display_list());
        let repeat_elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if record {
            repeats.push(repeat_elapsed);
        }
    }
    for samples in [&mut clones, &mut patches, &mut firsts, &mut repeats] {
        samples.sort_by(f64::total_cmp);
    }
    println!(
        "{}",
        json!({"build": if cfg!(debug_assertions) {"debug"} else {"release"},
        "series": 8, "rowsPerSeries": 8192, "warmup": 5, "samples": 20, "width": 1280.0, "height": 720.0,
        "runtimeCloneMedianMs": clones[10], "runtimeCloneP95Ms": clones[18],
        "partialUpdateMedianMs": patches[10], "partialUpdateP95Ms": patches[18],
        "firstViewReadMedianMs": firsts[10], "firstViewReadP95Ms": firsts[18],
        "repeatViewReadMedianMs": repeats[10], "repeatViewReadP95Ms": repeats[18],
        "scope": "a=ChartRuntime clone; b=one-dataset patch rebuilding line-0 only (excludes flat view); \
            c=first display_list() after patch; d=cached re-read; excludes source patch JSON and GPU"})
    );
}

/// P1-05 第二批的决策基准:**呈现路径的多余克隆**。
///
/// `tooltip_render::compose_tooltip` 每次呈现都对 `frame().display_list()` 做一次
/// 完整 clone(之后才追加 tooltip/图例层)。本基准量化这份 clone 的真实成本,
/// 作为「是否值得让呈现路径直接消费 chunk」的判据——先测量再改造。
#[test]
#[ignore = "explicit CPU benchmark; run with --release --ignored --nocapture"]
fn benchmark_presentation_layer_clone_cost() {
    let chart = ChartRuntime::new(fixture(8192), 1280.0, 720.0).unwrap();
    black_box(chart.frame().display_list()); // 预热:扁平视图先物化,与生产首帧一致
    let commands = chart.frame().display_list().commands.len();
    let resources = chart.frame().display_list().resources.len();

    let mut clones = Vec::new();
    for round in 0..25 {
        let record = round >= 5;
        // 就是 compose_tooltip 第一行做的那件事。
        let start = Instant::now();
        let copy = chart.frame().display_list().clone();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        black_box(&copy);
        if record {
            clones.push(elapsed);
        }
    }
    clones.sort_by(f64::total_cmp);
    // 单帧呈现的 prepare 基线约 2.09ms(见 P1-05 第一批),这里给出它占多少。
    let median = clones[10];
    println!(
        "{}",
        json!({"build": if cfg!(debug_assertions) {"debug"} else {"release"},
        "series": 8, "rowsPerSeries": 8192, "commands": commands, "resources": resources,
        "presentationCloneMedianMs": median, "presentationCloneP95Ms": clones[18],
        "scope": "display_list().clone() as done by compose_tooltip on every presentation; \
            excludes tooltip text/layout and GPU"})
    );
}
