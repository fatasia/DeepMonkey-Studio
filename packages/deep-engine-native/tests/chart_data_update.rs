use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartDataset, ChartRuntime, DatasetRowsUpdate, parse_chart_ir,
};
use serde_json::json;

fn runtime() -> ChartRuntime {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.series.retain(|s| s.id == "line" || s.id == "bar");
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    ir.datasets.push(ChartDataset {
        id: "unused".into(),
        dimensions: vec!["v".into()],
        rows: vec![vec![json!(1)]].into(),
    });
    ChartRuntime::new(ir, 216.0, 216.0).unwrap()
}
fn command(r: &ChartRuntime, datasets: Vec<DatasetRowsUpdate>) -> ChartDataUpdate {
    ChartDataUpdate {
        expected_data_revision: r.data_revision(),
        data_revision: r.data_revision() + 1,
        datasets,
    }
}
fn replace(id: &str, rows: Vec<Vec<serde_json::Value>>) -> DatasetRowsUpdate {
    DatasetRowsUpdate::Replace {
        dataset_id: id.into(),
        rows,
    }
}
fn rows() -> Vec<Vec<serde_json::Value>> {
    vec![vec![json!("C"), json!(4), json!(0.4), json!("新设备")]]
}

#[test]
fn replace_commits_source_and_hit_geometry_together_without_resetting_legend_or_zoom() {
    let mut current = runtime();
    current
        .dispatch(ChartAction::Select {
            series_id: "line".into(),
            data_index: Some(1),
        })
        .unwrap();
    current
        .dispatch(ChartAction::Select {
            series_id: "bar".into(),
            data_index: None,
        })
        .unwrap();
    current
        .dispatch(ChartAction::ToggleLegend {
            series_id: "bar".into(),
        })
        .unwrap();
    current
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.1,
            end: 0.9,
        })
        .unwrap();
    let old = current.clone();
    let evidence = current
        .update_data(command(&current, vec![replace("main", rows())]))
        .unwrap();
    assert!(evidence.geometry_rebuilt);
    assert_eq!(evidence.affected_series, ["line", "bar"]);
    assert_eq!(current.source().datasets[0].rows.as_slice(), rows());
    assert_eq!(current.state().hidden_series, old.state().hidden_series);
    assert_eq!(current.state().zoom_windows, old.state().zoom_windows);
    assert_eq!(current.state().selected, vec![("bar".into(), None)]);
    assert_eq!(old.source().datasets[0].rows.len(), 2);
    assert!(!std::ptr::eq(old.frame(), current.frame()));
    assert_eq!(current.frame().display_list().revision, current.revision());
    assert!(current.frame().line_point_position("line", 1).is_none());
}

#[test]
fn append_window_moves_retained_row_selections_and_discards_evicted_rows() {
    let mut current = runtime();
    for row in 0..2 {
        current
            .dispatch(ChartAction::Select {
                series_id: "line".into(),
                data_index: Some(row),
            })
            .unwrap();
    }
    let update = DatasetRowsUpdate::AppendWindow {
        dataset_id: "main".into(),
        rows: rows(),
        max_rows: 2,
    };
    let evidence = current
        .update_data(command(&current, vec![update]))
        .unwrap();
    assert_eq!(evidence.evicted_rows, 1);
    assert_eq!(current.source().datasets[0].rows[0][0], "B");
    assert_eq!(current.source().datasets[0].rows[1][0], "C");
    assert_eq!(current.state().selected, vec![("line".into(), Some(0))]);
    let p = current.frame().line_point_position("line", 1).unwrap();
    current.pointer_move(p[0], p[1]).unwrap();
    assert_eq!(current.state().tooltip.as_ref().unwrap().y_value, "4");
}

#[test]
fn unreferenced_and_hidden_updates_reuse_paint_and_hit_frames() {
    let mut current = runtime();
    let old = current.clone();
    let result = current
        .update_data(command(
            &current,
            vec![replace("unused", vec![vec![json!(2)]])],
        ))
        .unwrap();
    assert!(!result.geometry_rebuilt);
    assert!(std::ptr::eq(current.frame(), old.frame()));
    for id in ["line", "bar"] {
        current
            .dispatch(ChartAction::ToggleLegend {
                series_id: id.into(),
            })
            .unwrap();
    }
    let hidden = current.clone();
    let result = current
        .update_data(command(&current, vec![replace("main", rows())]))
        .unwrap();
    assert!(!result.geometry_rebuilt);
    assert!(std::ptr::eq(current.frame(), hidden.frame()));
    current
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    assert!(current.frame().line_point_position("line", 0).is_some());
    assert!(current.frame().line_point_position("line", 1).is_none());
}

