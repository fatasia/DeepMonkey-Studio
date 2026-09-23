#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FogSettings {
    color: [f32; 3],
    density: f32,
    exp2: bool,
    /// 受预算约束的屏幕空间体积近似：沿当前像素的线性深度做固定步数积分。
    /// 它不是 froxel/体积光照管线，诊断和文档会保留这个边界。
    volumetric: bool,
    volumetric_steps: u32,
    volumetric_height: f32,
    volumetric_anisotropy: f32,
}

impl FogSettings {
    pub const DISABLED: Self = Self {
        color: [0.0; 3],
        density: 0.0,
        exp2: false,
        volumetric: false,
        volumetric_steps: 8,
        volumetric_height: 64.0,
        volumetric_anisotropy: 0.0,
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
        Ok(Self {
            color,
            density,
            exp2: false,
            volumetric: false,
            volumetric_steps: 8,
            volumetric_height: 64.0,
            volumetric_anisotropy: 0.0,
        })
    }

    /// 轻量 Native 体积雾：输出阶段固定 8 步深度积分，避免引入 froxel
    /// 纹理和独立光照体积；适合普通工业场景的空气感，不宣称全局体积光。
    pub fn volumetric(density: f32, color: [f32; 3]) -> Result<Self, String> {
        Self::volumetric_with_profile(density, color, 8, 64.0, 0.0)
    }

    pub fn volumetric_with_profile(
        density: f32,
        color: [f32; 3],
        steps: u32,
        height: f32,
        anisotropy: f32,
    ) -> Result<Self, String> {
        let mut fog = Self::exponential(density, color)?;
        if !(1..=64).contains(&steps) {
            return Err("volumetric fog steps must be within 1..=64".into());
        }
        if !height.is_finite() || !(1.0..=256.0).contains(&height) {
            return Err("volumetric fog height must be within 1..=256".into());
        }
        if !anisotropy.is_finite() || !(-0.99..=0.99).contains(&anisotropy) {
            return Err("volumetric fog anisotropy must be within -0.99..=0.99".into());
        }
        fog.volumetric = true;
        fog.volumetric_steps = steps;
        fog.volumetric_height = height;
        fog.volumetric_anisotropy = anisotropy;
        Ok(fog)
    }

    /// 作者雾在片元 HDR 域合成，透明混合之前处理，背景不受影响。
    pub fn authored_exp2(density: f32, color: [f32; 3]) -> Result<Self, String> {
        let mut fog = Self::exponential(density, color)?;
        fog.exp2 = true;
        Ok(fog)
    }

    pub fn is_authored(self) -> bool {
        self.exp2
    }

    pub fn is_volumetric(self) -> bool {
        self.volumetric
    }

    pub fn requires_output_pass(self) -> bool {
        !self.exp2 && self.density > 0.0
    }

