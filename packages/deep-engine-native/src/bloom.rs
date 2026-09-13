#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BloomSettings {
    pub enabled: bool,
    pub threshold: f32,
    pub soft_knee: f32,
    pub intensity: f32,
    pub radius: f32,
}

impl BloomSettings {
    pub const DISABLED: Self = Self {
        enabled: false,
        threshold: 1.0,
        soft_knee: 0.5,
        intensity: 0.0,
        radius: 1.0,
    };

    pub fn validate(self) -> Result<Self, String> {
        validate_finite("threshold", self.threshold)?;
        validate_finite("soft knee", self.soft_knee)?;
        validate_finite("intensity", self.intensity)?;
        validate_finite("radius", self.radius)?;
        if !(0.0..=64.0).contains(&self.threshold) {
            return Err("bloom threshold must be within 0..=64 linear luminance".into());
        }
        if !(0.0..=1.0).contains(&self.soft_knee) {
            return Err("bloom soft knee must be within 0..=1".into());
        }
        if !(0.0..=4.0).contains(&self.intensity) {
            return Err("bloom intensity must be within 0..=4".into());
        }
        if !(0.5..=2.0).contains(&self.radius) {
            return Err("bloom radius must be within 0.5..=2".into());
        }
        Ok(self)
    }

    pub fn is_active(self) -> bool {
        self.enabled && self.intensity > 0.0
    }
}

impl Default for BloomSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            threshold: 1.0,
            soft_knee: 0.5,
            intensity: 0.14,
            radius: 1.0,
        }
    }
}

fn validate_finite(name: &str, value: f32) -> Result<(), String> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(format!("bloom {name} must be finite"))
    }
}

#[cfg(test)]
mod tests {
    use super::BloomSettings;

    #[test]
    fn defaults_enable_a_bounded_hdr_bloom() {
        let settings = BloomSettings::default().validate().unwrap();
        assert!(settings.is_active());
        assert!(settings.threshold >= 1.0);
        assert!((0.0..=1.0).contains(&settings.soft_knee));
    }

    #[test]
    fn disabled_mode_has_no_active_post_process() {
        assert!(!BloomSettings::DISABLED.validate().unwrap().is_active());
    }

    #[test]
    fn rejects_non_finite_and_unbounded_controls() {
        for invalid in [
            BloomSettings {
                threshold: f32::NAN,
                ..Default::default()
            },
            BloomSettings {
                soft_knee: 1.01,
                ..Default::default()
            },
            BloomSettings {
                intensity: -0.01,
                ..Default::default()
            },
            BloomSettings {
                radius: 2.01,
                ..Default::default()
            },
        ] {
            assert!(invalid.validate().is_err(), "accepted {invalid:?}");
        }
    }
}
