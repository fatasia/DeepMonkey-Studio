//! GPUI 混合模式词表与背景模糊预算(体量门拆分;条目逐字未改)。

use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod blend_wire_tests {
    use super::super::commands::{Deep2dCommand, PathCommand};
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
