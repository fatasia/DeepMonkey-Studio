//! 与 TS 共用的 ID、维度和数值轴约束；校验发生在运行时呈现之前。
use super::interaction_contract::stable_id;
use super::types::*;

pub(super) fn validate_semantics(
    ir: &ChartIR,
    add: &mut impl FnMut(ChartDiagnosticCode, String, String),
) {
    use ChartDiagnosticCode::*;
    if !stable_id(&ir.id) {
        add(
            InvalidValue,
            "$.id".into(),
            "Invalid stable chart identifier.".into(),
        );
    }
    for (path, ids) in [
        (
            "datasets",
            ir.datasets
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "axes",
            ir.axes.iter().map(|value| value.id.as_str()).collect(),
        ),
        (
            "series",
            ir.series.iter().map(|value| value.id.as_str()).collect(),
        ),
    ] {
        for (index, id) in ids.iter().enumerate() {
            if !stable_id(id) {
                add(
                    InvalidValue,
                    format!("$.{path}[{index}].id"),
                    "Invalid stable identifier.".into(),
                );
            }
        }
    }
    for (index, dataset) in ir.datasets.iter().enumerate() {
        // TS dimension 名称使用 ID 字符语法，但不排除 prototype 等属性名。
        if dataset.dimensions.is_empty() || dataset.dimensions.iter().any(|id| !dimension_id(id)) {
            add(
                InvalidValue,
                format!("$.datasets[{index}].dimensions"),
                "Invalid dimension identifier.".into(),
            );
        }
        // 行统计随不可变行存储缓存;超预算数据集维持原语义不扫描。
        if dataset.rows.len() <= CHART_BUDGETS.rows && dataset.rows.stats().string_over_budget {
            add(
                BudgetExceeded,
                format!("$.datasets[{index}].rows"),
                "String budget exceeded.".into(),
            );
        }
    }
    for (index, axis) in ir.axes.iter().enumerate() {
        if axis.min.is_some_and(|value| !value.is_finite())
            || axis.max.is_some_and(|value| !value.is_finite())
        {
            add(
                InvalidValue,
                format!("$.axes[{index}]"),
                "Axis limits must be finite or null.".into(),
            );
        }
    }
    for (index, series) in ir.series.iter().enumerate() {
        let path = format!("$.series[{index}]");
        for (field, value) in [
            ("x", &series.x),
            ("y", &series.y),
            ("name", &series.name),
            ("value", &series.value),
            ("xAxisId", &series.x_axis_id),
            ("yAxisId", &series.y_axis_id),
        ] {
            if value.as_ref().is_some_and(|value| !stable_id(value)) {
                add(
                    InvalidValue,
                    format!("{path}.{field}"),
                    "Invalid stable reference identifier.".into(),
                );
            }
        }
        if !stable_id(&series.dataset_id)
            || series.label.trim().is_empty()
            || series.label.encode_utf16().count() > CHART_BUDGETS.string_code_units
        {
            add(
                InvalidValue,
                path.clone(),
                "Invalid dataset identifier or label.".into(),
            );
        }
        let Some(dataset) = ir
            .datasets
            .iter()
            .find(|dataset| dataset.id == series.dataset_id)
        else {
            continue;
        };
        if dataset.rows.len() > CHART_BUDGETS.rows {
            continue;
        }
        if series.series_type == ChartSeriesType::Heatmap
            && let Some(column) = series.value.as_ref().and_then(|name| {
                dataset
                    .dimensions
                    .iter()
                    .position(|dimension| dimension == name)
            })
            && !dataset.rows.stats().column_is_finite(column)
        {
            add(
                InvalidValue,
                path.clone(),
                "Heatmap values must be finite numbers.".into(),
            );
        }
        if matches!(
            series.series_type,
            ChartSeriesType::Pie | ChartSeriesType::Gauge
        ) {
            continue;
        }
        for (name, axis_id, channel) in [
            (&series.x, &series.x_axis_id, ChartAxisChannel::X),
            (&series.y, &series.y_axis_id, ChartAxisChannel::Y),
        ] {
            let axis = axis_id.as_ref().and_then(|id| {
                ir.axes
                    .iter()
                    .find(|axis| axis.id == *id && axis.channel == channel)
            });
            let Some(axis) = axis else {
                add(
                    MissingReference,
                    path.clone(),
                    "Missing axis with matching channel.".into(),
                );
                continue;
            };
            if !matches!(axis.scale, ChartScale::Linear | ChartScale::Log) {
                continue;
            }
            let Some(column) = name.as_ref().and_then(|name| {
                dataset
                    .dimensions
                    .iter()
                    .position(|dimension| dimension == name)
            }) else {
                continue;
            };
            // log 轴额外要求正数;两者都来自同一次行统计扫描。
            let stats = dataset.rows.stats();
            let valid = if axis.scale == ChartScale::Log {
                stats.column_is_positive(column)
            } else {
                stats.column_is_finite(column)
            };
            if !valid {
                add(
                    InvalidValue,
                    path.clone(),
                    "Invalid value for numeric axis.".into(),
                );
            }
        }
    }
}

fn dimension_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
}
