use deep_engine_native::chart::interaction_contract::ChartInitialAction;
use deep_engine_native::chart::{ChartIR, InteractionState, parse_chart_ir};

fn fixture() -> ChartIR {
    parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap()
}

#[test]
fn initializes_shared_golden_with_percent_conversion_and_ordered_actions() {
    let state = InteractionState::from_ir(&fixture()).unwrap();
    assert_eq!(state.zoom_window("x"), Some((0.2, 0.8)));
    assert!(state.emphasis.contains("line", 0));
    assert!(!state.emphasis.contains("line", 1));
    assert!(state.highlighted.is_none());
    assert!(state.selected.is_empty());
    assert!(state.tooltip.is_none());
}

#[test]
fn initial_series_actions_are_ordered_and_scoped() {
    let mut ir = fixture();
    ir.actions = vec![
        ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(1),
        },
        ChartInitialAction::Downplay {
            series_id: "bar".into(),
            data_index: None,
        },
        ChartInitialAction::Select {
            series_id: "line".into(),
            data_index: Some(0),
        },
        ChartInitialAction::Select {
            series_id: "line".into(),
            data_index: Some(0),
        },
        ChartInitialAction::Select {
            series_id: "line".into(),
            data_index: Some(1),
        },
        ChartInitialAction::Unselect {
            series_id: "line".into(),
            data_index: Some(0),
        },
    ];
    let state = InteractionState::from_ir(&ir).unwrap();
    assert!(state.emphasis.contains("line", 1));
    assert!(state.highlighted.is_none());
    assert_eq!(state.selected, vec![("line".into(), Some(1))]);
    ir.actions.push(ChartInitialAction::Downplay {
        series_id: "line".into(),
        data_index: None,
    });
    ir.actions.push(ChartInitialAction::Unselect {
        series_id: "line".into(),
        data_index: None,
    });
    let state = InteractionState::from_ir(&ir).unwrap();
    assert!(state.highlighted.is_none());
    assert!(state.selected.is_empty());
    assert!(state.emphasis.is_empty());
}

#[test]
fn reset_rejects_invalid_candidate_and_keeps_previous_state() {
    let mut ir = fixture();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    let previous = state.clone();
    ir.data_zoom[0].start = 35.0;
    ir.actions.push(ChartInitialAction::Select {
        series_id: "missing".into(),
        data_index: None,
    });
    assert!(state.reset_from_ir(&ir).is_err());
    assert_eq!(state, previous);
    ir.actions.clear();
    state.reset_from_ir(&ir).unwrap();
    assert_eq!(state.zoom_window("x"), Some((0.35, 0.9)));
    assert!(state.highlighted.is_none());
}

/// P1-15 剩余:运行期 dispatch 通道必须与初始动作**同一条路径**。
///
/// 此前 highlight/downplay 只能作为初始动作直接写 emphasis,运行期没有任何
/// `ChartAction` 能表达它——TS/ECharts 的 `dispatchAction({type:"highlight"})`
/// 因此无对应入口。本测试锁定同轨:同一组动作无论来自初始 IR 还是运行期
/// dispatch,产出的状态逐值相同。
#[test]
fn runtime_highlight_downplay_reaches_the_same_state_as_initial_actions() {
    use deep_engine_native::chart::ChartAction;
    // 基线必须干净:共享夹具自带初始 highlight/zoom 动作,直接复用会让两侧
    // 起点不同,比较失去意义。
    let mut ir = fixture();
    ir.actions.clear();
    ir.data_zoom.clear();

    // 初始动作路径。
    let mut initial_ir = ir.clone();
    initial_ir.actions = vec![
        ChartInitialAction::Highlight {
            series_id: "line".into(),
            data_index: Some(1),
        },
        ChartInitialAction::Highlight {
            series_id: "bar".into(),
            data_index: None,
        },
    ];
    let by_initial = InteractionState::from_ir(&initial_ir).unwrap();

    // 运行期 dispatch 路径:同样的语义,走 ChartAction。
    let mut by_dispatch = InteractionState::from_ir(&ir).unwrap();
    by_dispatch
        .apply(
            &ir,
            ChartAction::Highlight {
                series_id: "line".into(),
                data_index: Some(1),
            },
        )
        .unwrap();
    by_dispatch
        .apply(
            &ir,
            ChartAction::Highlight {
                series_id: "bar".into(),
                data_index: None,
            },
        )
        .unwrap();

    assert!(by_dispatch.emphasis.contains("line", 1));
    assert!(by_dispatch.emphasis.contains_entire_series("bar"));
    assert_eq!(
        by_initial.emphasis, by_dispatch.emphasis,
        "初始与运行期必须落到同一强调状态"
    );

    // downplay 对称:解除后两者一致且不再强调。
    let mut downplay_initial = initial_ir.clone();
    downplay_initial.actions.push(ChartInitialAction::Downplay {
        series_id: "line".into(),
        data_index: None,
    });
    let initial_down = InteractionState::from_ir(&downplay_initial).unwrap();
    let mut dispatch_down = by_dispatch.clone();
    dispatch_down
        .apply(
            &ir,
            ChartAction::Downplay {
                series_id: "line".into(),
                data_index: None,
            },
        )
        .unwrap();
    assert_eq!(initial_down.emphasis, dispatch_down.emphasis);
    assert!(!dispatch_down.emphasis.contains("line", 1), "downplay 后不再强调");
}

/// 运行期强调必须与既有守卫一致:未知系列报错、隐藏系列拒绝。
#[test]
fn runtime_emphasis_respects_the_existing_guards() {
    use deep_engine_native::chart::{ActionError, ChartAction};
    let mut ir = fixture();
    ir.actions.clear();
    ir.data_zoom.clear();
    let mut state = InteractionState::from_ir(&ir).unwrap();

    assert_eq!(
        state
            .apply(
                &ir,
                ChartAction::Highlight {
                    series_id: "missing".into(),
                    data_index: None,
                },
            )
            .unwrap_err(),
        ActionError::UnknownSeries
    );
    // 隐藏后不得再强调(与 HoverSeries 同一守卫)。
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "line".into(),
            },
        )
        .unwrap();
    assert_eq!(
        state
            .apply(
                &ir,
                ChartAction::Highlight {
                    series_id: "line".into(),
                    data_index: Some(0),
                },
            )
            .unwrap_err(),
        ActionError::HiddenSeriesAction
    );
    assert_eq!(
        state
            .apply(
                &ir,
                ChartAction::Downplay {
                    series_id: "line".into(),
                    data_index: None,
                },
            )
            .unwrap_err(),
        ActionError::HiddenSeriesAction
    );
}
