use deep_engine_native::chart::{
    ChartDataUpdate, ChartIR, ChartRuntime, DatasetRowsUpdate, parse_chart_ir,
};
use serde_json::json;

pub(super) fn fixture(rows: usize) -> ChartIR {
    let mut ir = parse_chart_ir(include_bytes!(
        "../../../deep-engine/fixtures/chart-ir-v1.json"
    ))
    .unwrap();
    ir.actions.clear();
    ir.data_zoom.clear();
    ir.legend.visible = false;
    ir.series.retain(|series| series.id == "line");
    let source = ir.datasets[0].clone();
    ir.datasets.clear();
    for i in 0..8 {
        let mut data = source.clone();
        if i > 0 {
            data.id = format!("dataset-{i}");
        }
        data.rows = (0..rows)
            .map(|row| {
                vec![
                    json!(format!("设备-{row}")),
                    json!(row % 10),
                    json!(0.5),
                    json!("中文标签"),
                ]
            })
            .collect();
        ir.datasets.push(data);
    }
    ir
}
pub(super) fn update(
    runtime: &mut ChartRuntime,
    rows: Vec<Vec<serde_json::Value>>,
    append: Option<usize>,
) -> Result<(), String> {
    let dataset_id = "main".into();
    let operation = match append {
        Some(max_rows) => DatasetRowsUpdate::AppendWindow {
            dataset_id,
            rows,
            max_rows,
        },
        None => DatasetRowsUpdate::Replace { dataset_id, rows },
    };
    runtime
        .update_data(ChartDataUpdate {
            expected_data_revision: runtime.data_revision(),
            data_revision: runtime.data_revision() + 1,
            datasets: vec![operation],
        })
        .map(|_| ())
}