#[test]
fn identity_update_shares_source_and_frame_but_advances_data_revision() {
    let mut current = runtime();
    let old = current.clone();
    let rows = current.source().datasets[0].rows.to_vec();
    let result = current
        .update_data(command(&current, vec![replace("main", rows)]))
        .unwrap();
    assert!(result.changed_datasets.is_empty());
    assert_eq!(result.evicted_rows, 0);
    assert!(std::ptr::eq(current.source(), old.source()));
    assert!(std::ptr::eq(current.frame(), old.frame()));
    assert_eq!(current.data_revision(), old.data_revision() + 1);
}

#[test]
fn invalid_batch_and_stale_revision_leave_every_component_unchanged() {
    let mut current = runtime();
    let old = current.clone();
    for updates in [
        vec![replace("main", rows()), replace("missing", rows())],
        vec![replace("main", vec![vec![json!({"bad": 1})]])],
        vec![replace("unused", vec![]), replace("unused", vec![])],
        vec![DatasetRowsUpdate::AppendWindow {
            dataset_id: "main".into(),
            rows: rows(),
            max_rows: 0,
        }],
    ] {
        assert!(current.update_data(command(&current, updates)).is_err());
        assert!(std::ptr::eq(current.source(), old.source()));
        assert!(std::ptr::eq(current.frame(), old.frame()));
        assert_eq!(current.state(), old.state());
        assert_eq!(current.revision(), old.revision());
    }
    let mut stale = command(&current, vec![replace("main", rows())]);
    stale.expected_data_revision = 99;
    assert!(current.update_data(stale).is_err());
    assert_eq!(current.data_revision(), 0);
}

#[test]
fn rolling_windows_remap_authored_actions_and_persistent_emphasis() {
    use deep_engine_native::chart::interaction_contract::ChartInitialAction;
    let mut ir = runtime().source().clone();
    ir.actions = vec![
        ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: None,
        },
        ChartInitialAction::Downplay {
            series_id: "line".into(),
            data_index: Some(1),
        },
        ChartInitialAction::Select {
            series_id: "line".into(),
            data_index: Some(0),
        },
    ];
    let mut current = ChartRuntime::new(ir, 216.0, 216.0).unwrap();
    current
        .update_data(command(
            &current,
            vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "main".into(),
                rows: rows(),
                max_rows: 2,
            }],
        ))
        .unwrap();
    assert!(!current.state().emphasis.contains("line", 0));
    assert!(current.state().emphasis.contains("line", 1));
    assert!(current.state().selected.is_empty());
    assert_eq!(current.source().actions.len(), 2);
    assert!(matches!(
        current.source().actions[1],
        ChartInitialAction::Downplay {
            data_index: Some(0),
            ..
        }
    ));
    // Updated sources remain valid for restoration, with no out-of-range startup actions.
    let restored = ChartRuntime::new(current.source().clone(), 216.0, 216.0).unwrap();
    assert_eq!(restored.state().emphasis, current.state().emphasis);
}

#[test]
fn malformed_incoming_rows_are_rejected_even_when_the_window_would_discard_them() {
    let mut current = runtime();
    let old = current.clone();
    let incoming = vec![
        vec![json!("X"), json!({"not":"scalar"}), json!(0), json!("bad")],
        rows().remove(0),
    ];
    assert!(
        current
            .update_data(command(
                &current,
                vec![DatasetRowsUpdate::AppendWindow {
                    dataset_id: "main".into(),
                    rows: incoming,
                    max_rows: 1
                }]
            ))
            .is_err()
    );
    assert!(std::ptr::eq(current.source(), old.source()));
    assert_eq!(current.data_revision(), old.data_revision());
}

/// 未分块参考实现:整段拼接后保留最后 `limit` 行(P1-03 接线前的窗口语义)。
fn unchunked_window(
    old: &[Vec<serde_json::Value>],
    incoming: Vec<Vec<serde_json::Value>>,
    limit: usize,
) -> (Vec<Vec<serde_json::Value>>, usize) {
    let dropped = (old.len() + incoming.len()).saturating_sub(limit);
    let mut rows: Vec<_> = old.iter().skip(dropped).cloned().collect();
    rows.extend(incoming.into_iter().skip(dropped.saturating_sub(old.len())));
    (rows, dropped)
}

