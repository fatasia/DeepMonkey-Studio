//! 命令结构(Path/Text/Image)与词法枚举(体量门拆分;条目逐字未改)。

use serde::{Deserialize, Serialize};

use super::blend::{BackdropBlur, Deep2dBlendMode};
use super::paint::{BoxShadow, Deep2dPaint};
use crate::deep2d::types::{Deep2dColor, Deep2dMatrix, Deep2dRect};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Deep2dCommand {
    Path(PathCommand),
    Text(TextCommand),
    Image(ImageCommand),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PathCommand {
    pub id: String,
    pub z_order: i32,
    pub transform: Deep2dMatrix,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub hit_id: Option<String>,
    pub path_id: String,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill: Option<Deep2dPaint>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill_rule: Option<FillRule>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke: Option<Deep2dColor>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke_width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_cap: Option<LineCap>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_join: Option<LineJoin>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub miter_limit: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub dash: Option<Vec<f64>>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub dash_offset: Option<f64>,
    /// GPUI-style analytic rounded corners. The path resource must be one
    /// closed axis-aligned rectangle; fill and stroke then rasterize through
    /// the fragment-stage rounded-box SDF with zero CPU arc geometry.
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_radius: Option<f64>,
    /// GPUI box shadow drawn behind the fill; requires `corner_radius`
    /// (shadows are box-shaped, matching the GPUI quad semantic).
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub shadow: Option<BoxShadow>,
    /// GPUI-aligned blend mode applied to the command's composited fragment
    /// output (shadow + fill + stroke as one primitive). Absent = `normal`,
    /// which keeps legacy display lists byte-compatible.
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub blend: Option<Deep2dBlendMode>,
    /// Frosted-glass backdrop blur (GPUI backdrop semantics): the rendered
    /// target below this command is captured, downsampled and separably
    /// blurred, then drawn as the command's base color under its own
    /// fill/stroke/shadow. Requires `cornerRadius` (box-shaped mask).
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub backdrop_blur: Option<BackdropBlur>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextCommand {
    pub id: String,
    pub z_order: i32,
    pub transform: Deep2dMatrix,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub hit_id: Option<String>,
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub font_id: String,
    pub font_size: f64,
    pub color: Deep2dColor,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub align: Option<TextAlign>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub baseline: Option<TextBaseline>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub direction: Option<TextDirection>,
    /// Native runtime extension: the glyph atlas selected by `bakedGlyphs`.
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub atlas_id: Option<String>,
    /// Host-shaped glyphs in draw order. Destinations are relative to `(x, y)`.
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub baked_glyphs: Option<Vec<BakedGlyphPlacement>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BakedGlyphPlacement {
    /// UTF-16 cluster offset in `TextCommand::text`; informational but bounded.
    pub cluster: u32,
    /// Pixel-space [x, y, width, height] inside the glyph atlas.
    pub source: [u32; 4],
    /// Logical [x, y, width, height] relative to the command origin.
    pub destination: [f64; 4],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ImageCommand {
    pub id: String,
    pub z_order: i32,
    pub transform: Deep2dMatrix,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub hit_id: Option<String>,
    pub image_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub atlas_id: Option<String>,
    /// Pixel-space [x, y, width, height] inside the referenced atlas.
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub source: Option<[u32; 4]>,
    #[serde(
        default,
        deserialize_with = "super::non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub sampling: Option<ImageSampling>,
}

macro_rules! string_enum {
    ($name:ident { $($variant:ident),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(rename_all = "lowercase")]
        pub enum $name { $($variant),+ }
    };
}

string_enum!(FillRule { Nonzero, Evenodd });
string_enum!(LineCap {
    Butt,
    Round,
    Square
});
string_enum!(LineJoin {
    Miter,
    Round,
    Bevel
});
string_enum!(TextAlign { Start, Center, End });
string_enum!(TextBaseline {
    Top,
    Middle,
    Alphabetic,
    Bottom
});
string_enum!(TextDirection { Ltr, Rtl });
string_enum!(ImageSampling { Nearest, Linear });
