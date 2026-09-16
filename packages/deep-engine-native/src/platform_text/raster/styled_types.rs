use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrozenFontInput {
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub face_index: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FrozenFontRef {
    pub sha256: String,
    pub face_index: u32,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextFontStyle {
    Normal,
    Italic,
    Oblique,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextVerticalAlign {
    Top,
    Center,
    Bottom,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextWrap {
    None,
    Word,
    Glyph,
    WordOrGlyph,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StyledTextRequest {
    pub text: String,
    pub font: FrozenFontRef,
    pub weight: u16,
    pub style: TextFontStyle,
    pub align: TextAlign,
    pub vertical_align: TextVerticalAlign,
    pub wrap: TextWrap,
    pub font_size: f32,
    pub line_height: f32,
    pub width: u32,
    pub height: u32,
    pub color: [u8; 4],
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedFontFace {
    pub sha256: String,
    pub face_index: u32,
    pub family: String,
    pub post_script_name: String,
    pub weight: u16,
    pub style: TextFontStyle,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayoutLine {
    pub line_index: usize,
    pub baseline: f32,
    pub top: f32,
    pub height: f32,
    pub width: f32,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyledRasterizedText {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub glyph_count: usize,
    pub line_count: usize,
    pub layout_width: f32,
    pub layout_height: f32,
    /// Visible nontransparent pixels: [left, top, rightExclusive, bottomExclusive].
    /// None means the output viewport contains no ink; full-text overflow is in clipped.
    pub ink_bounds: Option<[u32; 4]>,
    pub clipped: bool,
    pub lines: Vec<TextLayoutLine>,
    pub used_faces: Vec<UsedFontFace>,
}
