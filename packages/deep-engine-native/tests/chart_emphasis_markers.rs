//! P1-15: 折线单 row 持久 emphasis marker 的渲染合同。
//! 覆盖任务要点：持久性(1)、隐藏保留(2)、窗口淘汰与身份迁移(3)、
//! row/系列覆盖顺序与 downplay 清除(4)、hover 瞬态不清除持久态(5)。
use deep_engine_native::chart::{
    ChartAction, ChartDataUpdate, ChartIR, ChartRuntime, DatasetRowsUpdate,
    interaction_contract::{ChartInitialAction, TooltipTrigger},
    parse_chart_ir,
    state_render::append_state_outlines,
};
use deep_engine_native::deep2d::{
    Deep2dCommand, Deep2dDisplayList, Deep2dRuntimeContent, prepare_runtime_content,
};
use deep_engine_native::native_ui::design_tokens::DesignTokenSnapshot;
use serde_json::json;

/// fixtures/design-tokens-v1.json dark 主题的 accent / accent-hover。
const ACCENT: [f64; 4] = [0.8392, 0.6667, 0.302, 1.0];
const ACCENT_HOVER: [f64; 4] = [0.8794, 0.75, 0.4765, 1.0];

fn source(actions: Vec<ChartInitialAction>) -> ChartIR {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.series.retain(|series| series.id == "line");
    source.actions = actions;
    source.data_zoom.clear();
    source.legend.visible = false;
    source.tooltip.trigger = TooltipTrigger::Item;
    source
}

fn runtime(actions: Vec<ChartInitialAction>) -> ChartRuntime {
    ChartRuntime::new(source(actions), 640.0, 360.0).unwrap()
}

/// fixture 的 main 数据集只有 2 行；扩到 5 行以驱动 AppendWindow 淘汰。
fn windowed_source(actions: Vec<ChartInitialAction>) -> ChartIR {
    let mut source = source(actions);
    let dataset = source
        .datasets
        .iter_mut()
        .find(|dataset| dataset.id == "main")
        .unwrap();
    for index in 0..3usize {
        let row = json!(["Z", 5 + index, 0.5 + index as f64 / 10.0, "附"]);
        dataset.rows.push(row.as_array().unwrap().clone());
    }
    source
}

fn render(chart: &ChartRuntime) -> Deep2dDisplayList {
    let tokens: DesignTokenSnapshot =
        serde_json::from_str(include_str!("../fixtures/design-tokens-v1.json")).unwrap();
    let mut list = chart.frame().display_list().clone();
    append_state_outlines(&mut list, chart, &tokens.themes.dark).unwrap();
    prepare_runtime_content(&Deep2dRuntimeContent::DisplayList(list.clone())).unwrap();
    list
}

/// (marker id, fill color)，按显示顺序。
fn markers(list: &Deep2dDisplayList) -> Vec<(String, Option<[f64; 4]>)> {
    list.commands
        .iter()
        .filter_map(|command| match command {
            Deep2dCommand::Path(path) if path.id.starts_with("point-") => {
                Some((path.id.clone(), path.fill))
            }
            _ => None,
        })
        .collect()
}

fn hover(index: usize) -> ChartAction {
    ChartAction::Hover {
        series_id: "line".into(),
        data_index: index,
        x_label: "A".into(),
        value: "1".into(),
    }
}

/// 要点 1+5：row 持久 emphasis marker 跨 hover/zoom 重绘持续存在；
/// 同行 hover 不清除也不翻倍；hover 他行是叠加的瞬态 marker。
#[test]
fn row_emphasis_marker_is_persistent_and_hover_leaves_it_intact() {
    let mut chart = runtime(vec![ChartInitialAction::Highlight {
        series_id: "line".into(),
        data_index: Some(0),
    }]);
    let persisted = markers(&render(&chart));
    assert_eq!(persisted.len(), 1);
    assert_eq!(persisted[0].1, Some(ACCENT));
    chart.dispatch(hover(0)).unwrap();
    let same_row = markers(&render(&chart));
    assert_eq!(same_row.len(), 1);
    assert_eq!(same_row[0].1, Some(ACCENT));
    chart.dispatch(hover(1)).unwrap();
    let other_row = markers(&render(&chart));
    assert_eq!(other_row.len(), 2);
    assert!(
        other_row
            .iter()
            .any(|(_, fill)| *fill == Some(ACCENT_HOVER))
    );
    chart.dispatch(ChartAction::HoverEnd).unwrap();
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.5,
        })
        .unwrap();
    let zoomed = markers(&render(&chart));
    assert_eq!(zoomed.len(), 1);
    assert_eq!(zoomed[0].1, Some(ACCENT));
}

