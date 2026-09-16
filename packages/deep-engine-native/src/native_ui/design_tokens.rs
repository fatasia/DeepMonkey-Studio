//! U07: native reader for the versioned design-token snapshot exported from
//! `apps/web/src/styles/base.css` (see scripts/export-design-tokens.mjs).
//! Native never reads CSS/CSSOM — it validates and consumes this snapshot,
//! so brand overrides (`--accent`) and reduced-motion tiers stay verifiable.

use serde::{Deserialize, Serialize};

pub const DESIGN_TOKENS_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesignTokenSnapshot {
    pub schema_version: u32,
    pub id: String,
    pub source: String,
    pub brand_override_key: String,
    pub themes: DesignTokenThemes,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesignTokenThemes {
    pub dark: DesignTokenTheme,
    pub light: DesignTokenTheme,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesignTokenTheme {
    pub colors: DesignTokenColors,
    pub radii: DesignTokenRadii,
    pub spacing: DesignTokenSpacing,
    pub typography: DesignTokenTypography,
    pub motion: DesignTokenMotion,
    pub reduced_motion: DesignTokenMotion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesignTokenColors {
    #[serde(rename = "bg-0")]
    pub bg0: Option<[f64; 4]>,
    #[serde(rename = "bg-1")]
    pub bg1: Option<[f64; 4]>,
    #[serde(rename = "surface-1")]
    pub surface1: Option<[f64; 4]>,
    #[serde(rename = "surface-2")]
    pub surface2: Option<[f64; 4]>,
    #[serde(rename = "surface-3")]
    pub surface3: Option<[f64; 4]>,
    #[serde(rename = "line-subtle")]
    pub line_subtle: Option<[f64; 4]>,
    pub line: Option<[f64; 4]>,
    #[serde(rename = "line-strong")]
    pub line_strong: Option<[f64; 4]>,
    #[serde(rename = "text-strong")]
    pub text_strong: Option<[f64; 4]>,
    pub text: Option<[f64; 4]>,
    #[serde(rename = "text-muted")]
    pub text_muted: Option<[f64; 4]>,
    #[serde(rename = "text-faint")]
    pub text_faint: Option<[f64; 4]>,
    pub accent: Option<[f64; 4]>,
    #[serde(rename = "accent-hover")]
    pub accent_hover: Option<[f64; 4]>,
    #[serde(rename = "accent-soft")]
    pub accent_soft: Option<[f64; 4]>,
    pub success: Option<[f64; 4]>,
    pub warning: Option<[f64; 4]>,
    pub danger: Option<[f64; 4]>,
    pub info: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct DesignTokenRadii {
    pub radius_xs: f64,
    pub radius_sm: f64,
    pub radius_md: f64,
    pub radius_lg: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct DesignTokenSpacing {
    pub space_1: f64,
    pub space_2: f64,
    pub space_3: f64,
    pub space_4: f64,
    pub space_6: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesignTokenTypography {
    pub font_family: String,
    pub font_size_base: f64,
    pub line_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DesignTokenMotion {
    pub fast_ms: f64,
    pub base_ms: f64,
    pub slow_ms: f64,
    pub easing: String,
}

/// Validation: every required semantic color resolves, channels stay in
/// [0,1], radii/spacing are non-negative and both themes are present. The
/// snapshot is data, so native can reject a stale export instead of
/// rendering with half a palette.
pub fn validate_design_tokens(snapshot: &DesignTokenSnapshot) -> Result<(), String> {
    if snapshot.schema_version != DESIGN_TOKENS_SCHEMA_VERSION {
        return Err(format!(
            "Expected design token schema version {DESIGN_TOKENS_SCHEMA_VERSION}."
        ));
    }
    for theme_name in ["dark", "light"] {
        let theme = match theme_name {
            "dark" => &snapshot.themes.dark,
            _ => &snapshot.themes.light,
        };
        let colors = [
            theme.colors.bg0,
            theme.colors.surface1,
            theme.colors.text_strong,
            theme.colors.text,
            theme.colors.accent,
            theme.colors.accent_hover,
            theme.colors.success,
            theme.colors.warning,
            theme.colors.danger,
        ];
        for channel in colors.into_iter().flatten().flatten() {
            if !(0.0..=1.0).contains(&channel) {
                return Err(format!(
                    "{theme_name} color channel {channel} escapes [0,1]."
                ));
            }
        }
        if theme.colors.accent.is_none() || theme.colors.bg0.is_none() {
            return Err(format!("{theme_name} is missing required semantic colors."));
        }
        let non_negative = [
            theme.radii.radius_xs,
            theme.radii.radius_sm,
            theme.spacing.space_1,
            theme.spacing.space_6,
        ];
        if non_negative
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(format!(
                "{theme_name} radii/spacing must be finite and non-negative."
            ));
        }
        if theme.typography.font_size_base <= 0.0 || theme.typography.line_height <= 0.0 {
            return Err(format!("{theme_name} typography metrics must be positive."));
        }
        if theme.reduced_motion.fast_ms > theme.motion.fast_ms
            || theme.reduced_motion.base_ms > theme.motion.base_ms
        {
            return Err(format!(
                "{theme_name} reduced-motion durations must not exceed the standard ladder."
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> DesignTokenSnapshot {
        serde_json::from_str(
            r#"{
  "schemaVersion": 1,
  "id": "deep.design-tokens.v1",
  "source": "apps/web/src/styles/base.css",
  "brandOverrideKey": "--accent",
  "themes": {
    "dark": {
      "colors": {
        "bg-0": [0.043, 0.067, 0.078, 1], "bg-1": [0.027, 0.047, 0.059, 1],
        "surface-1": [0.067, 0.098, 0.114, 1], "surface-2": [0.09, 0.129, 0.149, 1],
        "surface-3": [0.11, 0.157, 0.18, 1],
        "line-subtle": [0.655, 0.718, 0.745, 0.1], "line": [0.655, 0.718, 0.745, 0.14],
        "line-strong": [0.655, 0.718, 0.745, 0.26],
        "text-strong": [0.902, 0.925, 0.937, 1], "text": [0.655, 0.698, 0.722, 1],
        "text-muted": [0.545, 0.596, 0.624, 1], "text-faint": [0.451, 0.506, 0.537, 1],
        "accent": [0.839, 0.667, 0.302, 1], "accent-hover": [0.878, 0.75, 0.477, 1],
        "accent-soft": [0.839, 0.667, 0.302, 0.14],
        "success": [0.349, 0.773, 0.553, 1], "warning": [0.847, 0.675, 0.322, 1],
        "danger": [0.886, 0.455, 0.471, 1], "info": [0.396, 0.682, 0.91, 1]
      },
      "radii": { "radius-xs": 4, "radius-sm": 6, "radius-md": 8, "radius-lg": 12 },
      "spacing": { "space-1": 4, "space-2": 8, "space-3": 12, "space-4": 16, "space-6": 24 },
      "typography": {
        "fontFamily": "Inter, ui-sans-serif, system-ui",
        "fontSizeBase": 13, "lineHeight": 1.45
      },
      "motion": { "fastMs": 150, "baseMs": 200, "slowMs": 320, "easing": "cubic-bezier(0.2, 0, 0, 1)" },
      "reducedMotion": { "fastMs": 0, "baseMs": 0, "slowMs": 0, "easing": "linear" }
    },
    "light": {
      "colors": {
        "bg-0": [0.929, 0.949, 0.957, 1], "bg-1": [0.969, 0.976, 0.98, 1],
        "surface-1": [1, 1, 1, 1], "surface-2": [0.945, 0.961, 0.965, 1],
        "surface-3": [0.906, 0.929, 0.937, 1],
        "line-subtle": [0.141, 0.216, 0.251, 0.09], "line": [0.141, 0.216, 0.251, 0.15],
        "line-strong": [0.141, 0.216, 0.251, 0.26],
        "text-strong": [0.09, 0.141, 0.169, 1], "text": [0.251, 0.318, 0.353, 1],
        "text-muted": [0.38, 0.447, 0.478, 1], "text-faint": [0.478, 0.537, 0.565, 1],
        "accent": [0.839, 0.667, 0.302, 1], "accent-hover": [0.315, 0.299, 0.209, 1],
        "accent-soft": [0.839, 0.667, 0.302, 0.3],
        "success": [0.149, 0.451, 0.306, 1], "warning": [0.549, 0.365, 0.071, 1],
        "danger": [0.69, 0.227, 0.271, 1], "info": [0.141, 0.412, 0.616, 1]
      },
      "radii": { "radius-xs": 4, "radius-sm": 6, "radius-md": 8, "radius-lg": 12 },
      "spacing": { "space-1": 4, "space-2": 8, "space-3": 12, "space-4": 16, "space-6": 24 },
      "typography": {
        "fontFamily": "Inter, ui-sans-serif, system-ui",
        "fontSizeBase": 13, "lineHeight": 1.45
      },
      "motion": { "fastMs": 150, "baseMs": 200, "slowMs": 320, "easing": "cubic-bezier(0.2, 0, 0, 1)" },
      "reducedMotion": { "fastMs": 0, "baseMs": 0, "slowMs": 0, "easing": "linear" }
    }
  }
}"#,
        )
        .expect("fixture snapshot")
    }

    #[test]
    fn exported_snapshot_file_parses_and_validates() {
        let raw = include_str!("../../fixtures/design-tokens-v1.json");
        let snapshot: DesignTokenSnapshot = serde_json::from_str(raw).expect("exported snapshot");
        validate_design_tokens(&snapshot).expect("exported snapshot must validate");
        // The brand accent stays stable across themes unless overridden.
        assert_eq!(
            snapshot.themes.dark.colors.accent,
            snapshot.themes.light.colors.accent
        );
        // Reduced motion collapses the ladder to zero.
        assert_eq!(snapshot.themes.dark.reduced_motion.base_ms, 0.0);
    }

    #[test]
    fn validation_rejects_out_of_range_channels_and_stale_versions() {
        let mut bad = snapshot();
        bad.themes.dark.colors.accent = Some([1.2, 0.0, 0.0, 1.0]);
        assert!(validate_design_tokens(&bad).is_err());

        let mut stale = snapshot();
        stale.schema_version = 2;
        assert!(validate_design_tokens(&stale).is_err());

        let mut missing = snapshot();
        missing.themes.light.colors.bg0 = None;
        assert!(validate_design_tokens(&missing).is_err());

        assert!(validate_design_tokens(&snapshot()).is_ok());
    }

    #[test]
    fn unknown_fields_fail_closed() {
        let raw = r#"{"schemaVersion":1,"id":"x","source":"s","brandOverrideKey":"--accent","themes":{},"extra":1}"#;
        assert!(serde_json::from_str::<DesignTokenSnapshot>(raw).is_err());
    }
}
