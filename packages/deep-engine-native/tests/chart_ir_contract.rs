//! Cartesian/pie/gauge IR validation golden (moved from chart_ir.rs to keep the module under the 500-line review line).

use deep_engine_native::chart::*;

fn cartesian_ir() -> ChartIR {
    ChartIR {
        schema_version: 1,
        source_spec_version: 1,
        id: "trend".into(),
        datasets: vec![ChartDataset {
            id: "series-data".into(),
            dimensions: vec!["time".into(), "value".into()],
            rows: vec![
                vec![serde_json::json!(1), serde_json::json!(10.5)],
                vec![serde_json::json!(2), serde_json::json!(20.0)],
            ]
            .into(),
        }],
        axes: vec![
            ChartAxis {
                id: "x".into(),
                channel: ChartAxisChannel::X,
                scale: ChartScale::Linear,
                min: None,
                max: None,
            },
            ChartAxis {
                id: "y".into(),
                channel: ChartAxisChannel::Y,
                scale: ChartScale::Linear,
                min: Some(0.0),
                max: Some(30.0),
            },
        ],
        series: vec![ChartSeries {
            id: "line-1".into(),
            label: "温度".into(),
            series_type: ChartSeriesType::Line,
            dataset_id: "series-data".into(),
            x: Some("time".into()),
            y: Some("value".into()),
            name: None,
            value: None,
            min: None,
            max: None,
            x_axis_id: Some("x".into()),
            y_axis_id: Some("y".into()),
        }],
        ..Default::default()
    }
}

#[test]
fn valid_ir_passes_and_rejects_bad_numeric_columns() {
    let validation = validate_chart_ir(&cartesian_ir());
    assert!(validation.valid, "{:?}", validation.diagnostics);

    let mut bad = cartesian_ir();
    bad.datasets[0].rows[1][1] = serde_json::json!("not-a-number");
    let validation = validate_chart_ir(&bad);
    assert!(!validation.valid);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == ChartDiagnosticCode::InvalidValue)
    );
}

#[test]
fn missing_axis_reference_and_duplicate_ids_are_diagnostics() {
    let mut missing_axis = cartesian_ir();
    missing_axis.series[0].x_axis_id = Some("ghost".into());
    let validation = validate_chart_ir(&missing_axis);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == ChartDiagnosticCode::MissingReference)
    );

    let mut duplicate = cartesian_ir();
    duplicate.axes.push(ChartAxis {
        id: "x".into(),
        channel: ChartAxisChannel::Y,
        scale: ChartScale::Linear,
        min: None,
        max: None,
    });
    let validation = validate_chart_ir(&duplicate);
    assert!(
        validation
            .diagnostics
            .iter()
            .any(|d| d.code == ChartDiagnosticCode::DuplicateId)
    );
}

#[test]
fn gauge_requires_finite_min_max() {
    let mut gauge = cartesian_ir();
    gauge.datasets[0].dimensions = vec!["name".into(), "value".into()];
    gauge.datasets[0].rows = vec![vec![serde_json::json!("负载"), serde_json::json!(72.0)]].into();
    gauge.series[0] = ChartSeries {
        id: "gauge-1".into(),
        label: "负载".into(),
        series_type: ChartSeriesType::Gauge,
        dataset_id: "series-data".into(),
        x: None,
        y: None,
        name: Some("name".into()),
        value: Some("value".into()),
        min: Some(100.0),
        max: Some(0.0),
        x_axis_id: None,
        y_axis_id: None,
    };
    let validation = validate_chart_ir(&gauge);
    assert!(!validation.valid, "min > max gauge must be rejected");

    let mut valid_gauge = gauge;
    valid_gauge.series[0].min = Some(0.0);
    valid_gauge.series[0].max = Some(100.0);
    let validation = validate_chart_ir(&valid_gauge);
    assert!(validation.valid, "{:?}", validation.diagnostics);
}
