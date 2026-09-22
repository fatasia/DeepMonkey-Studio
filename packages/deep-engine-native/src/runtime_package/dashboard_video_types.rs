use super::types::required_nullable;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardVideoDiagnostic {
    pub node_id: String,
    pub source_node_id: String,
    pub source: DashboardVideoSource,
    pub playback: DashboardVideoPlayback,
    pub state: DashboardVideoState,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardVideoSource {
    #[serde(deserialize_with = "required_nullable")]
    pub uri: Option<String>,
    pub availability: String,
    pub packaged: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardVideoMedia {
    pub id: String,
    pub revision: u64,
    pub format: String,
    pub mime: String,
    pub byte_length: usize,
    pub sha256: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardVideoPlayback {
    pub fit: String,
    pub autoplay: bool,
    pub muted: bool,
    pub r#loop: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardVideoState {
    pub status: String,
    pub transport: String,
    pub position_seconds: f64,
    #[serde(deserialize_with = "required_nullable")]
    pub duration_seconds: Option<f64>,
    pub reason: String,
    pub missing_capabilities: Vec<String>,
}
