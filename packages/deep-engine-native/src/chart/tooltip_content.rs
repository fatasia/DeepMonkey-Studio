//! Tooltip aggregation reads typed source cells, never formatted label strings.
use super::value_equal::same_value;
use super::{ChartRuntime, ChartSeriesType, interaction_contract::TooltipTrigger};

const MAX_ENTRIES: usize = 8;
#[derive(Debug, Clone, PartialEq)]
pub struct TooltipEntry {
    pub series_id: String,
    pub label: String,
    pub row: usize,
    pub value: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct TooltipContent {
    pub heading: String,
    pub entries: Vec<TooltipEntry>,
    pub omitted: usize,
}

pub fn tooltip_content(chart: &ChartRuntime) -> Option<TooltipContent> {
    let tooltip = chart.state().tooltip.as_ref()?;
    let source = chart.source();
    let anchor = source
        .series
        .iter()
        .find(|series| series.id == tooltip.series_id)?;
    let item = || TooltipContent {
        heading: tooltip.x_value.clone(),
        entries: vec![TooltipEntry {
            series_id: anchor.id.clone(),
            label: anchor.label.clone(),
            row: tooltip.data_index,
            value: tooltip.y_value.clone(),
        }],
        omitted: 0,
    };
    if source.tooltip.trigger != TooltipTrigger::Axis
        || !cartesian(anchor.series_type)
        || anchor.x_axis_id.is_none()
    {
        return Some(item());
    }
    let dataset = source
        .datasets
        .iter()
        .find(|dataset| dataset.id == anchor.dataset_id)?;
    let column = dataset
        .dimensions
        .iter()
        .position(|dim| Some(dim) == anchor.x.as_ref())?;
    let value = dataset.rows.get(tooltip.data_index)?.get(column)?;
    let mut result = TooltipContent {
        heading: display(value),
        entries: Vec::new(),
        omitted: 0,
    };
    // Series sharing a dataset/column reuse the row lookup for this query.
    let mut matches = std::collections::HashMap::<(&str, usize), Vec<usize>>::new();
    for series in &source.series {
        if !cartesian(series.series_type)
            || series.x_axis_id != anchor.x_axis_id
            || chart.state().hidden_series.contains(&series.id)
        {
            continue;
        }
        let Some(dataset) = source
            .datasets
            .iter()
            .find(|dataset| dataset.id == series.dataset_id)
        else {
            continue;
        };
        let (Some(x), Some(y)) = (
            dataset
                .dimensions
                .iter()
                .position(|dim| Some(dim) == series.x.as_ref()),
            dataset
                .dimensions
                .iter()
                .position(|dim| Some(dim) == series.y.as_ref()),
        ) else {
            continue;
        };
        let rows = matches.entry((dataset.id.as_str(), x)).or_insert_with(|| {
            dataset
                .rows
                .iter()
                .enumerate()
                .filter(|(_, row)| row.get(x).is_some_and(|cell| same_value(cell, value)))
                .map(|(index, _)| index)
                .collect()
        });
        let log_y = source.axes.iter().any(|axis| {
            Some(&axis.id) == series.y_axis_id.as_ref() && axis.scale == super::ChartScale::Log
        });
        for &row in rows.iter() {
            let Some(cell) = dataset.rows[row].get(y) else {
                continue;
            };
            let Some(number) = cell
                .as_f64()
                .filter(|v| v.is_finite() && (!log_y || *v > 0.0))
            else {
                continue;
            };
            let _ = number;
            if result.entries.len() == MAX_ENTRIES {
                result.omitted += 1;
                continue;
            }
            result.entries.push(TooltipEntry {
                series_id: series.id.clone(),
                label: series.label.clone(),
                row,
                value: display(cell),
            });
        }
    }
    Some(result)
}

fn cartesian(kind: ChartSeriesType) -> bool {
    matches!(
        kind,
        ChartSeriesType::Line | ChartSeriesType::Bar | ChartSeriesType::Scatter
    )
}

fn display(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::same_value;
    use serde_json::json;
    #[test]
    fn numeric_equivalence_preserves_large_integer_and_string_identity() {
        assert!(same_value(&json!(1), &json!(1.0)));
        assert!(!same_value(&json!(1), &json!("1")));
        assert!(!same_value(
            &json!(9_007_199_254_740_992_u64),
            &json!(9_007_199_254_740_993_u64)
        ));
        assert!(!same_value(
            &json!(9_007_199_254_740_993_u64),
            &json!(9_007_199_254_740_992.0)
        ));
        assert!(same_value(&json!(u64::MAX), &json!(u64::MAX)));
    }
}
