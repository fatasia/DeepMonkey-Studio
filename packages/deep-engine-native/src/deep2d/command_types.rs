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

/// GPUI-aligned paint model. Solid keeps the historical wire shape
/// (`[r, g, b, a]`) so legacy display lists are byte-compatible; gradients
/// travel as `{"kind": "linear"|"radial", ...}` objects. Gradient geometry is
/// authored in the command's local (pre-transform) space and is evaluated
/// per-pixel on the GPU fragment stage.
#[derive(Debug, Clone, PartialEq)]
pub enum Deep2dPaint {
    Solid(Deep2dColor),
    LinearGradient(LinearGradientPaint),
    RadialGradient(RadialGradientPaint),
}

impl From<Deep2dColor> for Deep2dPaint {
    fn from(color: Deep2dColor) -> Self {
        Self::Solid(color)
    }
}

impl Deep2dPaint {
    /// Solid channel accessor; gradients return `None` (readers that need a
    /// concrete color must resolve gradients themselves).
    pub fn solid_color(&self) -> Option<Deep2dColor> {
        match self {
            Self::Solid(color) => Some(*color),
            Self::LinearGradient(_) | Self::RadialGradient(_) => None,
        }
    }

    /// Returns a copy with every paint layer's alpha scaled by `factor`
    /// (element opacity / hover dimming). Gradient stop colors are scaled
    /// uniformly so dimming never changes hue.
    #[must_use]
    pub fn with_alpha_factor(&self, factor: f64) -> Self {
        let scale = |color: &mut Deep2dColor| color[3] = (color[3] * factor).clamp(0.0, 1.0);
        match self {
            Self::Solid(color) => {
                let mut color = *color;
                scale(&mut color);
                Self::Solid(color)
            }
            Self::LinearGradient(gradient) => {
                let mut gradient = gradient.clone();
                gradient
                    .stops
                    .iter_mut()
                    .for_each(|stop| scale(&mut stop.color));
                Self::LinearGradient(gradient)
            }
            Self::RadialGradient(gradient) => {
                let mut gradient = gradient.clone();
                gradient
                    .stops
                    .iter_mut()
                    .for_each(|stop| scale(&mut stop.color));
                Self::RadialGradient(gradient)
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GradientStop {
    /// Ramp position in `[0, 1]`.
    pub offset: f64,
    pub color: Deep2dColor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LinearGradientPaint {
    /// Ramp start point in local command space.
    pub start: [f64; 2],
    /// Ramp end point in local command space.
    pub end: [f64; 2],
    pub stops: Vec<GradientStop>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RadialGradientPaint {
    /// Circle center in local command space (GPUI semantic: a circle in the
    /// paint's own space, not an ellipse under the command transform).
    pub center: [f64; 2],
    /// Circle radius in local units; must be positive.
    pub radius: f64,
    pub stops: Vec<GradientStop>,
}

/// GPUI box-shadow semantics: a blurred rounded box, offset in local space,
/// inflated by `spread`, drawn behind the fill.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BoxShadow {
    pub offset_x: f64,
    pub offset_y: f64,
    /// Must be non-negative; `0` renders a crisp shadowed box edge.
    pub blur_radius: f64,
    /// Inflates (positive) or shrinks (negative) the shadowed box.
    pub spread: f64,
    pub color: Deep2dColor,
    /// Defaults to the command's `cornerRadius` when absent; clamped like it.
    #[serde(
        default,
        deserialize_with = "non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_radius: Option<f64>,
}

impl BoxShadow {
    /// Effective shadow corner radius: the explicit value or the quad's own
    /// clamped corner radius (GPUI semantic).
    pub fn radius(&self, fallback: f64) -> f64 {
        self.corner_radius.unwrap_or(fallback)
    }
}

impl<'de> Deserialize<'de> for Deep2dPaint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct PaintVisitor;

        impl<'de> Visitor<'de> for PaintVisitor {
            type Value = Deep2dPaint;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(
                    "a solid [r, g, b, a] array or a {\"kind\": \"linear\"|\"radial\"} gradient object",
                )
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut color = [0.0f64; 4];
                for (index, channel) in color.iter_mut().enumerate() {
                    *channel = seq
                        .next_element::<f64>()?
                        .ok_or_else(|| de::Error::invalid_length(index, &"4 color channels"))?;
                }
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(5, &"exactly 4 color channels"));
                }
                Ok(Deep2dPaint::Solid(color))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut kind: Option<String> = None;
                let mut color: Option<Deep2dColor> = None;
                let mut start: Option<[f64; 2]> = None;
                let mut end: Option<[f64; 2]> = None;
                let mut center: Option<[f64; 2]> = None;
                let mut radius: Option<f64> = None;
                let mut stops: Option<Vec<GradientStop>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "kind" => kind = Some(map.next_value::<String>()?),
                        "color" => color = Some(map.next_value::<Deep2dColor>()?),
                        "start" => start = Some(map.next_value::<[f64; 2]>()?),
                        "end" => end = Some(map.next_value::<[f64; 2]>()?),
                        "center" => center = Some(map.next_value::<[f64; 2]>()?),
                        "radius" => radius = Some(map.next_value::<f64>()?),
                        "stops" => stops = Some(map.next_value::<Vec<GradientStop>>()?),
                        other => {
                            return Err(de::Error::unknown_field(other, &[
                                "kind", "color", "start", "end", "center", "radius", "stops",
                            ]));
                        }
                    }
                }
                match kind.as_deref() {
                    Some("solid") => Ok(Deep2dPaint::Solid(color.ok_or_else(|| {
                        de::Error::missing_field("color")
                    })?)),
                    Some("linear") => Ok(Deep2dPaint::LinearGradient(LinearGradientPaint {
                        start: start.ok_or_else(|| de::Error::missing_field("start"))?,
                        end: end.ok_or_else(|| de::Error::missing_field("end"))?,
                        stops: stops.ok_or_else(|| de::Error::missing_field("stops"))?,
                    })),
                    Some("radial") => Ok(Deep2dPaint::RadialGradient(RadialGradientPaint {
                        center: center.ok_or_else(|| de::Error::missing_field("center"))?,
                        radius: radius.ok_or_else(|| de::Error::missing_field("radius"))?,
                        stops: stops.ok_or_else(|| de::Error::missing_field("stops"))?,
                    })),
                    other => Err(de::Error::unknown_variant(
                        other.unwrap_or("(missing)"),
                        &["solid", "linear", "radial"],
                    )),
                }
            }
        }

        deserializer.deserialize_any(PaintVisitor)
    }
}

