use deep_engine_native::chart::{ChartAction, ChartRuntime, parse_chart_ir};

fn line() -> ChartRuntime {
    let mut source = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.series.retain(|series| series.id == "line");
    source.actions.clear();
    source.data_zoom.clear();
    source.legend.visible = false;
    ChartRuntime::new(source, 216.0, 216.0).unwrap()
}

#[test]
fn nearby_vertex_resolves_source_row_and_actual_pointer_values() {
    let mut chart = line();
    assert!(chart.frame().hit(58.0, 194.0).is_none());
    assert_eq!(chart.frame().pick(58.0, 194.0).unwrap().data_index, Some(0));
    assert!(chart.frame().pick(58.0, 197.0).is_none());
    chart.pointer_move(58.0, 194.0).unwrap();
    let tooltip = chart.state().tooltip.as_ref().unwrap();
    assert_eq!(
        (&tooltip.x_value, &tooltip.y_value),
        (&"A".to_owned(), &"1".to_owned())
    );
    chart.pointer_select(58.0, 194.0).unwrap();
    assert_eq!(chart.state().selected, vec![("line".into(), Some(0))]);
    chart.pointer_select(58.0, 194.0).unwrap();
    assert!(chart.state().selected.is_empty());
    assert!(chart.frame().pick(f64::NAN, 194.0).is_none());
}

#[test]
fn zoom_and_visibility_commit_the_matching_point_index() {
    let mut chart = line();
    let previous = chart.clone();
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.5,
        })
        .unwrap();
    assert_eq!(
        chart.frame().pick(108.0, 194.0).unwrap().data_index,
        Some(0)
    );
    assert!(chart.frame().pick(58.0, 194.0).is_none());
    assert_eq!(
        previous.frame().pick(58.0, 194.0).unwrap().data_index,
        Some(0)
    );
    assert!(chart.frame().pick(308.0, 168.0).is_none());
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "line".into(),
        })
        .unwrap();
    assert!(chart.frame().pick(108.0, 194.0).is_none());
}

#[test]
fn foreground_geometry_wins_and_equal_distance_lines_choose_later_series() {
    let chart = line();
    let mut source = chart.source().clone();
    let mut top = source.series[0].clone();
    top.id = "top".into();
    source.series.push(top);
    let mut chart = ChartRuntime::new(source, 216.0, 216.0).unwrap();
    assert_eq!(chart.frame().pick(58.0, 194.0).unwrap().series_id, "top");
    let mut source = chart.source().clone();
    let original = parse_chart_ir(include_bytes!(
        "../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    source.series.push(
        original
            .series
            .iter()
            .find(|series| series.id == "scatter")
            .unwrap()
            .clone(),
    );
    chart.replace(source).unwrap();
    assert_eq!(
        chart.frame().pick(58.0, 188.0).unwrap().series_id,
        "scatter"
    );
}

#[test]
fn dense_envelope_keeps_original_undecimated_row_identity() {
    let chart = line();
    let mut source = chart.source().clone();
    source.datasets[0].rows = (0..1000)
        .map(|i| {
            vec![
                serde_json::json!(format!("P{i}")),
                serde_json::json!(i % 10),
                serde_json::json!(1),
                serde_json::json!("pump"),
            ]
        })
        .collect();
    let chart = ChartRuntime::new(source, 216.0, 216.0).unwrap();
    assert_eq!(chart.frame().display_list().commands.len(), 1);
    assert_eq!(
        chart.frame().pick(108.3, 188.0).unwrap().data_index,
        Some(501)
    );
}

fn linear_lines(spec_rows: serde_json::Value) -> ChartRuntime {
    let spec = serde_json::json!({
        "schemaVersion": 1, "sourceSpecVersion": 1, "id": "segment-pick",
        "datasets": [{"id": "d", "dimensions": ["x", "y"], "rows": spec_rows}],
        "axes": [
            {"id": "x", "channel": "x", "scale": "linear", "min": 0, "max": 10},
            {"id": "y", "channel": "y", "scale": "linear", "min": 0, "max": 10}
        ],
        "series": [{"id": "s", "label": "s", "type": "line", "datasetId": "d",
            "x": "x", "y": "y", "xAxisId": "x", "yAxisId": "y"}],
        "legend": {"visible": false, "position": "top"},
        "tooltip": {"enabled": false, "trigger": "item"},
        "dataZoom": [], "actions": []
    });
    ChartRuntime::new(
        parse_chart_ir(&serde_json::to_vec(&spec).unwrap()).unwrap(),
        216.0,
        216.0,
    )
    .unwrap()
}

#[test]
fn segment_midpoint_hits_between_vertices_without_inventing_a_datum() {
    // fixture 折线:行带中心 (58,188)-(158,168),两顶点相距远超 8px。
    let chart = line();
    // 段上任意点命中系列级目标;线段没有行号,datum 仍以顶点为准。
    let midpoint = chart.frame().pick(108.0, 178.0).unwrap();
    assert_eq!(midpoint.series_id, "line");
    assert_eq!(midpoint.data_index, None);
    // 靠近 B 端的段上点同样是系列级命中,不抢占端点 datum。
    let near_b = chart.frame().pick(140.0, 171.6).unwrap();
    assert_eq!(near_b.series_id, "line");
    assert_eq!(near_b.data_index, None);
    // 远离折线的位置仍然无命中。
    assert!(chart.frame().pick(108.0, 108.0).is_none());
    // NaN 输入不 panic、不命中。
    assert!(chart.frame().pick(f64::NAN, 178.0).is_none());
    // 顶点仍然优先返回自己的 datum(与段上点距离同为 0 的顶点)。
    assert_eq!(chart.frame().pick(58.0, 188.0).unwrap().data_index, Some(0));
}

#[test]
fn single_point_series_has_vertices_but_no_segments() {
    let chart = linear_lines(serde_json::json!([[5, 5]]));
    assert_eq!(
        chart.frame().pick(108.0, 108.0).unwrap().data_index,
        Some(0)
    );
    assert!(chart.frame().pick(120.0, 120.0).is_none());
}

#[test]
fn segment_pick_respects_the_zoom_window() {
    let mut chart = linear_lines(serde_json::json!([[0, 1], [5, 2], [10, 3]]));
    // 无缩放:row0-row1 段中点 (58,178) 命中(系列级)。
    assert_eq!(chart.frame().pick(58.0, 178.0).unwrap().data_index, None);
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.75,
        })
        .unwrap();
    // 窗口 [0,7.5]:row2 被裁掉,row1-row2 段不再应答其原屏幕中点。
    assert!(chart.frame().pick(158.0, 158.0).is_none());
    // 窗口内 row0-row1 段(x=0→8, x=5→141.33)仍然命中。
    assert!(chart.frame().pick(75.0, 177.7).is_some());
}
