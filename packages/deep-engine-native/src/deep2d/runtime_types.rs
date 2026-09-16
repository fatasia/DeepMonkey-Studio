use serde::{Deserialize, Serialize};

use super::{Deep2dColor, Deep2dDisplayList, Deep2dMatrix, ImageSampling};

pub const DEEP_2D_RUNTIME_PACKAGE_SCHEMA: &str = "deep-engine.deep2d-runtime";
pub const DEEP_2D_RUNTIME_PACKAGE_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Deep2dRuntimePackage {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub revision: u64,
    pub composition: Deep2dComposition,
    pub display_list: Deep2dDisplayList,
    pub atlases: Vec<Deep2dAtlas>,
    pub quads: Vec<Deep2dAtlasQuad>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Deep2dComposition {
    PathThenAtlas,
    ZOrdered,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Deep2dRuntimeContent {
    DisplayList(Deep2dDisplayList),
    /// Host-only layered content; never accepted by the package wire decoder.
    Composite(super::Deep2dComposite),
    Package(Deep2dRuntimePackage),
}

impl Deep2dRuntimeContent {
    pub fn display_list(&self) -> &Deep2dDisplayList {
        match self {
            Self::DisplayList(value) => value,
            Self::Composite(value) => value.display_list(),
            Self::Package(value) => &value.display_list,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Deep2dAtlas {
    pub id: String,
    pub revision: u64,
    pub kind: Deep2dAtlasKind,
    pub format: Deep2dAtlasFormat,
    pub width: u32,
    pub height: u32,
    pub sampling: ImageSampling,
    pub data_base64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Deep2dAtlasKind {
    Glyph,
    Image,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Deep2dAtlasFormat {
    #[serde(rename = "r8unorm")]
    R8Unorm,
    #[serde(rename = "rgba8unorm-srgb")]
    Rgba8UnormSrgb,
}

impl Deep2dAtlasFormat {
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            Self::R8Unorm => 1,
            Self::Rgba8UnormSrgb => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Deep2dAtlasQuad {
    pub id: String,
    pub z_order: i32,
    pub transform: Deep2dMatrix,
    pub atlas_id: String,
    /// Pixel-space [x, y, width, height] within the atlas.
    pub source: [u32; 4],
    /// Logical-space [x, y, width, height] before `transform`.
    pub destination: [f64; 4],
    pub color: Deep2dColor,
    #[serde(default = "default_opacity")]
    pub opacity: f64,
}

fn default_opacity() -> f64 {
    1.0
}
