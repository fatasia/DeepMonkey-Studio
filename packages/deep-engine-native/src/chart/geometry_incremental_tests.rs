use super::ChartGeometryFrame;
use crate::chart::{ChartIR, ChartScale, InteractionState, parse_chart_ir};
use serde_json::json;
use std::{hint::black_box, sync::Arc, time::Instant};

fn fixture(rows: usize) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    let line = ir.series.iter().find(|s| s.id == "line").unwrap().clone();
    let dataset = ir.datasets[0].clone();
    ir.series.clear();
    ir.datasets.clear();
    ir.axes[0].scale = ChartScale::Linear;
    ir.axes[0].min = Some(0.0);
    ir.axes[0].max = Some(rows.max(2) as f64);
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

#[test]
fn unchanged_series_share_the_actual_indexes_without_retaining_duplicate_paths() {
    let mut ir = fixture(32);
    let state = InteractionState::default();
    let original = ChartGeometryFrame::prepare(&ir, &state, 640.0, 360.0).unwrap();
    ir.datasets[0].rows[0][1] = json!(8.0);
    let next = ChartGeometryFrame::prepare_incremental(
        &ir,
        &state,
        640.0,
        360.0,
        Some(&original),
        &["line-0".into()],
    )
    .unwrap();
    assert!(!Arc::ptr_eq(
        &original.chunks[0].geometry,
        &next.chunks[0].geometry
    ));
    for i in 1..8 {
        assert!(Arc::ptr_eq(
            &original.chunks[i].geometry,
            &next.chunks[i].geometry
        ));
        assert!(Arc::ptr_eq(
            &original.chunks[i].commands,
            &next.chunks[i].commands
        ));
        assert!(Arc::ptr_eq(
            &original.chunks[i].resources,
            &next.chunks[i].resources
        ));
    }
    assert_eq!(
        next.chunks
            .iter()
            .map(|chunk| chunk.resources.len())
            .sum::<usize>(),
        next.display_list().resources.len()
    );
}

#[test]
#[ignore = "explicit CPU benchmark; run with --release --ignored --nocapture"]
fn chart_geometry_bench_partial_update() {
    let mut ir = fixture(8192);
    let state = InteractionState::default();
    let original = ChartGeometryFrame::prepare(&ir, &state, 1280.0, 720.0).unwrap();
    ir.datasets[0].rows[0][1] = json!(8.0);
    let dirty = vec!["line-0".into()];
    let mut full = Vec::new();
    let mut partial = Vec::new();
    let mut legacy = Vec::new();
    for round in 0..25 {
        // 交替顺序，减少固定先后造成的缓存和温度偏差；前5组预热。
        let mut measure = |mode: usize| {
            let start = Instant::now();
            let elapsed = if mode == 2 {
                legacy_prepare(&ir, &state, start)
            } else {
                let frame = if mode == 1 {
                    ChartGeometryFrame::prepare_incremental(
                        &ir,
                        &state,
                        1280.0,
                        720.0,
                        Some(&original),
                        &dirty,
                    )
                    .unwrap()
                } else {
                    ChartGeometryFrame::prepare(&ir, &state, 1280.0, 720.0).unwrap()
                };
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(frame.work().series_rebuilt, if mode == 1 { 1 } else { 8 });
                black_box(frame);
                elapsed
            };
            if round >= 5 {
                match mode {
                    0 => full.push(elapsed),
                    1 => partial.push(elapsed),
                    _ => legacy.push(elapsed),
                }
            }
        };
        for offset in 0..3 {
            measure((round + offset) % 3);
        }
    }
    full.sort_by(f64::total_cmp);
    partial.sort_by(f64::total_cmp);
    legacy.sort_by(f64::total_cmp);
    println!(
        "chart geometry CPU benchmark: {}",
        json!({"build": if cfg!(debug_assertions) {"debug"} else {"release"},
        "series":8,"rowsPerSeries":8192,"samples":20,"warmup":5,"width":1280,"height":720,
        "fullMedianMs":full[10],"fullP95Ms":full[18],"incrementalMedianMs":partial[10],"incrementalP95Ms":partial[18],
        "legacyMedianMs":legacy[10],"legacyP95Ms":legacy[18],
        "reusedSeries":7,"rebuiltSeries":1,"scope":"geometry, validation and hit indexes; excludes source patch, presentation and GPU"})
    );
}

/// 保留优化前的全帧准备步骤作为基准，不进入产品路径。
fn legacy_prepare(ir: &ChartIR, state: &InteractionState, start: Instant) -> f64 {
    use crate::chart::ChartHitTarget;
    use crate::deep2d::{Deep2dCommand, build_hit_index};
    assert!(crate::chart::validate_chart_ir(ir).valid);
    let list = crate::chart::render_chart_with_windows(
        ir,
        1280.0,
        720.0,
        &state.hidden_series,
        &state.zoom_windows,
    )
    .unwrap();
    let hits = build_hit_index(&list).unwrap();
    let series = ir
        .series
        .iter()
        .map(|series| {
            let hash = crate::runtime_package::runtime_content_sha256(&json!([
                "chart-series",
                ir.id,
                series.id
            ]));
            (format!("hit-{hash}"), series.id.clone())
        })
        .collect::<std::collections::HashMap<_, _>>();
    let targets = list
        .commands
        .iter()
        .map(|command| {
            let Deep2dCommand::Path(path) = command else {
                unreachable!()
            };
            let (key, index) = path.hit_id.as_deref().unwrap().rsplit_once('-').unwrap();
            ChartHitTarget {
                series_id: series[key].clone(),
                data_index: (index != "series").then(|| index.parse::<usize>().unwrap()),
            }
        })
        .collect::<Vec<_>>();
    let points =
        crate::chart::line_point_index::LinePointIndex::prepare(ir, state, 1280.0, 720.0).unwrap();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    black_box((list, hits, targets, points));
    elapsed
}