/// 要点 4：同行 selected 压过持久 emphasis（单枚 marker）；单行 downplay
/// 清除该行 marker；系列级强调只出轮廓不展开行 marker。
#[test]
fn selected_wins_same_datum_and_downplay_clears_row_marker() {
    let mut chart = runtime(vec![ChartInitialAction::Highlight {
        series_id: "line".into(),
        data_index: Some(0),
    }]);
    chart
        .dispatch(ChartAction::Select {
            series_id: "line".into(),
            data_index: Some(0),
        })
        .unwrap();
    assert_eq!(markers(&render(&chart)).len(), 1);
    let cleared = runtime(vec![
        ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(0),
        },
        ChartInitialAction::Downplay {
            series_id: "line".into(),
            data_index: Some(0),
        },
    ]);
    assert!(markers(&render(&cleared)).is_empty());
    let series_level = runtime(vec![ChartInitialAction::Highlight {
        series_id: "line".into(),
        data_index: None,
    }]);
    assert!(markers(&render(&series_level)).is_empty());
}

/// 要点 2：legend 隐藏压制 marker 渲染，但 emphasis 状态保留，取消隐藏恢复。
#[test]
fn hidden_series_suppresses_marker_but_state_persists() {
    let mut chart = runtime(vec![ChartInitialAction::Highlight {
        series_id: "line".into(),
        data_index: Some(0),
    }]);
    assert_eq!(markers(&render(&chart)).len(), 1);
    assert!(chart.state().emphasis.contains("line", 0));
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    let hidden = render(&chart);
    assert!(markers(&hidden).is_empty());
    assert_eq!(
        hidden.commands.len(),
        chart.frame().display_list().commands.len()
    );
    assert!(chart.state().emphasis.contains("line", 0));
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    assert_eq!(markers(&render(&chart)).len(), 1);
}

/// 要点 3：AppendWindow 淘汰的行自动清除 emphasis；幸存行按 Shift 合同迁移。
#[test]
fn append_window_evicts_and_migrates_row_emphasis_markers() {
    let mut evicted = ChartRuntime::new(
        windowed_source(vec![ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(0),
        }]),
        640.0,
        360.0,
    )
    .unwrap();
    assert_eq!(markers(&render(&evicted)).len(), 1);
    let evidence = evicted
        .update_data(ChartDataUpdate {
            expected_data_revision: 0,
            data_revision: 1,
            datasets: vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "main".into(),
                rows: (0..3)
                    .map(|index| {
                        json!(["W", 10 + index, 0.9, "新"])
                            .as_array()
                            .unwrap()
                            .clone()
                    })
                    .collect(),
                max_rows: 5,
            }],
        })
        .unwrap();
    assert_eq!(evidence.evicted_rows, 3);
    assert!(evicted.state().emphasis.is_empty());
    assert!(markers(&render(&evicted)).is_empty());

    let mut migrated = ChartRuntime::new(
        windowed_source(vec![ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(3),
        }]),
        640.0,
        360.0,
    )
    .unwrap();
    assert_eq!(markers(&render(&migrated)).len(), 1);
    migrated
        .update_data(ChartDataUpdate {
            expected_data_revision: 0,
            data_revision: 1,
            datasets: vec![DatasetRowsUpdate::AppendWindow {
                dataset_id: "main".into(),
                rows: (0..3)
                    .map(|index| {
                        json!(["W", 10 + index, 0.9, "新"])
                            .as_array()
                            .unwrap()
                            .clone()
                    })
                    .collect(),
                max_rows: 5,
            }],
        })
        .unwrap();
    // 旧行 3 幸存并迁移到新行 0；旧行 0..3 被淘汰。
    assert!(migrated.state().emphasis.contains("line", 0));
    assert!(!migrated.state().emphasis.contains("line", 2));
    assert_eq!(markers(&render(&migrated)).len(), 1);
}

/// 同一行身份合同的另一支：Replace 数据集使全部旧行身份失效，row emphasis
/// 随之清空（remap 合同里 Replace 映射恒为 None）。
#[test]
fn replace_update_clears_row_emphasis() {
    let mut chart = ChartRuntime::new(
        windowed_source(vec![ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(4),
        }]),
        640.0,
        360.0,
    )
    .unwrap();
    assert_eq!(markers(&render(&chart)).len(), 1);
    chart
        .update_data(ChartDataUpdate {
            expected_data_revision: 0,
            data_revision: 1,
            datasets: vec![DatasetRowsUpdate::Replace {
                dataset_id: "main".into(),
                rows: vec![json!(["R", 1, 0.1, "换"]).as_array().unwrap().clone()],
            }],
        })
        .unwrap();
    assert!(chart.state().emphasis.is_empty());
    assert!(markers(&render(&chart)).is_empty());
}
