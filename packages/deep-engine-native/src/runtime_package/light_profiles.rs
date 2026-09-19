//! E02 IES 光域网运行包合同：`lightProfiles` 资源节与灯的 `ies` 引用的
//! Rust 消费者（生产者在 `packages/deep-engine`，golden 互钉见文末测试）。
//!
//! 量化纪律与 `r3_state` 同源：角度 0.5° 网格、坎德拉/流明 1e-3 网格、
//! `-0→+0`。f32 ULP 论证：跨端消费合同是 `intensity_factor = candela/max`
//! ∈ [0,1] 的 f64 位一致值；绝对坎德拉 v>8388 时 f32 半 ULP (v·5.96e-8) 已
//! 越过 5e-4 量化半宽，因此绝对值不做 f32 round-trip 承诺，消费切片必须吃
//! 归一化因子。round 半整数差异（JS 向 +∞ / Rust 远离零）不出现：采样内所
//! 有 round 输入非负。
//!
//! φ 对称折叠（LM-63 镜像语义）：对称 2 → I(φ)=I(360−φ)；对称 4 → 周期 180
//! 加镜像（g=φ mod 180，>90 折回）；对称 1 → 恒第 0 行（旋转对称，θ 剖面如
//! 实，不做镜像外推）。θ 超出实测角域 [首角,末角] → 0（合同性不外推）。

use serde::Deserialize;

pub const IES_MAX_CANDELA: f64 = 1_000_000.0;
pub const IES_MAX_TOTAL_LUMENS: f64 = 10_000_000.0;
const GRID_TOLERANCE: f64 = 1e-6;
const MAX_GRID_ENTRIES: usize = 512;

/// 灯对 `lightProfiles` 的引用。`rotationDeg` ∈ [0,360) 且在 0.5° 网格，
/// `scaleFactor` ∈ [0,10]；缺省行为与无 IES 灯完全一致。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LightIes {
    pub profile_id: String,
    pub rotation_deg: Option<f64>,
    pub scale_factor: Option<f64>,
}

impl LightIes {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_id.is_empty() || self.profile_id.len() > 128 {
            return Err("ies profileId must hold 1..128 characters".into());
        }
        if let Some(rotation) = self.rotation_deg {
            if !rotation.is_finite() || !(0.0..360.0).contains(&rotation) || !on_angle_grid(rotation) {
                return Err("ies rotationDeg must sit on the 0.5° grid inside [0,360)".into());
            }
        }
        if let Some(scale) = self.scale_factor {
            if !scale.is_finite() || !(0.0..=IES_MAX_SCALE).contains(&scale) {
                return Err("ies scaleFactor must be within [0,10]".into());
            }
        }
        Ok(())
    }
}

const IES_MAX_SCALE: f64 = 10.0;

/// 运行包内的一份量化光度表：θ 0.5° 网格严格升序，candela 1e-3 量化，
/// 行数由 horizontalSymmetry 决定（1=恰 1 行旋转对称；2=均匀铺满 [0,180]；
/// 4=均匀铺满 [0,90]，行距半度数 (span·2)/(rows−1) 必须是整数）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LightProfile {
    pub profile_id: String,
    pub format: String,
    pub vertical_angles: Vec<f64>,
    pub candela: Vec<Vec<f64>>,
    pub horizontal_symmetry: u8,
    pub total_lumens: f64,
}