impl Serialize for Deep2dPaint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Solid(color) => color.serialize(serializer),
            Self::LinearGradient(gradient) => {
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("kind", "linear")?;
                map.serialize_entry("start", &gradient.start)?;
                map.serialize_entry("end", &gradient.end)?;
                map.serialize_entry("stops", &gradient.stops)?;
                map.end()
            }
            Self::RadialGradient(gradient) => {
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("kind", "radial")?;
                map.serialize_entry("center", &gradient.center)?;
                map.serialize_entry("radius", &gradient.radius)?;
                map.serialize_entry("stops", &gradient.stops)?;
                map.end()
            }
        }
    }
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
    fn solid_keeps_the_historical_array_wire_shape() {
        let paint = Deep2dPaint::Solid([0.25, 0.5, 0.75, 1.0]);
        let json = serde_json::to_string(&paint).expect("serialize solid");
        assert_eq!(json, "[0.25,0.5,0.75,1.0]");
        let back: Deep2dPaint = serde_json::from_str(&json).expect("parse solid");
        assert_eq!(back, paint);
    }

    #[test]
    fn solid_accepts_tagged_form_and_rejects_unknown_fields() {
        let back: Deep2dPaint =
            serde_json::from_str(r#"{"kind":"solid","color":[1,1,1,1]}"#).expect("tagged solid");
        assert_eq!(back, Deep2dPaint::Solid([1.0, 1.0, 1.0, 1.0]));
        assert!(serde_json::from_str::<Deep2dPaint>(r#"{"kind":"solid"}"#).is_err());
        assert!(
            serde_json::from_str::<Deep2dPaint>(r#"{"kind":"solid","color":[1,1,1,1],"x":0}"#)
                .is_err(),
            "unknown fields must fail closed"
        );
    }

    #[test]
    fn linear_and_radial_gradients_round_trip() {
        let linear = Deep2dPaint::LinearGradient(LinearGradientPaint {
            start: [0.0, 0.0],
            end: [10.0, 0.0],
            stops: vec![
                GradientStop {
                    offset: 0.0,
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                GradientStop {
                    offset: 1.0,
                    color: [0.0, 0.0, 1.0, 1.0],
                },
            ],
        });
        let json = serde_json::to_string(&linear).expect("serialize linear");
        assert!(json.contains(r#""kind":"linear""#));
        assert_eq!(
            serde_json::from_str::<Deep2dPaint>(&json).expect("parse linear"),
            linear
        );
        let radial = Deep2dPaint::RadialGradient(RadialGradientPaint {
            center: [5.0, 5.0],
            radius: 4.0,
            stops: linear
                .solid_color()
                .map(|_| GradientStop {
                    offset: 0.0,
                    color: [0.0, 0.0, 0.0, 1.0],
                })
                .into_iter()
                .collect(),
        });
        let json = serde_json::to_string(&radial).expect("serialize radial");
        assert_eq!(
            serde_json::from_str::<Deep2dPaint>(&json).expect("parse radial"),
            radial
        );
    }

    #[test]
    fn unknown_paint_kind_and_bad_shapes_fail_closed() {
        assert!(serde_json::from_str::<Deep2dPaint>(r#"{"kind":"mesh"}"#).is_err());
        assert!(serde_json::from_str::<Deep2dPaint>("[]").is_err());
        assert!(serde_json::from_str::<Deep2dPaint>("[1,2,3]").is_err());
        assert!(serde_json::from_str::<Deep2dPaint>("[1,2,3,4,5]").is_err());
        assert!(serde_json::from_str::<Deep2dPaint>(r#"{"kind":"linear"}"#).is_err());
    }

    #[test]
    fn box_shadow_wire_uses_camel_case_and_rejects_unknowns() {
        let shadow = BoxShadow {
            offset_x: 1.0,
            offset_y: 2.0,
            blur_radius: 3.0,
            spread: -1.0,
            color: [0.0, 0.0, 0.0, 0.5],
            corner_radius: None,
        };
        let json = serde_json::to_string(&shadow).expect("serialize shadow");
        assert!(json.contains("\"offsetX\""));
        assert!(json.contains("\"blurRadius\""));
        assert_eq!(
            serde_json::from_str::<BoxShadow>(&json).expect("parse shadow"),
            shadow
        );
        assert!(
            serde_json::from_str::<BoxShadow>(r#"{"offsetX":0,"offsetY":0,"blurRadius":0,"spread":0,"color":[0,0,0,1],"bogus":1}"#)
                .is_err()
        );
    }

    #[test]
    fn with_alpha_factor_scales_solid_and_gradient_layers() {
        let solid = Deep2dPaint::Solid([1.0, 0.0, 0.0, 0.8]);
        assert_eq!(
            solid.with_alpha_factor(0.5),
            Deep2dPaint::Solid([1.0, 0.0, 0.0, 0.4])
        );
        let gradient = Deep2dPaint::LinearGradient(LinearGradientPaint {
            start: [0.0, 0.0],
            end: [1.0, 0.0],
            stops: vec![GradientStop {
                offset: 0.0,
                color: [1.0, 1.0, 1.0, 1.0],
            }],
        });
        let Deep2dPaint::LinearGradient(dimmed) = gradient.with_alpha_factor(0.25) else {
            panic!("gradient stays gradient");
        };
        assert_eq!(dimmed.stops[0].color[3], 0.25);
    }

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