fn numbered_rows(count: usize, seed: f64) -> Vec<Vec<serde_json::Value>> {
    (0..count)
        .map(|index| vec![json!(seed + index as f64)])
        .collect()
}

fn committed_rows(r: &ChartRuntime, id: &str) -> Vec<Vec<serde_json::Value>> {
    r.source()
        .datasets
        .iter()
        .find(|dataset| dataset.id == id)
        .unwrap()
        .rows
        .to_vec()
}

#[test]
fn chunked_window_channel_matches_unchunked_reference_value_by_value() {
    let mut current = runtime();
    // fixture 里 unused 初始自带 1 行,参考实现从真实初始状态起步。
    let mut resident: Vec<Vec<serde_json::Value>> = committed_rows(&current, "unused");
    // 序列覆盖:建镜像(跨块)、首块中间收缩、双整块淘汰+边界收缩、空批次缩窗、
    // Replace 切断窗口、Replace 后重建、同批混合多数据集。
    let rounds: Vec<(Vec<Vec<serde_json::Value>>, usize)> = vec![
        (numbered_rows(9_000, 0.0), 9_000),
        (numbered_rows(3_500, 100_000.0), 10_000),
        (vec![], 3_000),
        (numbered_rows(4, 200_000.0), 3),
    ];
    for (incoming, limit) in rounds {
        let (expected, dropped_total) = unchunked_window(&resident, incoming.clone(), limit);
        let evidence = current
            .update_data(command(
                &current,
                vec![DatasetRowsUpdate::AppendWindow {
                    dataset_id: "unused".into(),
                    rows: incoming,
                    max_rows: limit,
                }],
            ))
            .unwrap();
        assert_eq!(evidence.evicted_rows, dropped_total.min(resident.len()));
        assert_eq!(committed_rows(&current, "unused"), expected);
        resident = expected;
    }
    current
        .update_data(command(
            &current,
            vec![replace("unused", numbered_rows(2, 300_000.0))],
        ))
        .unwrap();
    assert_eq!(
        committed_rows(&current, "unused"),
        numbered_rows(2, 300_000.0)
    );
    resident = numbered_rows(2, 300_000.0);
    let (expected, dropped_total) = unchunked_window(&resident, numbered_rows(4, 400_000.0), 3);
    let evidence = current
        .update_data(command(
            &current,
            vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "unused".into(),
                rows: numbered_rows(4, 400_000.0),
                max_rows: 3,
            }],
        ))
        .unwrap();
    assert_eq!(evidence.evicted_rows, dropped_total.min(resident.len()));
    assert_eq!(committed_rows(&current, "unused"), expected);
    // 同批混合:带系列的 main 与无系列的 unused 各自走分块窗口,互不串扰。
    let main_before = committed_rows(&current, "main");
    let (main_expected, _) = unchunked_window(&main_before, rows(), 2);
    let evidence = current
        .update_data(command(
            &current,
            vec![
                DatasetRowsUpdate::AppendWindow {
                    dataset_id: "main".into(),
                    rows: rows(),
                    max_rows: 2,
                },
                DatasetRowsUpdate::AppendWindow {
                    dataset_id: "unused".into(),
                    rows: numbered_rows(2, 500_000.0),
                    max_rows: 4,
                },
            ],
        ))
        .unwrap();
    assert!(evidence.affected_series.contains(&"line".into()));
    assert_eq!(committed_rows(&current, "main"), main_expected);
    // main 淘汰 1 行(3→2),unused 淘汰 1 行(5→4),证据按批累计。
    assert_eq!(evidence.evicted_rows, 2);
}

#[test]
fn window_channel_keeps_cloned_runtime_snapshot_unchanged() {
    let mut current = runtime();
    current
        .update_data(command(
            &current,
            vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "unused".into(),
                rows: numbered_rows(20_000, 0.0),
                max_rows: 20_000,
            }],
        ))
        .unwrap();
    let snapshot = current.clone();
    current
        .update_data(command(
            &current,
            vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "unused".into(),
                rows: numbered_rows(1_000, 900_000.0),
                max_rows: 20_000,
            }],
        ))
        .unwrap();
    // 旧克隆体是更新前的完整快照:20_000 行原样保留且可继续正常工作。
    assert_eq!(committed_rows(&snapshot, "unused").len(), 20_000);
    assert_eq!(committed_rows(&snapshot, "unused")[0], vec![json!(0.0)]);
    assert_eq!(committed_rows(&current, "unused").len(), 20_000);
    assert_eq!(committed_rows(&current, "unused")[0], vec![json!(1000.0)]);
}