impl LightProfile {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_id.is_empty() || self.profile_id.len() > 128 {
            return Err("profileId must hold 1..128 characters".into());
        }
        if self.format != "LM-63-1995" && self.format != "LM-63-2002" {
            return Err(format!("unsupported IES format {:?}", self.format));
        }
        if !matches!(self.horizontal_symmetry, 1 | 2 | 4) {
            return Err(format!("horizontalSymmetry {} must be 1, 2 or 4", self.horizontal_symmetry));
        }
        if self.vertical_angles.is_empty() || self.vertical_angles.len() > MAX_GRID_ENTRIES {
            return Err("verticalAngles must hold 1..512 entries".into());
        }
        let mut previous = f64::NAN;
        for &angle in &self.vertical_angles {
            if !angle.is_finite() || !(0.0..=180.0).contains(&angle) {
                return Err(format!("vertical angle {angle} is outside [0,180]"));
            }
            if !on_angle_grid(angle) {
                return Err(format!("angle {angle} is off the 0.5° grid"));
            }
            if angle <= previous {
                return Err(format!("vertical angles must be strictly ascending: {previous} → {angle}"));
            }
            previous = angle;
        }
        let rows = self.candela.len();
        match self.horizontal_symmetry {
            1 if rows != 1 => return Err("horizontalSymmetry=1 requires exactly one row".into()),
            2 if rows < 2 || 360 % (rows - 1) != 0 => {
                return Err("horizontalSymmetry=2 requires rows evenly covering [0,180] with a 0.5°-grid row step".into());
            }
            4 if rows < 2 || 180 % (rows - 1) != 0 => {
                return Err("horizontalSymmetry=4 requires rows evenly covering [0,90] with a 0.5°-grid row step".into());
            }
            _ => {}
        }
        for row in &self.candela {
            if row.len() != self.vertical_angles.len() {
                return Err("candela row width must match the vertical angle count".into());
            }
            for &value in row {
                if !value.is_finite() || !(0.0..=IES_MAX_CANDELA).contains(&value) {
                    return Err(format!("candela value {value} is out of contract range"));
                }
                if !on_candela_grid(value) {
                    return Err(format!("candela {value} is off the 1e-3 quantization grid"));
                }
            }
        }
        if !self.total_lumens.is_finite() || !(0.0..=IES_MAX_TOTAL_LUMENS).contains(&self.total_lumens) {
            return Err("totalLumens is out of contract range".into());
        }
        if !on_candela_grid(self.total_lumens) {
            return Err("totalLumens is off the 1e-3 quantization grid".into());
        }
        Ok(())
    }
}

fn on_angle_grid(value: f64) -> bool {
    value.is_finite() && (value * 2.0 - (value * 2.0).round()).abs() <= GRID_TOLERANCE
}

fn on_candela_grid(value: f64) -> bool {
    value.is_finite() && (value * 1000.0 - (value * 1000.0).round()).abs() <= GRID_TOLERANCE
}

/// 表内最大坎德拉（f64 归约，与 TS `iesMaxCandela` 逐位一致；-0 归一）。
pub fn ies_max_candela(profile: &LightProfile) -> f64 {
    let mut max = 0.0f64;
    for row in &profile.candela {
        for &value in row {
            max = max.max(if value == 0.0 { 0.0 } else { value });
        }
    }
    max
}

/// 采样预处理：maxCandela 与 φ 行距的半度数（对称 2 → 360/(rows−1)，
/// 4 → 180/(rows−1)，1 → 0），与 TS `prepareIesSampling` 逐位一致。
#[derive(Debug, Clone)]
pub struct IesSamplingTable {
    vertical_angles: Vec<f64>,
    candela: Vec<Vec<f64>>,
    horizontal_symmetry: u8,
    max_candela: f64,
    row_half_step: f64,
}

impl IesSamplingTable {
    pub fn from_profile(profile: &LightProfile) -> Self {
        let rows = profile.candela.len();
        let row_half_step = if profile.horizontal_symmetry == 1 || rows < 2 {
            0.0
        } else if profile.horizontal_symmetry == 2 {
            360.0 / (rows - 1) as f64
        } else {
            180.0 / (rows - 1) as f64
        };
        Self {
            vertical_angles: profile.vertical_angles.clone(),
            candela: profile.candela.clone(),
            horizontal_symmetry: profile.horizontal_symmetry,
            max_candela: ies_max_candela(profile),
            row_half_step,
        }
    }

    /// `intensityFactor(θ,φ)` 唯一权威语义（TS 镜像，见模块头注释）。
    pub fn intensity_factor(&self, theta_deg: f64, phi_deg: f64, rotation_deg: f64, scale_factor: f64) -> f64 {
        if !theta_deg.is_finite()
            || !phi_deg.is_finite()
            || !rotation_deg.is_finite()
            || !scale_factor.is_finite()
        {
            return 0.0;
        }
        if self.max_candela <= 0.0 || self.candela.is_empty() || self.vertical_angles.is_empty() {
            return 0.0;
        }
        let theta = theta_deg.max(0.0).min(180.0);
        let mut phi = (phi_deg - rotation_deg) % 360.0;
        if phi < 0.0 {
            phi += 360.0;
        }
        let theta_grid = (theta * 2.0).round() / 2.0;
        let mut phi_grid = (phi * 2.0).round() / 2.0;
        if phi_grid >= 360.0 {
            phi_grid = 0.0;
        }
        let mut g = phi_grid;
        let row = if self.horizontal_symmetry == 1 {
            0usize
        } else {
            if self.horizontal_symmetry == 2 {
                if g > 180.0 {
                    g = 360.0 - g; // 镜像半周：φ=180 保持末行，不折回第 0 行。
                }
            } else {
                g %= 180.0;
                if g > 90.0 {
                    g = 180.0 - g;
                }
            }
            ((g * 2.0) / self.row_half_step)
                .round()
                .clamp(0.0, (self.candela.len() - 1) as f64) as usize
        };
        let Some(column) = nearest_vertical_index(&self.vertical_angles, theta_grid) else {
            return 0.0; // θ 超出实测角域：不外推，如实返回无光。
        };
        let Some(candela) = self.candela.get(row).and_then(|row| row.get(column)) else {
            return 0.0;
        };
        (candela / self.max_candela) * scale_factor
    }
}

