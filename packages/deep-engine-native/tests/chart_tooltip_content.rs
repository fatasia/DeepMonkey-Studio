use deep_engine_native::chart::{
    ChartAction, ChartRuntime, parse_chart_ir, tooltip_content::tooltip_content,
};

fn chart() -> ChartRuntime {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = false;
    ChartRuntime::new(source, 216.0, 216.0).unwrap()
}

#[test]
fn axis_tooltip_aggregates_visible_series_on_same_category() {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = false;
    source.tooltip.trigger = deep_engine_native::chart::interaction_contract::TooltipTrigger::Axis;
    let mut chart = ChartRuntime::new(source, 216.0, 216.0).unwrap();
    chart
        .dispatch(ChartAction::Hover {
            series_id: "line".into(),
            data_index: 0,
            x_label: "A".into(),
            value: "1".into(),
        })
        .unwrap();
    let content = tooltip_content(&chart).unwrap();
    assert_eq!(content.heading, "A");
    assert!(
        content
            .entries
            .iter()
            .any(|entry| entry.series_id == "line")
    );
    assert!(content.entries.iter().any(|entry| entry.series_id == "bar"));
    assert_eq!(content.omitted, 0);
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "bar".into(),
        })
        .unwrap();
    chart
        .dispatch(ChartAction::Hover {
            series_id: "line".into(),
            data_index: 0,
            x_label: "A".into(),
            value: "1".into(),
        })
        .unwrap();
    let content = tooltip_content(&chart).unwrap();
    assert_eq!(content.entries.len(), 2);
    assert!(
        content
            .entries
            .iter()
            .any(|entry| entry.series_id == "line")
    );
    assert!(
        content
            .entries
            .iter()
            .any(|entry| entry.series_id == "scatter")
    );
    assert!(content.entries.iter().all(|entry| entry.series_id != "bar"));
}

#[test]
fn axis_pointer_uses_screen_x_when_cursor_is_between_series_pixels() {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = false;
    source.tooltip.trigger = deep_engine_native::chart::interaction_contract::TooltipTrigger::Axis;
    let mut chart = ChartRuntime::new(source, 216.0, 216.0).unwrap();

    // The first category is around x=58; y=20 is deliberately away from the
    // line/bar/scatter geometry. Axis mode should still aggregate by X.
    chart.pointer_move(58.0, 20.0).unwrap();
    let content = tooltip_content(&chart).unwrap();
    assert_eq!(content.heading, "A");
    assert_eq!(content.entries.len(), 3);
    assert!(content.entries.iter().all(|entry| entry.row == 0));

    chart.pointer_move(0.0, 0.0).unwrap();
    assert!(chart.state().tooltip.is_none());
}

#[test]
fn item_tooltip_stays_single() {
    let mut chart = chart();
    chart.pointer_move(58.0, 188.0).unwrap();
    let mut source = chart.source().clone();
    source.tooltip.trigger = deep_engine_native::chart::interaction_contract::TooltipTrigger::Item;
    chart.replace(source).unwrap();
    chart.pointer_move(58.0, 188.0).unwrap();
    assert_eq!(tooltip_content(&chart).unwrap().entries.len(), 1);
}

#[test]
fn aggregation_matches_source_values_across_datasets_and_isolates_axes() {
    let mut chart = chart();
    let mut source = chart.source().clone();
    source.series.retain(|series| series.id == "line");
    let mut dataset = source.datasets[0].clone();
    dataset.id = "other".into();
    dataset.rows.reverse();
    dataset.rows[1][1] = serde_json::json!(7);
    source.datasets.push(dataset);
    let mut series = source.series[0].clone();
    series.id = "other-line".into();
    series.dataset_id = "other".into();
    source.series.push(series.clone());
    let mut axis = source.axes[0].clone();
    axis.id = "other-x".into();
    source.axes.push(axis);
    series.id = "isolated".into();
    series.x_axis_id = Some("other-x".into());
    source.series.push(series);
    chart.replace(source).unwrap();
    chart
        .dispatch(ChartAction::Hover {
            series_id: "line".into(),
            data_index: 0,
            x_label: "incorrect formatted label".into(),
            value: "1".into(),
        })
        .unwrap();
    let result = tooltip_content(&chart).unwrap();
    assert_eq!(result.heading, "A");
    assert_eq!(result.entries.len(), 2);
    assert_eq!(result.entries[1].series_id, "other-line");
    assert_eq!(result.entries[1].row, 1);
    assert_eq!(result.entries[1].value, "7");
}

#[test]
fn aggregation_caps_entries_deterministically() {
    let mut chart = chart();
    let mut source = chart.source().clone();
    let base = source.series[0].clone();
    for index in 0..20 {
        let mut series = base.clone();
        series.id = format!("series-{index}");
        series.label = format!("S{index}");
        source.series.push(series);
    }
    chart.replace(source).unwrap();
    chart.pointer_move(58.0, 188.0).unwrap();
    let content = tooltip_content(&chart).unwrap();
    assert_eq!(content.entries.len(), 8);
    assert!(content.omitted > 0);
}
