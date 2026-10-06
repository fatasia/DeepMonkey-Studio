use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::SerializeMap,
};

use super::types::{Deep2dColor, Deep2dMatrix, Deep2dRect};

fn non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[path = "command_paint.rs"]
mod paint;
pub use paint::{BoxShadow, Deep2dPaint, GradientStop, LinearGradientPaint, RadialGradientPaint};

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
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub hit_id: Option<String>,
    pub path_id: String,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill: Option<Deep2dPaint>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill_rule: Option<FillRule>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke: Option<Deep2dColor>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub stroke_width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_cap: Option<LineCap>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub line_join: Option<LineJoin>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub miter_limit: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub dash: Option<Vec<f64>>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub dash_offset: Option<f64>,
    /// GPUI-style analytic rounded corners. The path resource must be one
    /// closed axis-aligned rectangle; fill and stroke then rasterize through
    /// the fragment-stage rounded-box SDF with zero CPU arc geometry.
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_radius: Option<f64>,
    /// GPUI box shadow drawn behind the fill; requires `corner_radius`
    /// (shadows are box-shaped, matching the GPUI quad semantic).
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub shadow: Option<BoxShadow>,
    /// GPUI-aligned blend mode applied to the command's composited fragment
    /// output (shadow + fill + stroke as one primitive). Absent = `normal`,
    /// which keeps legacy display lists byte-compatible.
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub blend: Option<Deep2dBlendMode>,
    /// Frosted-glass backdrop blur (GPUI backdrop semantics): the rendered
    /// target below this command is captured, downsampled and separably
    /// blurred, then drawn as the command's base color under its own
    /// fill/stroke/shadow. Requires `cornerRadius` (box-shaped mask).
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub backdrop_blur: Option<BackdropBlur>,
}

/// GPUI blend-mode vocabulary. Upstream GPUI ships `normal | overwrite |
/// multiply | darken | lighten`; `screen` extends the set with a CSS mode
/// that is exactly expressible with fixed-function factors. `overlay` and
/// the rest of the CSS list are intentionally absent: they need the backdrop
/// value inside the fragment shader, which a single fixed-function blend
/// stage cannot express (upstream GPUI does not ship them either).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Deep2dBlendMode {
    Normal,
    Multiply,
    Screen,
    Darken,
    Lighten,
    Overwrite,
}

impl Deep2dBlendMode {
    /// Storage encoding carried in paint entries (mirrors WGSL).
    pub fn as_u32(self) -> u32 {
        match self {
            Self::Normal => 0,
            Self::Multiply => 1,
            Self::Screen => 2,
            Self::Darken => 3,
            Self::Lighten => 4,
            Self::Overwrite => 5,
        }
    }

    pub fn from_u32(value: u32) -> Option<Self> {
        Some(match value {
            0 => Self::Normal,
            1 => Self::Multiply,
            2 => Self::Screen,
            3 => Self::Darken,
            4 => Self::Lighten,
            5 => Self::Overwrite,
            _ => return None,
        })
    }

    /// Fixed-function mapping needs a premultiplied fragment output for
    /// exactly these modes (`src.rgb` already carries `* alpha` before the
    /// blend stage multiplies by destination factors). Mirrored in WGSL.
    pub fn premultiplies(self) -> bool {
        matches!(self, Self::Multiply | Self::Screen)
    }
}

/// Frosted-glass backdrop blur parameters. The radius selects the number of
/// separable `[1, 4, 6, 4, 1] / 16` blur sweeps on the half-resolution
/// capture: `iterations = ceil(radius / 2)` clamped to `1..=4`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BackdropBlur {
    /// Must be positive and bounded by `DEEP2D_MAX_BACKDROP_RADIUS`.
    pub radius: f64,
}

