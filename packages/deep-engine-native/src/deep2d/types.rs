use serde::{Deserialize, Serialize};

use super::command_types::Deep2dCommand;

pub type Deep2dColor = [f64; 4];
pub type Deep2dMatrix = [f64; 6];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Deep2dDisplayList {
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub logical_width: f64,
    pub logical_height: f64,
    pub scale_factor: f64,
    pub resources: Vec<Deep2dResource>,
    pub commands: Vec<Deep2dCommand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Deep2dResource {
    Path(PathResource),
    Font(FontResource),
    Image(ImageResource),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PathResource {
    pub id: String,
    pub revision: u64,
    pub verbs: Vec<Deep2dPathVerb>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FontResource {
    pub id: String,
    pub revision: u64,
    pub asset_id: String,
    pub family: String,
    pub weight: u16,
    pub style: FontStyle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ImageResource {
    pub id: String,
    pub revision: u64,
    pub asset_id: String,
    pub width: u32,
    pub height: u32,
    pub color_space: ImageColorSpace,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "op", rename_all = "lowercase")]
pub enum Deep2dPathVerb {
    Move {
        x: f64,
        y: f64,
    },
    Line {
        x: f64,
        y: f64,
    },
    Quadratic {
        cx: f64,
        cy: f64,
        x: f64,
        y: f64,
    },
    Cubic {
        c1x: f64,
        c1y: f64,
        c2x: f64,
        c2y: f64,
        x: f64,
        y: f64,
    },
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    Normal,
    Italic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageColorSpace {
    Srgb,
    Linear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Deep2dIssueCode {
    InvalidStructure,
    InvalidSchemaVersion,
    InvalidId,
    DuplicateId,
    InvalidRevision,
    InvalidNumber,
    InvalidColor,
    InvalidTransform,
    InvalidPath,
    MissingResource,
    ResourceKindMismatch,
    EmptyPaint,
    BudgetExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deep2dIssue {
    pub code: Deep2dIssueCode,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deep2dValidationResult {
    pub valid: bool,
    pub issues: Vec<Deep2dIssue>,
}
