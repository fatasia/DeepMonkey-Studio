//! Native quality profile selection and bounded post-process budgets.
//!
//! The profile is deliberately small and opt-in. Existing callers keep their
//! exact feature values when `DEEP_ENGINE_QUALITY_PROFILE` is absent; a profile
//! only places a deterministic budget on Bloom, which is the Native effect with
//! an explicit allocation and pass cost. Scene-authored fog, shadows and GI are
//! never silently rewritten here.

use super::RendererFeatures;
use deep_engine_native::bloom::BloomSettings;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeQualityProfile {
    Performance,
    Balanced,
    High,
    Ultra,
}

impl NativeQualityProfile {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "performance" | "perf" => Some(Self::Performance),
            "balanced" | "balance" => Some(Self::Balanced),
            // Web/Deep GI calls the highest authored preset `quality`; accept
            // it as the Native equivalent so deployment scripts can share one
            // profile value across endpoints.
            "high" | "quality" => Some(Self::High),
            "ultra" => Some(Self::Ultra),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Performance => "performance",
            Self::Balanced => "balanced",
            Self::High => "high",
            Self::Ultra => "ultra",
        }
    }

    fn bloom_budget(self) -> (f32, f32) {
        match self {
            Self::Performance => (0.08, 0.75),
            Self::Balanced => (0.14, 1.0),
            Self::High => (0.2, 1.25),
            Self::Ultra => (0.28, 1.5),
        }
    }
}

pub(crate) fn requested() -> Result<Option<NativeQualityProfile>, String> {
    let Some(value) = std::env::var_os("DEEP_ENGINE_QUALITY_PROFILE") else {
        return Ok(None);
    };
    let value = value.to_str().ok_or_else(|| {
            "DEEP_ENGINE_QUALITY_PROFILE must be valid UTF-8 (performance|balanced|quality|high|ultra)"
            .to_string()
    })?;
    NativeQualityProfile::parse(value)
        .map(Some)
        .ok_or_else(|| format!("unknown DEEP_ENGINE_QUALITY_PROFILE `{value}`; expected performance, balanced, quality, high, or ultra"))
}

/// Apply the selected Native budget without changing the legacy no-profile path.
pub(crate) fn apply(features: RendererFeatures, profile: NativeQualityProfile) -> RendererFeatures {
    let (max_intensity, max_radius) = profile.bloom_budget();
    let bloom = if features.bloom.is_active() {
        BloomSettings {
            intensity: features.bloom.intensity.min(max_intensity),
            radius: features.bloom.radius.clamp(0.5, max_radius),
            ..features.bloom
        }
    } else {
        features.bloom
    };
    RendererFeatures { bloom, ..features }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::fog::FogSettings;

    fn features() -> RendererFeatures {
        RendererFeatures {
            bloom: BloomSettings::default(),
            fog: FogSettings::DISABLED,
            shadow_probe: false,
            ibl_probe: false,
            telemetry: false,
        }
    }

    #[test]
    fn parses_only_bounded_named_profiles() {
        assert_eq!(
            NativeQualityProfile::parse("PERF"),
            Some(NativeQualityProfile::Performance)
        );
        assert_eq!(
            NativeQualityProfile::parse(" balance "),
            Some(NativeQualityProfile::Balanced)
        );
        assert_eq!(
            NativeQualityProfile::parse("high"),
            Some(NativeQualityProfile::High)
        );
        assert_eq!(
            NativeQualityProfile::parse("quality"),
            Some(NativeQualityProfile::High)
        );
        assert_eq!(
            NativeQualityProfile::parse("ultra"),
            Some(NativeQualityProfile::Ultra)
        );
        assert_eq!(NativeQualityProfile::parse("cinematic"), None);
    }

    #[test]
    fn profile_caps_bloom_without_rewriting_fog_or_probe_flags() {
        let mut input = features();
        input.bloom.intensity = 2.0;
        input.bloom.radius = 2.0;
        let output = apply(input, NativeQualityProfile::Performance);
        assert_eq!(output.bloom.intensity, 0.08);
        assert_eq!(output.bloom.radius, 0.75);
        assert_eq!(output.fog, FogSettings::DISABLED);
        assert!(!output.shadow_probe);
        assert!(!output.ibl_probe);
    }

    #[test]
    fn disabled_bloom_stays_disabled_for_every_profile() {
        let mut input = features();
        input.bloom = BloomSettings::DISABLED;
        for profile in [
            NativeQualityProfile::Performance,
            NativeQualityProfile::Balanced,
            NativeQualityProfile::High,
            NativeQualityProfile::Ultra,
        ] {
            assert_eq!(apply(input, profile).bloom, BloomSettings::DISABLED);
        }
    }
}