    pub fn frame_projection(self, near: f32, far: f32) -> [f32; 4] {
        [near, far, if self.exp2 { 2.0 } else if self.volumetric { 1.0 } else { 0.0 }, 0.0]
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
        let optical_depth = self.density * world_distance;
        Ok((1.0
            - (-if self.exp2 {
                optical_depth * optical_depth
            } else {
                optical_depth
            })
            .exp())
        .clamp(0.0, 1.0))
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

    pub fn frame_profile(self) -> [f32; 4] {
        [
            self.volumetric_steps as f32,
            self.volumetric_height,
            self.volumetric_anisotropy,
            if self.volumetric { 1.0 } else { 0.0 },
        ]
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
        for density in [f32::NAN, f32::INFINITY, -0.1, 8.1] {
            assert!(FogSettings::authored_exp2(density, [0.0; 3]).is_err());
        }
        assert!(FogSettings::authored_exp2(0.1, [f32::NAN, 0.0, 0.0]).is_err());
    }

    /// Three FogExp2 GLSL: fogFactor = 1 - exp(-density² * depth²)；
    /// 参考值来自 f64 直接计算，f32 容差 1e-6。
    #[test]
    fn authored_exp2_matches_three_fog_exp2_reference_values() {
        let fog = FogSettings::authored_exp2(0.25, [0.2, 0.4, 0.8]).unwrap();
        assert!(fog.is_authored());
        let expected: [(f32, f64); 4] = [
            (0.0, 0.0),
            (2.0, 1.0 - (-0.25_f64).exp()),
            (6.0, 1.0 - (-2.25_f64).exp()),
            (40.0, 1.0),
        ];
        for (distance, reference) in expected {
            let amount = fog.amount(distance).unwrap();
            assert!(
                (f64::from(amount) - reference).abs() < 1e-6,
                "exp2 amount at {distance}: {amount} != {reference}"
            );
        }
        // 同参数下 exp1 与 exp2 可区分，且两者都单调收敛到 1。
        let legacy = FogSettings::exponential(0.25, [0.2, 0.4, 0.8]).unwrap();
        let legacy_reference = 1.0 - (-0.5_f64).exp();
        assert!((f64::from(legacy.amount(2.0).unwrap()) - legacy_reference).abs() < 1e-6);
        assert!((legacy.amount(2.0).unwrap() - fog.amount(2.0).unwrap()).abs() > 0.1);
        assert!(fog.amount(1.0).unwrap() < fog.amount(2.0).unwrap());
    }

    #[test]
    fn authored_exp2_projection_flags_and_output_pass_policy_match_cpu_formula() {
        let fog = FogSettings::authored_exp2(0.15, [0.5, 0.25, 0.125]).unwrap();
        assert_eq!(fog.frame_projection(0.3, 250.0), [0.3, 250.0, 2.0, 0.0]);
        let legacy = FogSettings::exponential(0.15, [0.5, 0.25, 0.125]).unwrap();
        assert_eq!(legacy.frame_projection(0.1, 100.0), [0.1, 100.0, 0.0, 0.0]);
        // 作者雾在片元合成：不需要输出雾 pass；legacy 密度雾需要；禁用态两者皆否。
        assert!(!fog.requires_output_pass());
        assert!(legacy.requires_output_pass());
        assert!(!FogSettings::DISABLED.requires_output_pass());
        assert_eq!(fog.frame_tuning(), [0.5, 0.25, 0.125, 0.15]);
        let mixed = fog.mix_hdr([1.0, 0.0, 0.5], 2.0).unwrap();
        let amount = fog.amount(2.0).unwrap();
        let reference: Vec<f32> = (0..3)
            .map(|axis| [1.0, 0.0, 0.5][axis] * (1.0 - amount) + [0.5, 0.25, 0.125][axis] * amount)
            .collect();
        for axis in 0..3 {
            assert!((mixed[axis] - reference[axis]).abs() < 1e-6);
        }
    }

    #[test]
    fn volumetric_mode_is_bounded_and_uses_linear_projection_flag() {
        let fog = FogSettings::volumetric(0.12, [0.2, 0.3, 0.4]).unwrap();
        assert!(fog.is_volumetric());
        assert!(!fog.is_authored());
        assert!(fog.requires_output_pass());
        assert_eq!(fog.frame_projection(0.1, 100.0), [0.1, 100.0, 1.0, 0.0]);
        assert!(fog.amount(10.0).unwrap() > 0.0);
        assert_eq!(fog.frame_profile(), [8.0, 64.0, 0.0, 1.0]);
    }

    #[test]
    fn volumetric_profile_is_validated_and_preserved_in_frame_data() {
        let fog = FogSettings::volumetric_with_profile(0.12, [0.2, 0.3, 0.4], 48, 32.0, -0.2).unwrap();
        assert_eq!(fog.frame_profile(), [48.0, 32.0, -0.2, 1.0]);
        assert!(FogSettings::volumetric_with_profile(0.1, [0.0; 3], 0, 64.0, 0.0).is_err());
        assert!(FogSettings::volumetric_with_profile(0.1, [0.0; 3], 48, 0.0, 0.0).is_err());
        assert!(FogSettings::volumetric_with_profile(0.1, [0.0; 3], 48, 64.0, 1.0).is_err());
    }
}
