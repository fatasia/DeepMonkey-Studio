pub use super::types::*;

/// Validates a deserialized ChartIR against the structural contract:
/// budgets, unique ids, dimension references, axis channels/scales and
/// numeric columns and serialized interaction configuration.
pub fn validate_chart_ir(ir: &ChartIR) -> ChartValidation {
    let mut diagnostics = Vec::new();
    let mut add = |code, path: String, message: String| {
        if diagnostics.len() < CHART_BUDGETS.diagnostics {
            diagnostics.push(ChartDiagnostic {
                code,
                path,
                message,
            });
        }
    };

    if ir.schema_version != CHART_IR_SCHEMA_VERSION {
        add(
            ChartDiagnosticCode::InvalidSchema,
            "$.schemaVersion".into(),
            "Expected ChartIR schema version 1.".into(),
        );
    }
    if ir.datasets.len() > CHART_BUDGETS.datasets {
        add(
            ChartDiagnosticCode::BudgetExceeded,
            "$.datasets".into(),
            "Dataset budget exceeded.".into(),
        );
    }
    if ir.axes.len() > CHART_BUDGETS.axes {
        add(
            ChartDiagnosticCode::BudgetExceeded,
            "$.axes".into(),
            "Axis budget exceeded.".into(),
        );
    }
    if ir.series.len() > CHART_BUDGETS.series {
        add(
            ChartDiagnosticCode::BudgetExceeded,
            "$.series".into(),
            "Series budget exceeded.".into(),
        );
    }

    if ir.datasets.len() > CHART_BUDGETS.datasets
        || ir.axes.len() > CHART_BUDGETS.axes
        || ir.series.len() > CHART_BUDGETS.series
    {
        return ChartValidation {
            valid: false,
            diagnostics,
        };
    }
    let mut oversized_dataset = false;
    for (index, dataset) in ir.datasets.iter().enumerate() {
        for (field, count, budget) in [
            (
                "dimensions",
                dataset.dimensions.len(),
                CHART_BUDGETS.dimensions,
            ),
            ("rows", dataset.rows.len(), CHART_BUDGETS.rows),
        ] {
            if count > budget {
                oversized_dataset = true;
                add(
                    ChartDiagnosticCode::BudgetExceeded,
                    format!("$.datasets[{index}].{field}"),
                    "Dataset budget exceeded.".into(),
                );
            }
        }
    }
    if oversized_dataset {
        return ChartValidation {
            valid: false,
            diagnostics,
        };
    }
    super::interaction_contract::validate_interactions(ir, &mut add);
    super::semantic_validation::validate_semantics(ir, &mut add);

    let mut id_lists: [(&str, Vec<&str>); 3] = [
        (
            "$.datasets",
            ir.datasets.iter().map(|d| d.id.as_str()).collect(),
        ),
        (
            "$.axes",
            ir.axes.iter().map(|axis| axis.id.as_str()).collect(),
        ),
        (
            "$.series",
            ir.series.iter().map(|s| s.id.as_str()).collect(),
        ),
    ];
    for (path, ids) in &mut id_lists {
        let mut seen = std::collections::HashSet::new();
        for id in ids.iter() {
            if !seen.insert(*id) {
                add(
                    ChartDiagnosticCode::DuplicateId,
                    format!("{path}.id"),
                    format!("Duplicate id {id}."),
                );
            }
        }
    }

    let datasets: std::collections::HashMap<
        &str,
        (&ChartDataset, std::collections::HashSet<&str>),
    > = ir
        .datasets
        .iter()
        .map(|dataset| {
            let dimensions = std::collections::HashSet::<&str>::from_iter(
                dataset.dimensions.iter().map(String::as_str),
            );
            (dataset.id.as_str(), (dataset, dimensions))
        })
        .collect();

    for (index, dataset) in ir.datasets.iter().enumerate() {
        let path = format!("$.datasets[{index}]");
        let mut dimension_set = std::collections::HashSet::new();
        if !dataset
            .dimensions
            .iter()
            .all(|dimension| dimension_set.insert(dimension.as_str()))
        {
            add(
                ChartDiagnosticCode::InvalidValue,
                format!("{path}.dimensions"),
                "Dataset dimensions must be unique.".into(),
            );
        }
        for (row_index, row) in dataset.rows.iter().enumerate() {
            if row.len() != dataset.dimensions.len() {
                add(
                    ChartDiagnosticCode::InvalidValue,
                    format!("{path}.rows[{row_index}]"),
                    "Row must contain one JSON scalar per dimension.".into(),
                );
            }
            for (column, value) in row.iter().enumerate() {
                let scalar = value.is_null()
                    || value.is_boolean()
                    || (value.is_string())
                    || value.as_f64().is_some_and(|number| number.is_finite());
                if !scalar {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        format!("{path}.rows[{row_index}][{column}]"),
                        "Row values must be null, boolean, string or finite number.".into(),
                    );
                }
            }
        }
    }

    for (index, axis) in ir.axes.iter().enumerate() {
        let path = format!("$.axes[{index}]");
        if let (Some(min), Some(max)) = (axis.min, axis.max)
            && (!min.is_finite() || !max.is_finite() || min >= max)
        {
            add(
                ChartDiagnosticCode::InvalidValue,
                path,
                "Axis min must be less than max.".into(),
            );
        }
    }

    let axes = ir
        .axes
        .iter()
        .map(|axis| (axis.id.as_str(), axis))
        .collect::<std::collections::HashMap<_, _>>();
    for (index, series) in ir.series.iter().enumerate() {
        let path = format!("$.series[{index}]");
        let Some((dataset, dimensions)) = datasets.get(series.dataset_id.as_str()) else {
            add(
                ChartDiagnosticCode::MissingReference,
                format!("{path}.datasetId"),
                format!("Missing dataset {}.", series.dataset_id),
            );
            continue;
        };
        if dataset.rows.len() > CHART_BUDGETS.rows {
            continue;
        }
        let numeric_columns = |dataset: &ChartDataset, dimension: &str| -> Option<usize> {
            let column = dataset.dimensions.iter().position(|d| d == dimension)?;
            let all_numeric = dataset.rows.iter().all(|row| {
                row.get(column)
                    .is_none_or(|v: &serde_json::Value| v.as_f64().is_some_and(f64::is_finite))
            });
            all_numeric.then_some(column)
        };
        match series.series_type {
            ChartSeriesType::Pie | ChartSeriesType::Gauge => {
                let Some(name) = &series.name else {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        format!("{path}.name"),
                        "Pie/gauge series require a name dimension.".into(),
                    );
                    continue;
                };
                let Some(value) = &series.value else {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        format!("{path}.value"),
                        "Pie/gauge series require a value dimension.".into(),
                    );
                    continue;
                };
                for dimension in [name, value] {
                    if !dimensions.contains(dimension.as_str()) {
                        add(
                            ChartDiagnosticCode::MissingReference,
                            path.clone(),
                            format!("Missing dimension {dimension}."),
                        );
                    }
                }
                if dimensions.contains(value.as_str()) && numeric_columns(dataset, value).is_none()
                {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        path.clone(),
                        format!("Dimension {value} must contain finite numbers."),
                    );
                }
                if series.series_type == ChartSeriesType::Gauge {
                    match (series.min, series.max) {
                        (Some(min), Some(max))
                            if min.is_finite() && max.is_finite() && min < max => {}
                        _ => add(
                            ChartDiagnosticCode::InvalidValue,
                            path.clone(),
                            "Gauge requires finite min < max.".into(),
                        ),
                    }
                }
            }
            ChartSeriesType::Heatmap => {
                let (Some(x), Some(y), Some(value)) = (&series.x, &series.y, &series.value) else {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        path.clone(),
                        "Heatmap series require x, y and value dimensions.".into(),
                    );
                    continue;
                };
                for dimension in [x, y, value] {
                    if !dimensions.contains(dimension.as_str()) {
                        add(
                            ChartDiagnosticCode::MissingReference,
                            path.clone(),
                            format!("Missing dimension {dimension}."),
                        );
                    }
                }
            }
            ChartSeriesType::Line | ChartSeriesType::Bar | ChartSeriesType::Scatter => {
                let (Some(x), Some(y), Some(x_axis_id), Some(y_axis_id)) =
                    (&series.x, &series.y, &series.x_axis_id, &series.y_axis_id)
                else {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        path.clone(),
                        "Cartesian series require x, y, xAxisId and yAxisId.".into(),
                    );
                    continue;
                };
                for dimension in [x, y] {
                    if !dimensions.contains(dimension.as_str()) {
                        add(
                            ChartDiagnosticCode::MissingReference,
                            path.clone(),
                            format!("Missing dimension {dimension}."),
                        );
                    }
                }
                match axes.get(x_axis_id.as_str()).map(|axis| axis.channel) {
                    Some(ChartAxisChannel::X) => {}
                    _ => add(
                        ChartDiagnosticCode::MissingReference,
                        format!("{path}.xAxisId"),
                        "Missing x axis.".into(),
                    ),
                }
                match axes.get(y_axis_id.as_str()).map(|axis| axis.channel) {
                    Some(ChartAxisChannel::Y) => {}
                    _ => add(
                        ChartDiagnosticCode::MissingReference,
                        format!("{path}.yAxisId"),
                        "Missing y axis.".into(),
                    ),
                }
                if dimensions.contains(y.as_str()) && numeric_columns(dataset, y).is_none() {
                    add(
                        ChartDiagnosticCode::InvalidValue,
                        path.clone(),
                        format!("Dimension {y} must contain finite numbers."),
                    );
                }
            }
        }
    }

    ChartValidation {
        valid: diagnostics.is_empty(),
        diagnostics,
    }
}
