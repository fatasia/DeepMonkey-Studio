use super::NativeApp;
use deep_engine_native::chart::{ChartDataMessage, DatasetRowsUpdate, parse_chart_data_update};

pub(super) fn append_window(app: &mut NativeApp) -> Result<(), String> {
    let chart = app.content.active().chart.as_ref().ok_or("chart missing")?;
    let Some(series) = chart.source().series.first() else {
        return Ok(());
    };
    let dataset = chart
        .source()
        .datasets
        .iter()
        .find(|data| data.id == series.dataset_id)
        .ok_or("dataset missing")?;
    let Some(row) = dataset.rows.last().cloned() else {
        return Ok(());
    };
    let id = dataset.id.clone();
    let expected_rows = (dataset.rows.len() + 1).min(deep_engine_native::chart::CHART_BUDGETS.rows);
    let before = chart.data_revision();
    let message = ChartDataMessage {
        schema: "deep-engine.chart-data-update".into(),
        schema_version: 1,
        chart_id: chart.source().id.clone(),
        expected_data_revision: before,
        data_revision: before + 1,
        datasets: vec![DatasetRowsUpdate::AppendWindow {
            dataset_id: id.clone(),
            rows: vec![row],
            max_rows: expected_rows,
        }],
    };
    let bytes = serde_json::to_vec(&message).map_err(|error| error.to_string())?;
    let message = parse_chart_data_update(&bytes)?;
    crate::app::chart::update(app, |chart| chart.apply_data_message(message).map(|_| true));
    let chart = app
        .content
        .active()
        .chart
        .as_ref()
        .ok_or("chart missing after data update")?;
    if chart.data_revision() != before + 1
        || chart
            .source()
            .datasets
            .iter()
            .find(|data| data.id == id)
            .is_none_or(|data| data.rows.len() != expected_rows)
    {
        return Err("chart data candidate was not committed after GPU staging".into());
    }
    println!(
        "native chart smoke: dataset={id} rows={expected_rows} data_revision={} committed with GPU frame",
        chart.data_revision()
    );
    Ok(())
}
