//! ChartIR v1 的序列化交互配置；与宿主输入事件分开保存。
use super::types::{CHART_BUDGETS, ChartDiagnosticCode, ChartIR, required_nullable};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegendPosition {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChartLegend {
    pub visible: bool,
    pub position: LegendPosition,
}
impl Default for ChartLegend {
    fn default() -> Self {
        Self {
            visible: true,
            position: LegendPosition::Top,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TooltipTrigger {
    Item,
    Axis,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChartTooltip {
    pub enabled: bool,
    pub trigger: TooltipTrigger,
}
impl Default for ChartTooltip {
    fn default() -> Self {
        Self {
            enabled: true,
            trigger: TooltipTrigger::Item,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ZoomMode {
    Inside,
    Slider,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDataZoom {
    pub id: String,
    pub axis_id: String,
    pub start: f64,
    pub end: f64,
    pub mode: ZoomMode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChartInitialAction {
    Highlight {
        series_id: String,
        #[serde(deserialize_with = "required_nullable")]
        data_index: Option<u64>,
    },
    Downplay {
        series_id: String,
        #[serde(deserialize_with = "required_nullable")]
        data_index: Option<u64>,
    },
    Select {
        series_id: String,
        #[serde(deserialize_with = "required_nullable")]
        data_index: Option<u64>,
    },
    Unselect {
        series_id: String,
        #[serde(deserialize_with = "required_nullable")]
        data_index: Option<u64>,
    },
    DataZoom {
        axis_id: String,
        start: f64,
        end: f64,
    },
}

fn window(start: f64, end: f64) -> bool {
    start.is_finite() && end.is_finite() && start >= 0.0 && end <= 100.0 && start < end
}

pub(super) fn validate_interactions(
    ir: &ChartIR,
    add: &mut impl FnMut(ChartDiagnosticCode, String, String),
) {
    use ChartDiagnosticCode::*;
    if ir.source_spec_version != 1 {
        add(
            InvalidSchema,
            "$.sourceSpecVersion".into(),
            "Expected ChartSpec source version 1.".into(),
        );
    }
    if ir.data_zoom.len() > CHART_BUDGETS.zooms {
        add(
            BudgetExceeded,
            "$.dataZoom".into(),
            "Zoom budget exceeded.".into(),
        );
    }
    if ir.actions.len() > CHART_BUDGETS.actions {
        add(
            BudgetExceeded,
            "$.actions".into(),
            "Action budget exceeded.".into(),
        );
    }
    let mut ids = std::collections::HashSet::new();
    for (index, zoom) in ir.data_zoom.iter().take(CHART_BUDGETS.zooms).enumerate() {
        let path = format!("$.dataZoom[{index}]");
        if !stable_id(&zoom.id) {
            add(
                InvalidValue,
                format!("{path}.id"),
                "Invalid stable identifier.".into(),
            );
        }
        if !ids.insert(&zoom.id) {
            add(
                DuplicateId,
                format!("{path}.id"),
                "Duplicate zoom identifier.".into(),
            );
        }
        if !ir.axes.iter().any(|axis| axis.id == zoom.axis_id) {
            add(
                MissingReference,
                format!("{path}.axisId"),
                "Missing axis.".into(),
            );
        }
        if !window(zoom.start, zoom.end) {
            add(
                InvalidValue,
                path,
                "Expected 0 <= start < end <= 100.".into(),
            );
        }
    }
    for (index, action) in ir.actions.iter().take(CHART_BUDGETS.actions).enumerate() {
        let valid = match action {
            ChartInitialAction::DataZoom {
                axis_id,
                start,
                end,
            } => window(*start, *end) && ir.axes.iter().any(|axis| axis.id == *axis_id),
            ChartInitialAction::Highlight {
                series_id,
                data_index,
            }
            | ChartInitialAction::Downplay {
                series_id,
                data_index,
            }
            | ChartInitialAction::Select {
                series_id,
                data_index,
            }
            | ChartInitialAction::Unselect {
                series_id,
                data_index,
            } => ir
                .series
                .iter()
                .find(|series| series.id == *series_id)
                .is_some_and(|series| {
                    data_index.is_none_or(|index| {
                        index <= 9_007_199_254_740_991
                            && ir
                                .datasets
                                .iter()
                                .find(|dataset| dataset.id == series.dataset_id)
                                .is_none_or(|dataset| index < dataset.rows.len() as u64)
                    })
                }),
        };
        if !valid {
            add(
                InvalidValue,
                format!("$.actions[{index}]"),
                "Invalid initial chart action.".into(),
            );
        }
    }
}

pub(super) fn stable_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !["__proto__", "prototype", "constructor"].contains(&id)
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte))
}
