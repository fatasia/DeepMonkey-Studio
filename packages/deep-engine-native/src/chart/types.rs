//! Native ChartIR v1 wire types. Shared TS golden covers all six series
//! and interaction fields; host interaction execution is separate.

use super::interaction_contract::{ChartDataZoom, ChartInitialAction, ChartLegend, ChartTooltip};
use serde::{Deserialize, Serialize};

pub const CHART_SPEC_SCHEMA_VERSION: u32 = 1;
pub const CHART_IR_SCHEMA_VERSION: u32 = 1;
pub const CHART_BUDGETS: ChartBudgets = ChartBudgets {
    datasets: 32,
    dimensions: 64,
    rows: 500_000,
    series: 128,
    axes: 16,
    zooms: 16,
    actions: 512,
    diagnostics: 128,
    nodes: 2_000_000,
    depth: 32,
    string_code_units: 4096,
};

#[derive(Debug, Clone, Copy)]
pub struct ChartBudgets {
    pub datasets: usize,
    pub dimensions: usize,
    pub rows: usize,
    pub series: usize,
    pub axes: usize,
    pub zooms: usize,
    pub actions: usize,
    pub diagnostics: usize,
    pub nodes: usize,
    pub depth: usize,
    pub string_code_units: usize,
}

pub type ChartValue = serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartScale {
    Linear,
    Log,
    Category,
    Time,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartSeriesType {
    Line,
    Bar,
    Scatter,
    Pie,
    Heatmap,
    Gauge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartAxisChannel {
    X,
    Y,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartDataset {
    pub id: String,
    pub dimensions: Vec<String>,
    pub rows: super::ChartRows,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartAxis {
    pub id: String,
    pub channel: ChartAxisChannel,
    pub scale: ChartScale,
    #[serde(deserialize_with = "required_nullable")]
    pub min: Option<f64>,
    #[serde(deserialize_with = "required_nullable")]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartSeries {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub series_type: ChartSeriesType,
    pub dataset_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_axis_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_axis_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChartIR {
    pub schema_version: u32,
    pub source_spec_version: u32,
    pub id: String,
    pub datasets: Vec<ChartDataset>,
    pub axes: Vec<ChartAxis>,
    pub series: Vec<ChartSeries>,
    pub legend: ChartLegend,
    pub tooltip: ChartTooltip,
    pub data_zoom: Vec<ChartDataZoom>,
    pub actions: Vec<ChartInitialAction>,
}

impl Default for ChartIR {
    fn default() -> Self {
        Self {
            schema_version: 1,
            source_spec_version: 1,
            id: "chart".into(),
            datasets: vec![],
            axes: vec![],
            series: vec![],
            legend: ChartLegend::default(),
            tooltip: ChartTooltip::default(),
            data_zoom: vec![],
            actions: vec![],
        }
    }
}

pub(super) fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChartDiagnosticCode {
    InvalidJson,
    InvalidSchema,
    InvalidValue,
    UnknownField,
    DuplicateId,
    MissingReference,
    BudgetExceeded,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartDiagnostic {
    pub code: ChartDiagnosticCode,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartValidation {
    pub valid: bool,
    pub diagnostics: Vec<ChartDiagnostic>,
}
