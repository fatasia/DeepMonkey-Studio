//! GPUI 对标 paint 模型(Deep2dPaint 及渐变变体)的 wire 类型与手工
//! serde(command_types 的 `#[path]` 子模块,体量门)。Solid 保持
//! `[r,g,b,a]` 数组 wire 形状,legacy display list 逐字节兼容;渐变走
//! `{"kind": ...}` 对象,几何在命令本地空间、GPU 片元逐像素求值。

use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{self, MapAccess, SeqAccess, Visitor},
    ser::SerializeMap,
};

use super::non_null_option;
use super::super::types::Deep2dColor;

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
}
