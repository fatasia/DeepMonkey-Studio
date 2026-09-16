//! P1-14: 屏幕 X 反解与最近 X 聚合。画布 216x216、无图例时 plot = [8,8,200,200]。
use deep_engine_native::chart::{ChartAction, ChartIR, ChartRuntime, parse_chart_ir};

fn runtime(spec: serde_json::Value) -> ChartRuntime {
    let ir: ChartIR = parse_chart_ir(&serde_json::to_vec(&spec).unwrap()).unwrap();
    ChartRuntime::new(ir, 216.0, 216.0).unwrap()
}

fn line_spec(
    x_scale: &str,
    x_rows: serde_json::Value,
    x_bounds: (serde_json::Value, serde_json::Value),
) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1, "sourceSpecVersion": 1, "id": "axis-pick",
        "datasets": [{"id": "d", "dimensions": ["x", "y"], "rows": x_rows}],
        "axes": [
            {"id": "x", "channel": "x", "scale": x_scale, "min": x_bounds.0, "max": x_bounds.1},
            {"id": "y", "channel": "y", "scale": "linear", "min": 0, "max": 10}
        ],
        "series": [{"id": "s", "label": "s", "type": "line", "datasetId": "d",
            "x": "x", "y": "y", "xAxisId": "x", "yAxisId": "y"}],
        "legend": {"visible": false, "position": "top"},
        "tooltip": {"enabled": false, "trigger": "item"},
        "dataZoom": [], "actions": []
    })
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn linear_axis_inverts_screen_x_and_extrapolates_outside() {
    let chart = runtime(line_spec(
        "linear",
        serde_json::json!([[0, 1], [10, 2]]),
        (serde_json::json!(0), serde_json::json!(10)),
    ));
    assert!(close(chart.frame().invert_x(8.0).unwrap(), 0.0));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 5.0));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 10.0));
    // 连续轴域外线性外插,与正向 scale 不 clamp 的约定一致。
    assert!(close(chart.frame().invert_x(-92.0).unwrap(), -5.0));
    assert!(chart.frame().invert_x(f64::NAN).is_none());
}

#[test]
fn time_axis_inverts_as_millisecond_linear() {
    let chart = runtime(line_spec(
        "time",
        serde_json::json!([[0, 1], [86400000, 2]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 43200000.0));
}

#[test]
fn log_axis_inverts_decades() {
    let chart = runtime(line_spec(
        "log",
        serde_json::json!([[1, 1], [100, 2]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    assert!(close(chart.frame().invert_x(8.0).unwrap(), 1.0));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 10.0));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 100.0));
}

#[test]
fn category_axis_inverts_row_positions_and_rejects_outside() {
    let chart = runtime(line_spec(
        "category",
        serde_json::json!([["A", 1], ["B", 2]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    // band = 200/2 = 100,行带中心 58/158;返回实数行位,取整归行由调用方负责。
    assert!(close(chart.frame().invert_x(58.0).unwrap(), 0.0));
    assert!(close(chart.frame().invert_x(107.9).unwrap(), 0.499));
    assert!(close(chart.frame().invert_x(8.0).unwrap(), -0.5));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 1.5));
    // 离散类目域之外没有类目:plot 外一律 None。
    assert!(chart.frame().invert_x(7.99).is_none());
    assert!(chart.frame().invert_x(208.01).is_none());
}

#[test]
fn degenerate_axis_domain_has_no_inverse() {
    // 轴定义禁止 min==max;数据列全同值同样把正向域压成零跨度。
    let chart = runtime(line_spec(
        "linear",
        serde_json::json!([[5, 1], [5, 2]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    assert!(chart.frame().invert_x(108.0).is_none());
}

#[test]
fn inversion_tracks_the_zoom_window() {
    let mut chart = runtime(line_spec(
        "linear",
        serde_json::json!([[0, 1], [10, 2]]),
        (serde_json::json!(0), serde_json::json!(10)),
    ));
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.25,
            end: 0.75,
        })
        .unwrap();
    assert!(close(chart.frame().invert_x(8.0).unwrap(), 2.5));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 5.0));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 7.5));
}

#[test]
fn category_axis_inversion_tracks_the_zoom_window() {
    let mut chart = runtime(line_spec(
        "category",
        serde_json::json!([["A", 1], ["B", 2], ["C", 3], ["D", 4]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.25,
            end: 0.75,
        })
        .unwrap();
    // 窗口行域 [1, 3]:行带中心 row1→58、row2→158;反解与正映射互逆。
    assert!(close(chart.frame().invert_x(58.0).unwrap(), 1.0));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 1.5));
    assert!(close(chart.frame().invert_x(158.0).unwrap(), 2.0));
    assert!(chart.frame().invert_x(7.99).is_none());
}

#[test]
fn log_axis_inversion_tracks_the_zoom_window() {
    let mut chart = runtime(line_spec(
        "log",
        serde_json::json!([[1, 1], [100, 2]]),
        (serde_json::Value::Null, serde_json::Value::Null),
    ));
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.5,
            end: 1.0,
        })
        .unwrap();
    // 窗口取 log 域后半 [10, 100]:反解在 log 空间反插值。
    assert!(close(chart.frame().invert_x(8.0).unwrap(), 10.0));
    assert!(close(
        chart.frame().invert_x(108.0).unwrap(),
        10f64.powf(1.5)
    ));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 100.0));
}

