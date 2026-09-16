//! ChartIR 字节入口：JSON 预算 → 严格字段读取 → 语义校验。
use super::{
    CHART_BUDGETS, ChartDiagnostic, ChartDiagnosticCode, ChartIR, ChartValidation,
    validate_chart_ir,
};
use serde_json::Value;

pub fn parse_chart_ir(bytes: &[u8]) -> Result<ChartIR, ChartValidation> {
    let value: Value = serde_json::from_slice(bytes).map_err(|error| {
        failure(
            ChartDiagnosticCode::InvalidJson,
            "$",
            format!("Invalid ChartIR JSON: {error}"),
        )
    })?;
    json_budget(&value, "$", 0, &mut 0)?;
    let ir: ChartIR = serde_json::from_value(value).map_err(|error| {
        failure(
            ChartDiagnosticCode::InvalidSchema,
            "$",
            format!("Invalid ChartIR fields: {error}"),
        )
    })?;
    let validation = validate_chart_ir(&ir);
    if validation.valid {
        Ok(ir)
    } else {
        Err(validation)
    }
}

pub(super) fn json_budget(
    value: &Value,
    path: &str,
    depth: usize,
    nodes: &mut usize,
) -> Result<(), ChartValidation> {
    *nodes += 1;
    if *nodes > CHART_BUDGETS.nodes || depth > CHART_BUDGETS.depth {
        return Err(failure(
            ChartDiagnosticCode::BudgetExceeded,
            path,
            "ChartIR JSON node or depth budget exceeded.".into(),
        ));
    }
    let children = match value {
        Value::Array(values) => values.len(),
        Value::Object(values) => values.len(),
        _ => 0,
    };
    if children > CHART_BUDGETS.nodes - *nodes {
        return Err(failure(
            ChartDiagnosticCode::BudgetExceeded,
            path,
            "ChartIR JSON collection budget exceeded.".into(),
        ));
    }
    match value {
        Value::String(value) if value.encode_utf16().count() > CHART_BUDGETS.string_code_units => {
            return Err(failure(
                ChartDiagnosticCode::BudgetExceeded,
                path,
                "ChartIR string budget exceeded.".into(),
            ));
        }
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                json_budget(value, &format!("{path}[{index}]"), depth + 1, nodes)?;
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                json_budget(value, &format!("{path}.{key}"), depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn failure(code: ChartDiagnosticCode, path: &str, message: String) -> ChartValidation {
    ChartValidation {
        valid: false,
        diagnostics: vec![ChartDiagnostic {
            code,
            path: path.into(),
            message,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_depth_and_node_limits_are_inclusive() {
        let mut value = Value::Null;
        for _ in 0..CHART_BUDGETS.depth {
            value = Value::Array(vec![value]);
        }
        assert!(json_budget(&value, "$", 0, &mut 0).is_ok());
        assert!(json_budget(&Value::Array(vec![value]), "$", 0, &mut 0).is_err());
        assert!(json_budget(&Value::Null, "$", 0, &mut (CHART_BUDGETS.nodes - 1)).is_ok());
        let mut exhausted = CHART_BUDGETS.nodes;
        assert!(json_budget(&Value::Null, "$", 0, &mut exhausted).is_err());
    }

    #[test]
    fn text_budget_counts_utf16_not_utf8_bytes_or_unicode_scalars() {
        let accepted = Value::String("😀".repeat(CHART_BUDGETS.string_code_units / 2));
        assert!(json_budget(&accepted, "$", 0, &mut 0).is_ok());
        let rejected = Value::String("😀".repeat(CHART_BUDGETS.string_code_units / 2 + 1));
        assert!(json_budget(&rejected, "$", 0, &mut 0).is_err());
    }
}
