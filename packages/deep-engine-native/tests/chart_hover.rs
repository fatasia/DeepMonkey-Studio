use deep_engine_native::chart::interaction_contract::TooltipTrigger;
use deep_engine_native::chart::{
    ActionError, ChartAction, ChartIR, InteractionState, parse_chart_ir,
};

fn fixture() -> ChartIR {
    parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap()
}
fn hover(index: usize) -> ChartAction {
    ChartAction::Hover {
        series_id: "line".into(),
        data_index: index,
        x_label: "A".into(),
        value: "1".into(),
    }
}

#[test]
fn tooltip_configuration_controls_tooltip_without_disabling_hover_emphasis() {
    for (enabled, trigger, expected) in [
        (false, TooltipTrigger::Item, false),
        (true, TooltipTrigger::None, false),
        (true, TooltipTrigger::Item, true),
    ] {
        let mut ir = fixture();
        ir.tooltip.enabled = enabled;
        ir.tooltip.trigger = trigger;
        let mut state = InteractionState::default();
        state.apply(&ir, hover(0)).unwrap();
        assert_eq!(state.tooltip.is_some(), expected);
        assert_eq!(state.highlighted, Some(("line".into(), Some(0))));
    }
}

#[test]
fn out_of_range_live_events_are_rejected_before_mutating_state() {
    let ir = fixture();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    state.apply(&ir, hover(0)).unwrap();
    let previous = state.clone();
    for action in [
        hover(2),
        ChartAction::Select {
            series_id: "line".into(),
            data_index: Some(2),
        },
        ChartAction::Deselect {
            series_id: "line".into(),
            data_index: Some(2),
        },
    ] {
        assert_eq!(state.apply(&ir, action), Err(ActionError::InvalidDataIndex));
        assert_eq!(state, previous);
    }
}

#[test]
fn hiding_the_hovered_series_clears_transient_state_and_keeps_persistent_emphasis() {
    let ir = fixture();
    let mut state = InteractionState::from_ir(&ir).unwrap();
    state.apply(&ir, hover(0)).unwrap();
    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "line".into(),
            },
        )
        .unwrap();
    assert!(state.tooltip.is_none());
    assert!(state.highlighted.is_none());
    assert!(state.emphasis.contains("line", 0));
    let hidden = state.clone();
    assert_eq!(
        state.apply(&ir, hover(0)),
        Err(ActionError::HiddenSeriesAction)
    );
    assert_eq!(state, hidden);
}
