#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FogSettings {
    color: [f32; 3],
    density: f32,
}

impl FogSettings {
    pub const DISABLED: Self = Self {
        color: [0.0; 3],
        density: 0.0,
    };
    pub const MAX_DENSITY: f32 = 8.0;
    pub const MAX_HDR_CHANNEL: f32 = 64.0;

    pub fn exponential(density: f32, color: [f32; 3]) -> Result<Self, String> {
        if !density.is_finite() || !(0.0..=Self::MAX_DENSITY).contains(&density) {
            return Err(format!(
                "fog density must be finite and within 0..={}",
                Self::MAX_DENSITY
            ));
        }
        if color
            .iter()
            .any(|channel| !channel.is_finite() || !(0.0..=Self::MAX_HDR_CHANNEL).contains(channel))
        {
            return Err(format!(
                "fog HDR color channels must be finite and within 0..={}",
                Self::MAX_HDR_CHANNEL
            ));
        }
        Ok(Self { color, density })
    }

    pub fn color(self) -> [f32; 3] {
        self.color
    }

    pub fn density(self) -> f32 {
        self.density
    }

    pub fn amount(self, world_distance: f32) -> Result<f32, String> {
        if !world_distance.is_finite() || world_distance < 0.0 {
            return Err("fog world distance must be finite and non-negative".into());
        }
        Ok((1.0 - (-self.density * world_distance).exp()).clamp(0.0, 1.0))
    }

    pub fn mix_hdr(self, color: [f32; 3], world_distance: f32) -> Result<[f32; 3], String> {
        if color.iter().any(|channel| !channel.is_finite()) {
            return Err("fog source HDR color must be finite".into());
        }
        let amount = self.amount(world_distance)?;
        Ok(std::array::from_fn(|index| {
            color[index] * (1.0 - amount) + self.color[index] * amount
        }))
    }

    pub fn frame_tuning(self) -> [f32; 4] {
        [self.color[0], self.color[1], self.color[2], self.density]
    }
}

impl Default for FogSettings {
    fn default() -> Self {
        Self::DISABLED
    }
}

#[cfg(test)]
mod tests {
    use super::FogSettings;

    #[test]
    fn exponential_fog_is_hdr_linear_monotonic_and_exactly_disabled() {
        let fog = FogSettings::exponential(0.2, [0.1, 0.2, 0.3]).unwrap();
        assert_eq!(
            FogSettings::DISABLED
                .mix_hdr([4.0, 2.0, 1.0], 100.0)
                .unwrap(),
            [4.0, 2.0, 1.0]
        );
        assert_eq!(fog.amount(0.0).unwrap(), 0.0);
        assert!(fog.amount(20.0).unwrap() > fog.amount(5.0).unwrap());
        let mixed = fog.mix_hdr([4.0, 2.0, 1.0], 10.0).unwrap();
        assert!(mixed[0] > fog.color()[0] && mixed[0] < 4.0);
    }

    #[test]
    fn invalid_parameters_and_distances_fail_closed() {
        for density in [f32::NAN, f32::INFINITY, -0.1, 8.1] {
            assert!(FogSettings::exponential(density, [0.0; 3]).is_err());
        }
        for color in [[f32::NAN, 0.0, 0.0], [-0.1, 0.0, 0.0], [65.0, 0.0, 0.0]] {
            assert!(FogSettings::exponential(0.1, color).is_err());
        }
        assert!(FogSettings::DISABLED.amount(f32::NAN).is_err());
        assert!(FogSettings::DISABLED.amount(-1.0).is_err());
    }
}
