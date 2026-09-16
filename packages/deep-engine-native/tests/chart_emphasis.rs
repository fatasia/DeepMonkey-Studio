use deep_engine_native::chart::{ChartAction, ChartIR, InteractionState, parse_chart_ir};

fn fixture() -> ChartIR {
    parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap()
}

#[test]
fn multiple_targets_persist_independently_of_hover() {
    let ir = fixture();
    let mut state = InteractionState::default();
    state.set_emphasis(&ir, "line", Some(0), true).unwrap();
    state.set_emphasis(&ir, "line", Some(1), true).unwrap();
    state.set_emphasis(&ir, "bar", Some(1), true).unwrap();
    state
        .apply(
            &ir,
            ChartAction::Hover {
                series_id: "pie".into(),
                data_index: 0,
                x_label: "泵".into(),
                value: "20%".into(),
            },
        )
        .unwrap();
    state.apply(&ir, ChartAction::HoverEnd).unwrap();
    assert!(state.emphasis.contains("line", 0));
    assert!(state.emphasis.contains("line", 1));
    assert!(state.emphasis.contains("bar", 1));
    state.set_emphasis(&ir, "line", Some(0), false).unwrap();
    assert!(!state.emphasis.contains("line", 0));
    assert!(state.emphasis.contains("line", 1));
    assert!(state.emphasis.contains("bar", 1));
}

#[test]
fn whole_series_emphasis_tracks_exceptions_without_expanding_rows() {
    let mut ir = fixture();
    let mut state = InteractionState::default();
    state.set_emphasis(&ir, "line", None, true).unwrap();
    state.set_emphasis(&ir, "line", Some(1), false).unwrap();
    assert!(state.emphasis.contains("line", 0));
    assert!(!state.emphasis.contains("line", 1));
    let row = ir.datasets[0].rows[0].clone();
    ir.datasets[0].rows.push(row);
    assert!(state.emphasis.contains("line", 2));
    state.set_emphasis(&ir, "line", Some(1), true).unwrap();
    assert!(state.emphasis.contains("line", 1));
    state.set_emphasis(&ir, "line", None, false).unwrap();
    assert!(state.emphasis.is_empty());
}

#[test]
fn invalid_targets_leave_existing_emphasis_unchanged() {
    let ir = fixture();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    let original = state.clone();
    assert!(state.set_emphasis(&ir, "missing", None, true).is_err());
    assert!(state.set_emphasis(&ir, "line", Some(2), true).is_err());
    assert_eq!(state, original);
}

/// P1-15: 单 row 持久 emphasis 是持久态；同一行 hover 是瞬态，不清除也不被清除。
#[test]
fn row_level_emphasis_survives_same_row_hover_select_and_zoom() {
    let ir = fixture();
    let mut state = InteractionState::default();
    state.set_emphasis(&ir, "line", Some(0), true).unwrap();
    state
        .apply(
            &ir,
            ChartAction::Hover {
                series_id: "line".into(),
                data_index: 0,
                x_label: "A".into(),
                value: "1".into(),
            },
        )
        .unwrap();
    assert!(state.highlighted.is_some());
    assert!(state.emphasis.contains("line", 0));
    state.apply(&ir, ChartAction::HoverEnd).unwrap();
    state
        .apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.0,
                end: 0.5,
            },
        )
        .unwrap();
    state
        .apply(
            &ir,
            ChartAction::Select {
                series_id: "line".into(),
                data_index: Some(0),
            },
        )
        .unwrap();
    state
        .apply(
            &ir,
            ChartAction::Deselect {
                series_id: "line".into(),
                data_index: Some(0),
            },
        )
        .unwrap();
    assert!(state.emphasis.contains("line", 0));
}

/// P1-15: legend 隐藏只影响渲染可见性，emphasis 状态保留，取消隐藏后恢复。
#[test]
fn hidden_series_keeps_row_emphasis_state_for_restore() {
    let ir = fixture();
    let mut state = InteractionState::default();
    state.set_emphasis(&ir, "line", Some(0), true).unwrap();
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "line".into(),
            },
        )
        .unwrap();
    assert_eq!(state.hidden_series, vec!["line".to_owned()]);
    assert!(state.emphasis.contains("line", 0));
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "line".into(),
            },
        )
        .unwrap();
    assert!(state.hidden_series.is_empty());
    assert!(state.emphasis.contains("line", 0));
}

/// P1-15: 覆盖顺序与清除范围合同——row 级覆盖系列级；单行 downplay 只清
/// 该行；系列级 downplay 全清（含行级）；后到的系列级动作重置例外集。
#[test]
fn row_level_overrides_series_level_and_clears_are_scoped() {
    let ir = fixture();
    let mut state = InteractionState::default();
    state.set_emphasis(&ir, "line", None, true).unwrap();
    state.set_emphasis(&ir, "line", Some(0), false).unwrap();
    assert!(!state.emphasis.contains("line", 0));
    assert!(state.emphasis.contains("line", 1));
    state.set_emphasis(&ir, "line", None, true).unwrap();
    assert!(state.emphasis.contains("line", 0));
    state.set_emphasis(&ir, "line", Some(1), true).unwrap();
    assert!(state.emphasis.contains("line", 1));
    state.set_emphasis(&ir, "line", Some(1), false).unwrap();
    assert!(!state.emphasis.contains("line", 1));
    assert!(state.emphasis.contains("line", 0));
    state.set_emphasis(&ir, "line", None, false).unwrap();
    assert!(state.emphasis.is_empty());
}
