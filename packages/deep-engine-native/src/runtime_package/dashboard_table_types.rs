use super::types::required_nullable;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardTable {
    pub id: String,
    pub page_id: String,
    pub node_ids: Vec<String>,
    pub title: String,
    pub families: Vec<DashboardTableFamily>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardTableFamily {
    pub orders: Vec<DashboardTableOrder>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardTableOrder {
    #[serde(deserialize_with = "required_nullable")]
    pub column: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub direction: Option<String>,
    pub exports: DashboardTableExports,
    pub pages: Vec<DashboardTableView>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardTableExports {
    pub csv: String,
    pub xlsx: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardTableView {
    pub layers: Vec<DashboardTableLayer>,
    pub controls: Vec<DashboardTableControl>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardTableLayer {
    pub node_id: String,
    pub deep2d: String,
    #[serde(deserialize_with = "required_nullable")]
    pub clip: Option<[f64; 4]>,
    #[serde(default)]
    pub origin: Option<[f64; 2]>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DashboardTableControl {
    pub action: String,
    #[serde(deserialize_with = "required_nullable")]
    pub column: Option<String>,
    pub rect: [f64; 4],
    pub enabled: bool,
}