/// 垂直角最近邻：严格升序；并列取低索引；θ 在实测角域之外返回 None（不外推）。
fn nearest_vertical_index(angles: &[f64], theta: f64) -> Option<usize> {
    if angles.len() == 1 {
        return angles.first().is_some_and(|&angle| theta == angle).then_some(0);
    }
    let mut low = 0usize;
    let mut high = angles.len() - 1;
    while high - low > 1 {
        let mid = (low + high) / 2;
        if angles[mid] >= theta {
            high = mid;
        } else {
            low = mid;
        }
    }
    let (lower, upper) = (angles[low], angles[high]);
    if theta < lower || theta > upper {
        return None;
    }
    if theta <= lower {
        return Some(low);
    }
    if theta >= upper {
        return Some(high);
    }
    Some(if theta - lower <= upper - theta { low } else { high })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_package::runtime_content_sha256;
    use serde_json::Value;

    const GOLDEN: &str = include_str!("../../../deep-engine/fixtures/ies/e02-golden.json");

    fn sampling_table(candela: Vec<Vec<f64>>, vertical_angles: &[f64], symmetry: u8) -> IesSamplingTable {
        let profile = LightProfile {
            profile_id: "test.profile".into(),
            format: "LM-63-2002".into(),
            vertical_angles: vertical_angles.to_vec(),
            candela,
            horizontal_symmetry: symmetry,
            total_lumens: 0.0,
        };
        profile.validate().unwrap();
        IesSamplingTable::from_profile(&profile)
    }

    #[test]
    fn pins_the_ts_produced_tables_hashes_and_sample_series() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        assert_eq!(golden["schema"], "deep-engine.ies-golden");
        assert_eq!(golden["schemaVersion"], 1);
        let domain = golden["domain"].as_str().unwrap();
        let plan = &golden["samplePlan"];
        let read = |key: &str| -> Vec<f64> {
            plan[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_f64().unwrap())
                .collect()
        };
        let (thetas, phis, rotations, scales) = (read("thetaDeg"), read("phiDeg"), read("rotationDeg"), read("scaleFactor"));
        for entry in golden["profiles"].as_array().unwrap() {
            let table: LightProfile = serde_json::from_value(entry["profile"].clone()).unwrap();
            table.validate().unwrap_or_else(|error| panic!("{}: {error}", table.profile_id));
            // 表哈希：双端 canonical sha256 互钉（生产者 runtimeContentSha256）。
            assert_eq!(
                runtime_content_sha256(&entry["profile"]),
                entry["contentHash"].as_str().unwrap(),
                "{}",
                table.profile_id
            );
            // 采样计划按行序重算 f64 位模式序列并哈希，与 TS 逐位一致。
            let sampling = IesSamplingTable::from_profile(&table);
            let mut series = String::new();
            for &theta in &thetas {
                for &phi in &phis {
                    for &rotation in &rotations {
                        for &scale in &scales {
                            let factor = sampling.intensity_factor(theta, phi, rotation, scale);
                            let factor = if factor == 0.0 { 0.0 } else { factor };
                            series.push_str(&format!(
                                "{}|{theta:.6}|{phi:.6}|{rotation:.6}|{scale:.6}|{:016x}\n",
                                table.profile_id,
                                factor.to_bits()
                            ));
                        }
                    }
                }
            }
            let digest = crate::shader_package::hash::sha256(format!("{domain}{series}").as_bytes());
            assert_eq!(
                digest,
                golden["expectedFactorBits"][table.profile_id.as_str()].as_str().unwrap(),
                "{}",
                table.profile_id
            );
        }
    }

    #[test]
    fn integrates_the_uniform_cone_to_the_analytic_flux() {
        // 1000cd 半球：Φ = 2π·1000·(1−cos90°) = 6283.185 lm，采样积分误差 <1%。
        let angles: Vec<f64> = (0..37).map(|i| f64::from(i) * 2.5).collect();
        let table = sampling_table(vec![vec![1000.0; 37]], &angles, 1);
        let steps = 720;
        let mut flux = 0.0;
        for step in 0..steps {
            let theta = (f64::from(step) + 0.5) * 90.0 / f64::from(steps);
            let factor = table.intensity_factor(theta, 0.0, 0.0, 1.0);
            flux += factor * table.max_candela * theta.to_radians().sin()
                * (90.0 / f64::from(steps)).to_radians()
                * std::f64::consts::TAU;
        }
        let ratio = flux / (std::f64::consts::TAU * 1000.0);
        assert!((0.99..1.01).contains(&ratio), "flux ratio {ratio}");
    }

    #[test]
    fn folds_phi_by_mirror_semantics_and_honors_rotation_and_scale() {
        // 对称 2，行角 0/90/180：φ=180 必须保持末行；φ=270 镜像回 90。
        let table = sampling_table(
            vec![vec![1000.0; 3], vec![100.0; 3], vec![25.0; 3]],
            &[0.0, 45.0, 90.0],
            2,
        );
        assert_eq!(table.intensity_factor(45.0, 0.0, 0.0, 1.0), 1.0);
        assert_eq!(table.intensity_factor(45.0, 90.0, 0.0, 1.0), 0.1);
        assert_eq!(table.intensity_factor(45.0, 180.0, 0.0, 1.0), 0.025);
        assert_eq!(table.intensity_factor(45.0, 270.0, 0.0, 1.0), 0.1);
        assert_eq!(table.intensity_factor(45.0, 45.0, 45.0, 1.0), 1.0);
        assert_eq!(table.intensity_factor(45.0, 90.0, 45.0, 1.0), table.intensity_factor(45.0, 45.0, 0.0, 1.0));
        assert_eq!(table.intensity_factor(45.0, 0.0, 0.0, 1.0), table.intensity_factor(45.0, 0.0, 0.0, 0.5) * 2.0);
        assert_eq!(table.intensity_factor(45.0, 0.0, 0.0, 10.0), 10.0);
        assert_eq!(table.intensity_factor(45.0, 0.0, 0.0, 0.0), 0.0);
        // 旋转对称表对 rotationDeg 不敏感。
        let spin = sampling_table(vec![vec![1000.0, 500.0, 0.0]], &[0.0, 90.0, 180.0], 1);
        assert_eq!(spin.intensity_factor(90.0, 0.0, 0.0, 1.0), spin.intensity_factor(90.0, 123.5, 217.0, 1.0));
    }

    #[test]
    fn treats_asymmetric_profiles_and_out_of_domain_theta_faithfully() {
        // 对称 1：θ 剖面非对称如实采样，不做镜像。
        let table = sampling_table(
            vec![vec![1000.0, 800.0, 600.0, 400.0, 200.0, 50.0, 0.0]],
            &[0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0],
            1,
        );
        assert_eq!(table.intensity_factor(30.0, 0.0, 0.0, 1.0), 0.8);
        assert_eq!(table.intensity_factor(150.0, 217.0, 0.0, 1.0), 0.05);
        assert_eq!(table.intensity_factor(47.0, 0.0, 0.0, 1.0), 0.6);
        // 查询角量化到 0.5° 网格；并列取低索引；超出实测角域不外推。
        assert_eq!(table.intensity_factor(31.0, 0.0, 0.0, 1.0), 0.8);
        let ties = sampling_table(vec![vec![1000.0, 400.0, 100.0]], &[0.0, 10.0, 20.0], 1);
        assert_eq!(ties.intensity_factor(10.24, 0.0, 0.0, 1.0), ties.intensity_factor(10.0, 0.0, 0.0, 1.0));
        assert_eq!(ties.intensity_factor(15.0, 0.0, 0.0, 1.0), 0.4);
        assert_eq!(ties.intensity_factor(20.24, 0.0, 0.0, 1.0), 0.1);
        assert_eq!(ties.intensity_factor(20.8, 0.0, 0.0, 1.0), 0.0);
        // 半光度表只测到 90°：θ>90 无光；clamp 后 0 仍在域内。
        let half = sampling_table(vec![vec![1000.0, 500.0, 100.0]], &[0.0, 45.0, 90.0], 1);
        assert_eq!(half.intensity_factor(90.0, 0.0, 0.0, 1.0), 0.1);
        assert_eq!(half.intensity_factor(120.0, 0.0, 0.0, 1.0), 0.0);
        assert_eq!(half.intensity_factor(-0.4, 0.0, 0.0, 1.0), 1.0);
        // 非有限输入 fail-safe；全黑表无光。
        assert_eq!(ties.intensity_factor(f64::NAN, 0.0, 0.0, 1.0), 0.0);
        assert_eq!(ties.intensity_factor(0.0, f64::INFINITY, 0.0, 1.0), 0.0);
        let dark = sampling_table(vec![vec![0.0]], &[0.0], 1);
        assert_eq!(ies_max_candela(&LightProfile {
            profile_id: "dark".into(),
            format: "LM-63-2002".into(),
            vertical_angles: vec![0.0],
            candela: vec![vec![0.0]],
            horizontal_symmetry: 1,
            total_lumens: 0.0,
        }), 0.0);
        assert_eq!(dark.intensity_factor(0.0, 0.0, 0.0, 1.0), 0.0);
    }

    #[test]
    fn rejects_off_grid_off_quantum_and_shape_broken_tables() {
        let valid = LightProfile {
            profile_id: "p".into(),
            format: "LM-63-2002".into(),
            vertical_angles: vec![0.0, 45.0, 90.0],
            candela: vec![vec![1000.0, 500.0, 100.0]],
            horizontal_symmetry: 1,
            total_lumens: 1234.5,
        };
        assert!(valid.validate().is_ok());
        let off_grid = LightProfile { vertical_angles: vec![0.0, 45.0, 90.25], ..valid.clone() };
        assert!(off_grid.validate().err().unwrap().contains("0.5° grid"));
        let off_quantum = LightProfile { candela: vec![vec![1000.0005, 500.0, 100.0]], ..valid.clone() };
        assert!(off_quantum.validate().err().unwrap().contains("1e-3 quantization grid"));
        let bad_symmetry = LightProfile { horizontal_symmetry: 3, ..valid.clone() };
        assert!(bad_symmetry.validate().err().unwrap().contains("1, 2 or 4"));
        let two_rows_sym1 = LightProfile {
            candela: vec![vec![1000.0, 500.0, 100.0], vec![1000.0, 500.0, 100.0]],
            ..valid.clone()
        };
        assert!(two_rows_sym1.validate().err().unwrap().contains("exactly one row"));
        // 对称 2 需要 (rows−1) 整除 360 半度：8 行 → 360%7≠0 → 拒绝。
        let eight_rows_sym2 = LightProfile {
            candela: vec![vec![1000.0, 500.0, 100.0]; 8],
            horizontal_symmetry: 2,
            ..valid.clone()
        };
        assert!(eight_rows_sym2.validate().err().unwrap().contains("evenly covering"));
        let three_rows_sym2 = LightProfile {
            vertical_angles: vec![0.0, 90.0, 180.0],
            candela: vec![vec![1000.0, 500.0, 100.0]; 3],
            horizontal_symmetry: 2,
            ..valid.clone()
        };
        assert!(three_rows_sym2.validate().is_ok());
        let bad_format = LightProfile { format: "LM-63-1986".into(), ..valid.clone() };
        assert!(bad_format.validate().err().unwrap().contains("format"));
        let huge = LightProfile { candela: vec![vec![2_000_000.0, 500.0, 100.0]], ..valid.clone() };
        assert!(huge.validate().err().unwrap().contains("out of contract range"));
        let negative_lumens = LightProfile { total_lumens: -1.0, ..valid };
        assert!(negative_lumens.validate().err().unwrap().contains("totalLumens"));
    }

    #[test]
    fn validates_ies_references_and_rejects_unknown_fields() {
        let ok = LightIes { profile_id: "grid.cone".into(), rotation_deg: Some(45.0), scale_factor: Some(0.5) };
        assert!(ok.validate().is_ok());
        for (ies, message) in [
            (LightIes { profile_id: String::new(), ..ok.clone() }, "profileId"),
            (LightIes { rotation_deg: Some(45.25), ..ok.clone() }, "rotationDeg"),
            (LightIes { rotation_deg: Some(360.0), ..ok.clone() }, "rotationDeg"),
            (LightIes { scale_factor: Some(10.5), ..ok.clone() }, "scaleFactor"),
        ] {
            assert!(ies.validate().err().unwrap().contains(message));
        }
        // 未知字段必须被结构拒绝（deny_unknown_fields 与 TS 白名单一致）。
        let parsed: Result<LightIes, _> = serde_json::from_value(serde_json::json!({
            "profileId": "p", "bogus": true
        }));
        assert!(parsed.is_err());
    }
}
