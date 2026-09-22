use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DashboardTextInput {
    pub kind: String,
    pub node_id: String,
    pub key: String,
    pub locale: String,
    pub r#match: String,
    pub max_graphemes: usize,
    pub fonts: Vec<InputFont>,
    pub style: InputStyle,
    pub bindings: Vec<InputBinding>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputFont {
    pub sha256: String,
    pub face_index: u32,
    pub data_base64: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputStyle {
    pub font_size: f32,
    pub line_height: f32,
    pub font_weight: u16,
    pub font_style: crate::platform_text::TextFontStyle,
    pub color: [u8; 4],
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InputBinding {
    pub node_id: String,
    pub dataset_id: String,
    pub rows: crate::chart::ChartRows,
}
