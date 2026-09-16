//! C06: object-selection ↔ chart linking and assistive summaries. The scene
//! selection and the chart interaction share one identity contract: an
//! object id maps onto a series id, so selecting a pump highlights its
//! series without a second state authority, and every chart can produce a
//! deterministic text summary for screen readers.

use crate::chart::chart_ir::{ChartIR, ChartSeriesType};
use crate::chart::interaction::ChartAction;
#[cfg(test)]
use crate::chart::interaction::InteractionState;

/// One-way mapping object→series with a deterministic rule both the scene
/// and the chart agree on (`series:{object}` naming; explicit overrides win).
#[derive(Debug, Clone, Default)]
pub struct SelectionLink {
    overrides: std::collections::HashMap<String, String>,
}

impl SelectionLink {
    pub fn bind(&mut self, object_id: &str, series_id: &str) {
        self.overrides
            .insert(object_id.to_string(), series_id.to_string());
    }

    pub fn series_for(&self, object_id: &str) -> String {
        self.overrides
            .get(object_id)
            .cloned()
            .unwrap_or_else(|| format!("series:{object_id}"))
    }

    /// Scene selection changed → the chart-side actions to apply. The
    /// reducer is pure: callers push these into `InteractionState::apply`.
    pub fn selection_actions(&self, object_id: Option<&str>) -> Vec<ChartAction> {
        match object_id {
            Some(id) => vec![ChartAction::Select {
                series_id: self.series_for(id),
                data_index: None,
            }],
            None => Vec::new(),
        }
    }
}

/// Deterministic summary for screen readers: role, series list and a
/// one-line trend read. No chart state — derived purely from the IR.
pub fn chart_summary(ir: &ChartIR) -> String {
    let mut summary = format!("图表 {}:{} 个系列", ir.id, ir.series.len());
    for series in ir.series.iter().take(4) {
        let points = ir
            .datasets
            .iter()
            .find(|dataset| dataset.id == series.dataset_id)
            .map_or(0, |dataset| dataset.rows.len());
        summary.push_str(&format!(
            ",{}({}型,{}点)",
            series.label,
            series_type_name(series.series_type),
            points
        ));
    }
    if ir.series.len() > 4 {
        summary.push_str(&format!("等共{}个系列", ir.series.len()));
    }
    summary
}

fn series_type_name(series_type: ChartSeriesType) -> &'static str {
    match series_type {
        ChartSeriesType::Line => "线",
        ChartSeriesType::Bar => "柱",
        ChartSeriesType::Scatter => "散点",
        ChartSeriesType::Pie => "饼",
        ChartSeriesType::Heatmap => "热力",
        ChartSeriesType::Gauge => "仪表",
    }
}

/// Trend phrase for one numeric column: rising / falling / flat with the
/// endpoint delta — the sentence assistive tech reads after a data refresh.
pub fn trend_phrase(ir: &ChartIR, series_id: &str) -> Option<String> {
    let series = ir.series.iter().find(|series| series.id == series_id)?;
    let dataset = ir
        .datasets
        .iter()
        .find(|dataset| dataset.id == series.dataset_id)?;
    let value_dimension = series.value.clone().or_else(|| series.y.clone())?;
    let column = dataset
        .dimensions
        .iter()
        .position(|d| d == &value_dimension)?;
    let mut values = dataset
        .rows
        .iter()
        .filter_map(|row| row.get(column).and_then(serde_json::Value::as_f64))
        .collect::<Vec<_>>();
    if values.len() < 2 {
        return None;
    }
    let last = values.pop()?;
    let first = values.first()?;
    let delta = last - first;
    let direction = if delta > f64::EPSILON {
        "上升"
    } else if delta < -f64::EPSILON {
        "下降"
    } else {
        "持平"
    };
    Some(format!(
        "{}趋势{},从{first:.2}到{last:.2}",
        series.label, direction
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::chart_ir::{
        ChartAxis, ChartAxisChannel, ChartDataset, ChartScale, ChartSeries,
    };

    fn ir() -> ChartIR {
        ChartIR {
            schema_version: 1,
            source_spec_version: 1,
            id: "link".into(),
            datasets: vec![ChartDataset {
                id: "d".into(),
                dimensions: vec!["name".into(), "value".into()],
                rows: vec![
                    vec![serde_json::json!("a"), serde_json::json!(2.0)],
                    vec![serde_json::json!("b"), serde_json::json!(9.0)],
                ]
                .into(),
            }],
            axes: vec![ChartAxis {
                id: "x".into(),
                channel: ChartAxisChannel::X,
                scale: ChartScale::Category,
                min: None,
                max: None,
            }],
            series: vec![ChartSeries {
                id: "series:pump-01".into(),
                label: "泵1压力".into(),
                series_type: ChartSeriesType::Line,
                dataset_id: "d".into(),
                x: Some("name".into()),
                y: Some("value".into()),
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
    fn scene_selection_drives_chart_highlight_through_one_identity() {
        let ir = ir();
        let mut link = SelectionLink::default();
        let mut interactions = InteractionState::default();

        for action in link.selection_actions(Some("pump-01")) {
            interactions
                .apply(&ir, action)
                .expect("select linked series");
        }
        assert_eq!(
            interactions.selected,
            vec![("series:pump-01".to_string(), None)],
            "default identity rule maps object to series prefix"
        );

        // Explicit override wins over the naming rule.
        link.bind("tank-03", "series:pump-01");
        assert_eq!(link.series_for("tank-03"), "series:pump-01");

        // Deselection clears without actions (no target).
        assert!(link.selection_actions(None).is_empty());
    }

    #[test]
    fn summary_and_trend_are_deterministic_chinese_phrases() {
        let ir = ir();
        let summary = chart_summary(&ir);
        assert!(summary.contains("图表 link"), "{summary}");
        assert!(summary.contains("泵1压力(线型,2点)"), "{summary}");

        let trend = trend_phrase(&ir, "series:pump-01").expect("trend");
        assert!(trend.contains("上升"), "{trend}");
        assert!(trend.contains("从2.00到9.00"), "{trend}");
        assert!(trend_phrase(&ir, "ghost").is_none());
    }

    #[test]
    fn flat_series_reads_as_flat() {
        let mut flat = ir();
        flat.datasets[0].rows[1][1] = serde_json::json!(2.0);
        let trend = trend_phrase(&flat, "series:pump-01").expect("trend");
        assert!(trend.contains("持平"), "{trend}");
    }
}