#[test]
fn extreme_zoom_span_keeps_inversion_accurate() {
    let mut chart = runtime(line_spec(
        "linear",
        serde_json::json!([[0, 1], [0.05, 2], [0.1, 3]]),
        (serde_json::json!(0), serde_json::json!(10)),
    ));
    chart
        .dispatch(ChartAction::Zoom {
            axis_id: "x".into(),
            start: 0.0,
            end: 0.01,
        })
        .unwrap();
    assert!(close(chart.frame().invert_x(8.0).unwrap(), 0.0));
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 0.05));
    assert!(close(chart.frame().invert_x(208.0).unwrap(), 0.1));
    assert_eq!(
        chart.frame().pick(108.0, 168.0).unwrap().data_index,
        Some(1)
    );
}

fn targets(chart: &ChartRuntime, x: f64, tolerance: f64) -> Vec<(String, Option<usize>)> {
    chart
        .frame()
        .nearest_x_targets(x, tolerance)
        .iter()
        .map(|target| (target.series_id.clone(), target.data_index))
        .collect()
}

#[test]
fn nearest_x_aggregates_series_across_datasets_by_row_identity() {
    let spec = serde_json::json!({
        "schemaVersion": 1, "sourceSpecVersion": 1, "id": "axis-pick",
        "datasets": [
            {"id": "a", "dimensions": ["x", "y"], "rows": [[0, 1], [5, 2], [10, 3]]},
            {"id": "b", "dimensions": ["x", "y"], "rows": [[0, 1], [10, 2]]}
        ],
        "axes": [
            {"id": "x", "channel": "x", "scale": "linear", "min": 0, "max": 10},
            {"id": "y", "channel": "y", "scale": "linear", "min": 0, "max": 10}
        ],
        "series": [
            {"id": "sa", "label": "a", "type": "line", "datasetId": "a",
                "x": "x", "y": "y", "xAxisId": "x", "yAxisId": "y"},
            {"id": "sb", "label": "b", "type": "line", "datasetId": "b",
                "x": "x", "y": "y", "xAxisId": "x", "yAxisId": "y"}
        ],
        "legend": {"visible": false, "position": "top"},
        "tooltip": {"enabled": false, "trigger": "item"},
        "dataZoom": [], "actions": []
    });
    let mut chart = runtime(spec);
    // 前(后绘制)系列在前;各 data_index 保持其 dataset 的行身份。
    assert_eq!(
        targets(&chart, 10.0, 16.0),
        vec![("sb".into(), Some(0)), ("sa".into(), Some(0))]
    );
    assert_eq!(targets(&chart, 108.0, 16.0), vec![("sa".into(), Some(1))]);
    // tolerance 0 只接受屏幕 X 恰好在顶点上的系列。
    assert_eq!(
        targets(&chart, 8.0, 0.0),
        vec![("sb".into(), Some(0)), ("sa".into(), Some(0))]
    );
    // NaN 与负容差一律空,不 panic。
    assert!(targets(&chart, f64::NAN, 16.0).is_empty());
    assert!(targets(&chart, 8.0, -1.0).is_empty());
    // 图例隐藏的系列不再应答最近 X。
    chart
        .dispatch(ChartAction::ToggleLegend {
            series_id: "sb".into(),
        })
        .unwrap();
    assert_eq!(targets(&chart, 8.0, 16.0), vec![("sa".into(), Some(0))]);
}

#[test]
fn empty_dataset_stays_total() {
    // 全缺失 y 的数据被 IR 语义校验拦截,拾取层只会见到空数据集。
    let chart = runtime(line_spec(
        "linear",
        serde_json::json!([]),
        (serde_json::json!(0), serde_json::json!(10)),
    ));
    // 无命中目标,但有界轴的反解不依赖数据,仍然可用。
    assert!(chart.frame().pick(108.0, 108.0).is_none());
    assert!(chart.frame().nearest_x_targets(108.0, 16.0).is_empty());
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 5.0));
}

#[test]
fn bar_series_exposes_axis_inverter_without_point_index() {
    let mut spec = line_spec(
        "linear",
        serde_json::json!([[0, 1], [10, 2]]),
        (serde_json::json!(0), serde_json::json!(10)),
    );
    spec["series"][0]["type"] = serde_json::json!("bar");
    let chart = runtime(spec);
    assert!(close(chart.frame().invert_x(108.0).unwrap(), 5.0));
    assert!(chart.frame().nearest_x_targets(8.0, 16.0).is_empty());
}
