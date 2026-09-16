use super::ROWS;
use deep_engine_native::chart::{ChartIR, parse_chart_ir};
use serde_json::{Value, json};

pub(super) fn make_ir(value_shift: usize) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = true;
    let proto_series = ir
        .series
        .iter()
        .find(|series| series.id == "line")
        .cloned()
        .unwrap();
    let proto_data = ir.datasets[0].clone();
    ir.series.clear();
    ir.datasets.clear();
    for i in 0..8 {
        let mut data = proto_data.clone();
        data.id = format!("dataset-{i}");
        data.rows = (0..ROWS)
            .map(|row| {
                vec![
                    json!(format!("设备-{row}")),
                    json!(((row as f64) * 0.1).sin() * 3.0 + 4.0 + value_shift as f64),
                    json!(0.5 + value_shift as f64),
                    json!("中文标签"),
                ]
            })
            .collect();
        let dataset_id = data.id.clone();
        ir.datasets.push(data);
        let mut series = proto_series.clone();
        series.id = format!("series-{i}");
        series.label = format!("系列-{i}");
        series.dataset_id = dataset_id;
        ir.series.push(series);
    }
    ir
}

pub(super) fn rows(variant: usize) -> Vec<Vec<Value>> {
    (0..ROWS)
        .map(|row| {
            vec![
                json!(format!("设备-{row}")),
                json!(((row as f64) * 0.1).sin() * 3.0 + 4.0 + variant as f64),
                json!(0.5 + variant as f64),
                json!("中文标签"),
            ]
        })
        .collect()
}
