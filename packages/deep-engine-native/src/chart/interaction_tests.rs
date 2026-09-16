use super::*;
use crate::chart::chart_ir::{
    ChartAxis, ChartAxisChannel, ChartDataset, ChartSeries, ChartSeriesType,
};

fn ir() -> ChartIR {
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "interaction".into(),
        datasets: vec![ChartDataset {
            id: "d".into(),
            dimensions: vec!["x".into(), "y".into()],
            rows: vec![vec![serde_json::json!(1), serde_json::json!(5.0)]].into(),
        }],
        axes: vec![ChartAxis {
            id: "x".into(),
            channel: ChartAxisChannel::X,
            scale: ChartScale::Linear,
            min: None,
            max: None,
        }],
        series: vec![ChartSeries {
            id: "s1".into(),
            label: "温度".into(),
            series_type: ChartSeriesType::Line,
            dataset_id: "d".into(),
            x: Some("x".into()),
            y: Some("y".into()),
            name: None,
            value: None,
            min: None,
            max: None,
            x_axis_id: Some("x".into()),
            y_axis_id: None,
        }],
        ..Default::default()
    }
}

#[test]
fn hover_tooltip_and_hidden_series_reject_actions() {
    let ir = ir();
    let mut state = InteractionState::default();
    state
        .apply(
            &ir,
            ChartAction::Hover {
                series_id: "s1".into(),
                data_index: 0,
                x_label: "1".into(),
                value: "5.0".into(),
            },
        )
        .expect("hover");
    assert_eq!(state.tooltip.as_ref().expect("tooltip").y_value, "5.0");

    state
        .apply(
            &ir,
            ChartAction::ToggleLegend {
                series_id: "s1".into(),
            },
        )
        .expect("hide");
    assert_eq!(
        state.apply(
            &ir,
            ChartAction::Hover {
                series_id: "s1".into(),
                data_index: 0,
                x_label: "1".into(),
                value: "5.0".into(),
            }
        ),
        Err(ActionError::HiddenSeriesAction),
        "hidden series must not accept hover"
    );
    state.apply(&ir, ChartAction::HoverEnd).expect("hover end");
    assert!(state.tooltip.is_none());
}

#[test]
fn select_is_idempotent_and_deselect_scopes_correctly() {
    let ir = ir();
    let mut state = InteractionState::default();
    for _ in 0..2 {
        state
            .apply(
                &ir,
                ChartAction::Select {
                    series_id: "s1".into(),
                    data_index: Some(0),
                },
            )
            .expect("select");
    }
    assert_eq!(state.selected.len(), 1, "duplicate selects collapse");
    state
        .apply(
            &ir,
            ChartAction::Deselect {
                series_id: "s1".into(),
                data_index: None,
            },
        )
        .expect("deselect");
    assert!(
        state.selected.is_empty(),
        "None removes all indices of the series"
    );
}

#[test]
fn zoom_windows_validate_and_replace_per_axis() {
    let ir = ir();
    let mut state = InteractionState::default();
    assert_eq!(
        state.apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.5,
                end: 0.2
            }
        ),
        Err(ActionError::InvalidZoomWindow)
    );
    assert_eq!(
        state.apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "ghost".into(),
                start: 0.0,
                end: 0.5
            }
        ),
        Err(ActionError::UnknownAxis)
    );
    state
        .apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.1,
                end: 0.4,
            },
        )
        .expect("zoom");
    state
        .apply(
            &ir,
            ChartAction::Zoom {
                axis_id: "x".into(),
                start: 0.2,
                end: 0.6,
            },
        )
        .expect("re-zoom");
    assert_eq!(
        state.zoom_window("x"),
        Some((0.2, 0.6)),
        "same axis replaces its window"
    );
    state.apply(&ir, ChartAction::ResetZoom).expect("reset");
    assert_eq!(state.zoom_window("x"), None);
}