/// Backdrop blur budgets: the capture chain allocates per-frame scratch, so
/// both the per-command radius and the per-frame command count fail closed.
pub const DEEP2D_MAX_BACKDROP_RADIUS: f64 = 64.0;
pub const DEEP2D_MAX_BACKDROP_COMMANDS_PER_FRAME: usize = 8;
/// Separable sweep count for a authored radius (deterministic, budgeted).
pub fn backdrop_blur_iterations(radius: f64) -> u32 {
    ((radius / 2.0).ceil() as u32).clamp(1, 4)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TextCommand {
    pub id: String,
    pub z_order: i32,
    pub transform: Deep2dMatrix,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
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
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_width: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub align: Option<TextAlign>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub baseline: Option<TextBaseline>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub direction: Option<TextDirection>,
    /// Native runtime extension: the glyph atlas selected by `bakedGlyphs`.
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub atlas_id: Option<String>,
    /// Host-shaped glyphs in draw order. Destinations are relative to `(x, y)`.
    #[serde(
        default,
        deserialize_with = "non_null_option",
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
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub opacity: Option<f64>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_path_ids: Option<Vec<String>>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub clip_rect: Option<Deep2dRect>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
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
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub atlas_id: Option<String>,
    /// Pixel-space [x, y, width, height] inside the referenced atlas.
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub source: Option<[u32; 4]>,
    #[serde(
        default,
        deserialize_with = "non_null_option",
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

#[cfg(test)]
mod paint_serde_tests {
    use super::*;

    #[test]
    fn blend_mode_wire_uses_lowercase_and_rejects_unknowns() {
        assert_eq!(
            serde_json::to_string(&Deep2dBlendMode::Multiply).expect("serialize blend"),
            "\"multiply\""
        );
        for (word, mode) in [
            ("normal", Deep2dBlendMode::Normal),
            ("multiply", Deep2dBlendMode::Multiply),
            ("screen", Deep2dBlendMode::Screen),
            ("darken", Deep2dBlendMode::Darken),
            ("lighten", Deep2dBlendMode::Lighten),
            ("overwrite", Deep2dBlendMode::Overwrite),
        ] {
            assert_eq!(
                serde_json::from_str::<Deep2dBlendMode>(&format!(r#""{word}""#))
                    .expect("parse blend"),
                mode
            );
        }
        assert!(serde_json::from_str::<Deep2dBlendMode>(r#""overlay""#).is_err());
        assert!(serde_json::from_str::<Deep2dBlendMode>(r#""Multiplied""#).is_err());
        // Storage encoding round-trips and rejects holes.
        for mode in [
            Deep2dBlendMode::Normal,
            Deep2dBlendMode::Multiply,
            Deep2dBlendMode::Screen,
            Deep2dBlendMode::Darken,
            Deep2dBlendMode::Lighten,
            Deep2dBlendMode::Overwrite,
        ] {
            assert_eq!(Deep2dBlendMode::from_u32(mode.as_u32()), Some(mode));
        }
        assert_eq!(Deep2dBlendMode::from_u32(6), None);
    }

    #[test]
    fn legacy_commands_without_blend_and_backdrop_stay_byte_compatible() {
        // A pre-blend wire payload must parse and re-serialize identically:
        // absent optional fields are skipped, so the round trip is exact.
        let legacy = r#"{"kind":"path","id":"p","zOrder":0,"transform":[1.0,0.0,0.0,1.0,0.0,0.0],"pathId":"rect","fill":[1.0,0.0,0.0,1.0]}"#;
        // tag=kind 在 Deep2dCommand 层消费(PathCommand deny_unknown_fields)。
        let command: PathCommand = match serde_json::from_str::<Deep2dCommand>(legacy)
            .expect("legacy path")
        {
            Deep2dCommand::Path(path) => path,
            other => panic!("expected path command, got {:?}", other),
        };
        assert_eq!(command.blend, None);
        assert_eq!(command.backdrop_blur, None);
        // 逐字节往返以 wire 类型为准(tag=kind 在枚举层)。
        let wire = serde_json::to_string(&Deep2dCommand::Path(command.clone())).expect("re-serialize");
        assert_eq!(wire, legacy);
    }

    #[test]
    fn blend_and_backdrop_round_trip_and_fail_closed() {
        // wire 解析走 Deep2dCommand(tag=kind 在枚举层消费;PathCommand 自身
        // deny_unknown_fields,直接解会把 kind 判 unknown —— 生产无此路径)。
        let parse_path = |json: &str| -> PathCommand {
            match serde_json::from_str::<Deep2dCommand>(json).expect("parse blend+backdrop") {
                Deep2dCommand::Path(path) => path,
                other => panic!("expected path command, got {:?}", other),
            }
        };
        let json = r#"{"kind":"path","id":"p","zOrder":0,"transform":[1.0,0.0,0.0,1.0,0.0,0.0],"pathId":"rect","fill":[1.0,0.0,0.0,1.0],"blend":"multiply","backdropBlur":{"radius":8.0}}"#;
        let command = parse_path(json);
        assert_eq!(command.blend, Some(Deep2dBlendMode::Multiply));
        assert_eq!(
            command.backdrop_blur,
            Some(BackdropBlur { radius: 8.0 })
        );
        let serialized = serde_json::to_string(&command).expect("serialize");
        assert!(serialized.contains(r#""blend":"multiply""#));
        assert!(serialized.contains(r#""backdropBlur":{"radius":8.0}"#));
        // Unknown blend variants and unknown blur fields fail closed.
        assert!(serde_json::from_str::<Deep2dCommand>(
            r#"{"kind":"path","id":"p","zOrder":0,"transform":[1.0,0.0,0.0,1.0,0.0,0.0],"pathId":"rect","fill":[1.0,0.0,0.0,1.0],"blend":"overlay"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<Deep2dCommand>(
            r#"{"kind":"path","id":"p","zOrder":0,"transform":[1.0,0.0,0.0,1.0,0.0,0.0],"pathId":"rect","fill":[1.0,0.0,0.0,1.0],"backdropBlur":{"radius":8.0,"bogus":1}}"#
        )
        .is_err());
    }

    #[test]
    fn backdrop_blur_iterations_are_bounded_and_deterministic() {
        assert_eq!(backdrop_blur_iterations(0.5), 1);
        assert_eq!(backdrop_blur_iterations(4.0), 2);
        assert_eq!(backdrop_blur_iterations(7.9), 4);
        assert_eq!(backdrop_blur_iterations(64.0), 4);
        assert_eq!(backdrop_blur_iterations(1_000.0), 4, "clamped, never unbounded");
    }
}
