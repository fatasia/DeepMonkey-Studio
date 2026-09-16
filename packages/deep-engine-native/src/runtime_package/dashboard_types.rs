use super::types::required_nullable;
use crate::{
    chart::{ChartIR, simulation::ChartSimFixture},
    deep2d::Deep2dRuntimeContent,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardRuntimeV1 {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub document_id: String,
    pub document_revision: u64,
    pub entry_page_id: String,
    pub pages: Vec<DashboardPage>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardPage {
    pub id: String,
    pub width: f64,
    pub height: f64,
    pub nodes: Vec<DashboardNode>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardNode {
    pub id: String,
    pub revision: u64,
    pub frame: [f64; 4],
    #[serde(deserialize_with = "required_nullable")]
    pub clip: Option<[f64; 4]>,
    pub z_order: i32,
    pub visible: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub hit_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub deep2d: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub chart: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub chart_sim: Option<String>,
}
#[derive(Debug, Clone)]
pub struct LoadedDashboard {
    pub document: DashboardRuntimeV1,
    pub deep2d: BTreeMap<String, Deep2dRuntimeContent>,
    pub charts: BTreeMap<String, ChartIR>,
    pub simulations: BTreeMap<String, ChartSimFixture>,
}
