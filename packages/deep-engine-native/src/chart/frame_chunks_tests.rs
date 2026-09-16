//! chunk/view ABI 的复杂度与等价性断言:复用系列按 Arc 句柄共享(零命令
//! memcpy),扁平视图惰性物化一次,内容与全量参考渲染逐字节一致。
use super::{ChartGeometryFrame, Deep2dCommand, Deep2dResource};
use crate::chart::{
    ChartAction, ChartIR, InteractionState, parse_chart_ir, render_chart_with_windows,
};
use serde_json::json;
use std::sync::Arc;

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
fn partial_update_clones_handles_only_and_materializes_the_flat_view_once() {
    let mut ir = fixture(64);
    let state = InteractionState::default();
    let original = ChartGeometryFrame::prepare(&ir, &state, 640.0, 360.0).unwrap();
    let stale_reference =
        render_chart_with_windows(&ir, 640.0, 360.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
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
    // 未变系列:命中几何、命令与资源三个存储都是 O(1) 句柄克隆,零 memcpy。
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
    assert!(!Arc::ptr_eq(
        &original.chunks[0].geometry,
        &next.chunks[0].geometry
    ));
    assert!(!Arc::ptr_eq(
        &original.chunks[0].commands,
        &next.chunks[0].commands
    ));
    // 旧帧已物化的视图保持旧内容;新帧视图与全量参考渲染逐字节一致。
    assert_eq!(original.display_list(), &stale_reference);
    let reference =
        render_chart_with_windows(&ir, 640.0, 360.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
    assert_eq!(next.display_list(), &reference);
    let first: *const _ = next.display_list();
    assert!(
        std::ptr::eq(next.display_list(), first),
        "重复读取共享同一份扁平视图"
    );
}

#[test]
fn hidden_series_reflow_shares_chunk_storage_but_matches_reference_z_order() {
    let ir = fixture(64);
    let mut state = InteractionState::default();
    let full = ChartGeometryFrame::prepare(&ir, &state, 640.0, 360.0).unwrap();
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "line-0".into(),
            },
        )
        .unwrap();
    let hidden =
        ChartGeometryFrame::prepare_incremental(&ir, &state, 640.0, 360.0, Some(&full), &[])
            .unwrap();
    assert_eq!(
        (hidden.work().series_rebuilt, hidden.work().series_reused),
        (0, 7)
    );
    // 复用 chunk 的命令存储与旧帧共享,但视图按新扁平索引重编号 z 序,
    // 与旧实现「拼接时重写 z_order」逐值一致。
    assert!(Arc::ptr_eq(
        &full.chunks[1].commands,
        &hidden.chunks[0].commands
    ));
    let reference =
        render_chart_with_windows(&ir, 640.0, 360.0, &state.hidden_series, &state.zoom_windows)
            .unwrap();
    assert_eq!(hidden.display_list(), &reference);
    let z_orders: Vec<i32> = hidden
        .display_list()
        .commands
        .iter()
        .map(|command| match command {
            Deep2dCommand::Path(path) => path.z_order,
            _ => unreachable!("chart frame only holds paths"),
        })
        .collect();
    assert_eq!(z_orders, (0..z_orders.len() as i32).collect::<Vec<_>>());
}

#[test]
fn revision_landscape_settles_before_the_first_view_read() {
    let ir = fixture(64);
    let state = InteractionState::default();
    let original = ChartGeometryFrame::prepare(&ir, &state, 640.0, 360.0).unwrap();
    let mut next = ChartGeometryFrame::prepare_incremental(
        &ir,
        &state,
        640.0,
        360.0,
        Some(&original),
        &["line-0".into()],
    )
    .unwrap();
    // 运行时在帧进入 Arc 之前调用 set_revision;此刻视图必然未物化。
    next.set_revision(7);
    let list = next.display_list();
    assert_eq!(list.revision, 7);
    let mut offset = 0;
    for chunk in &next.chunks {
        for resource in &list.resources[offset..offset + chunk.resources.len()] {
            if let Deep2dResource::Path(path) = resource {
                assert_eq!(path.revision, if chunk.rebuilt { 7 } else { 0 });
            }
        }
        offset += chunk.resources.len();
    }
    assert_eq!(offset, list.resources.len());
}
