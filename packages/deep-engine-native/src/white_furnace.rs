//! J2-B3 Rust 白炉(white furnace)验收核心——CPU 参考判据移植与 IBL split-sum
//! 修复对拍(无 GPU/DOM 依赖;GPU 腿见 bin 侧 `renderer/white_furnace_gpu_tests`)。
//!
//! TS 权威(只读基线):
//! - `packages/deep-engine/src/webgpu/whiteFurnace.ts` — C12 白炉验收器
//!   (区域统计、四判据、缺陷模型);
//! - `packages/deep-engine/src/webgpu/pbrShader.ts` `shade()` IBL 段 — C12 修复式
//!   (漫反射/高光的能量分配必须用同一 split-sum 分数)。
//!
//! 容差与统计口径逐式移植;字面量由 `tolerances_match_ts_authority` 逐项锁定,
//! 任一端单独改容差即在此暴露(SSR toggle 判据为 web SSR 合成链专属,native
//! mesh 路径无 SSR 开关腿,不在移植面,见报告声明)。
//!
//! 修复对拍(J2-B3 审计结论):native 三处同款 C12 缺陷——
//! 1. `assets/shaders/native_mesh_v1.wgsl` `fragment_main` IBL 段;
//! 2. `assets/shaders/native_mesh_rt_fragment_v1.wgsl` `fragment_main_rt` IBL 段
//!    (同步契约随本体,同族清剿);
//! 3. `ibl::split_sum_ibl` CPU 参考实现(参考即权威,随 TS 修复式对齐)。
//! 原实现把漫反射储备定在镜面 Schlick(`1 − f`,rough→1 坍缩为 `1 − f0`),而高光
//! 实际交付 LUT 分数(`(f0·dfg.x + dfg.y) · 多重散射补偿`),白粗糙面总出射
//! ≈ 0.9735E → 白炉欠冲约 −2.65%(C12 在 web 真机实测 max −2.637%)。
//! 修复式 `total = (1 − fraction) + fraction ≡ 1` 对任意 f0/rough/nv 构造性守恒;
//! 金属路径(漫反射为 0)与镜面极限(fraction→f0)逐位不变。

use crate::ibl::{PreparedIblCube, PreparedIblCubeMip, PreparedIblEnvironment, PreparedIblTexture2d};

/// 白炉环境辐射度(线性 HDR);0.5 留出双向误差余量,避免半精度钳制混淆。
/// 与 TS `WHITE_FURNACE_ENVIRONMENT_RADIANCE` 同值。
pub const FURNACE_ENVIRONMENT_RADIANCE: f64 = 0.5;

/// 相对误差容差(逐项对齐 TS `FURNACE_TOLERANCES`;字面量由测试锁定)。
/// background 是纯采样链;geometry 含 IBL 卷积、DFG 采样与 half 缓冲。
pub struct FurnaceTolerances {
    pub background_mean_relative: f64,
    pub background_max_relative: f64,
    pub geometry_mean_relative: f64,
    pub geometry_max_relative: f64,
    /// RGB 均值相对亮度通道的增益漂移;均匀炉内三通道必须等值。
    pub channel_gain_drift: f64,
}

/// 与 TS `FURNACE_TOLERANCES` 逐字段同值的唯一容差源(Rust 半)。
pub const FURNACE_TOLERANCES: FurnaceTolerances = FurnaceTolerances {
    background_mean_relative: 0.005,
    background_max_relative: 0.02,
    geometry_mean_relative: 0.02,
    geometry_max_relative: 0.08,
    channel_gain_drift: 0.02,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FurnaceRegion {
    /// 区域分割码 0:几何。
    Geometry,
    /// 区域分割码 1:背景。
    Background,
}

impl FurnaceRegion {
    fn code(self) -> u8 {
        match self {
            FurnaceRegion::Geometry => 0,
            FurnaceRegion::Background => 1,
        }
    }
}

/// 已知圆盘轮廓附近的排除环带(硬边缘像素不进任何域的统计)。
pub const SEGMENT_EXCLUDED: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub struct FurnaceRegionStats {
    pub region: FurnaceRegion,
    pub pixels: usize,
    pub mean_radiance: f64,
    pub mean_relative_error: f64,
    pub max_abs_relative_error: f64,
    pub p99_abs_relative_error: f64,
    /// mean(channel)/mean(luma);>1 表示该通道能量泄漏(色偏检测)。
    pub channel_gain: [f64; 3],
}

#[derive(Clone, Debug)]
pub struct FurnaceCheck {
    pub name: &'static str,
    pub passed: bool,
    pub detail: String,
}

fn percent(value: f64) -> String {
    format!("{:.3}%", 100.0 * value)
}

/// TS `regionStats` 逐式移植:luma 权重 0.2126/0.7152/0.0722,mean/max/p99
/// 相对误差 + 通道增益。空域返回 `None`(判据层 fail-closed)。
pub fn region_stats(
    pixels: &[[f32; 3]],
    segmentation: Option<&[u8]>,
    environment_radiance: f64,
    region: FurnaceRegion,
) -> Option<FurnaceRegionStats> {
    let want = region.code();
    let mut count = 0usize;
    let mut luma_sum = 0.0f64;
    let mut channel_sums = [0.0f64; 3];
    let mut relative = Vec::new();
    for (index, pixel) in pixels.iter().enumerate() {
        if let Some(segmentation) = segmentation {
            if segmentation.get(index).copied().unwrap_or(SEGMENT_EXCLUDED) != want {
                continue;
            }
        }
        let (r, g, b) = (f64::from(pixel[0]), f64::from(pixel[1]), f64::from(pixel[2]));
        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        count += 1;
        luma_sum += luma;
        channel_sums[0] += r;
        channel_sums[1] += g;
        channel_sums[2] += b;
        relative.push((luma - environment_radiance).abs() / environment_radiance);
    }
    if count == 0 {
        return None;
    }
    relative.sort_by(|left, right| left.total_cmp(right));
    let mean_luma = luma_sum / count as f64;
    let channel_gain = [
        channel_sums[0] / count as f64 / mean_luma,
        channel_sums[1] / count as f64 / mean_luma,
        channel_sums[2] / count as f64 / mean_luma,
    ];
    Some(FurnaceRegionStats {
        region,
        pixels: count,
        mean_radiance: mean_luma,
        mean_relative_error: (mean_luma - environment_radiance) / environment_radiance,
        max_abs_relative_error: relative[relative.len() - 1],
        p99_abs_relative_error: relative[((0.99 * relative.len() as f64) as usize)
            .min(relative.len() - 1)],
        channel_gain,
    })
}

/// TS `furnaceSphereSegmentation` 逐式移植:已知相机(眼距/垂直 FOV)、球心与
/// 半径,轮廓是屏空间圆盘;环带内外各留 8% 安全带。0=geometry、1=background、
/// 2=排除环带。
pub fn furnace_sphere_segmentation(
    width: usize,
    height: usize,
    eye_distance: f64,
    radius: f64,
    vertical_fov_radians: f64,
) -> Vec<u8> {
    let alpha = (radius / eye_distance).clamp(0.0, 1.0).asin();
    let disc_radius = (alpha.tan() / (vertical_fov_radians / 2.0).tan()) * (height as f64 / 2.0);
    let guard = (disc_radius * 0.08).max(1.0);
    let (center_x, center_y) = (width as f64 / 2.0, height as f64 / 2.0);
    let mut region_of = vec![SEGMENT_EXCLUDED; width * height];
    for y in 0..height {
        for x in 0..width {
            let distance = ((x as f64 + 0.5 - center_x).powi(2)
                + (y as f64 + 0.5 - center_y).powi(2))
            .sqrt();
            region_of[y * width + x] = if distance < disc_radius - guard {
                0
            } else if distance > disc_radius + guard {
                1
            } else {
                SEGMENT_EXCLUDED
            };
        }
    }
    region_of
}

/// TS `predictedFurnaceOvershoot` 逐式移植:C12 缺陷模型——
/// 过冲系数 = `f_spec·comp − Schlick(f)`。供修复前后测量对照。
pub fn predicted_furnace_overshoot(f0: f64, roughness: f64, nv: f64, dfg: [f64; 2]) -> f64 {
    let fresnel = f0 + ((1.0 - roughness).max(f0) - f0) * (1.0 - nv).powi(5);
    let specular = f0 * dfg[0] + dfg[1];
    let compensation = 1.0 + f0 * (1.0 / (dfg[0] + dfg[1]).max(0.05) - 1.0);
    specular * compensation - fresnel
}

/// 修复前的总出射系数(缺陷复刻,供 before/after CPU 对照):
/// `total_before = (1 − Schlick) + LUT 分数 × 补偿`。
pub fn legacy_defect_total(f0: f64, roughness: f64, nv: f64, dfg: [f64; 2]) -> f64 {
    let fresnel = f0 + ((1.0 - roughness).max(f0) - f0) * (1.0 - nv).powi(5);
    let specular = f0 * dfg[0] + dfg[1];
    let compensation = 1.0 + f0 * (1.0 / (dfg[0] + dfg[1]).max(0.05) - 1.0);
    (1.0 - fresnel) + specular * compensation
}

/// 修复后的总出射系数:`total = (1 − fraction) + fraction`。
/// f64 下构造性恒等于 1(测试锁定);f32/GPU 下误差只来自最后一 bit 舍入。
pub fn fixed_split_total(f0: f64, dfg: [f64; 2]) -> f64 {
    let fraction = split_sum_fraction(f0, dfg);
    (1.0 - fraction) + fraction
}

/// TS 修复式单点:同一 split-sum 分数(含 clamp 与多重散射补偿)。
pub fn split_sum_fraction(f0: f64, dfg: [f64; 2]) -> f64 {
    let energy_compensation = 1.0 + f0 * (1.0 / (dfg[0] + dfg[1]).max(0.05) - 1.0);
    ((f0 * dfg[0] + dfg[1]).clamp(0.0, 1.0)) * energy_compensation
}

/// 均匀恒定辐射度白炉环境:specular 全 mip、diffuse 逐 texel 填充 E;
/// BRDF LUT 与环境无关(纯 GGX 重要性采样积分),取内建 LUT 复用。
/// 经 `imported_hdri` 合同校验 fail-closed。
pub fn uniform_furnace_environment(
    builtin: &PreparedIblEnvironment,
    radiance: f64,
) -> PreparedIblEnvironment {
    let fill_cube = |source: &PreparedIblCube| PreparedIblCube {
        mips: source
            .mips
            .iter()
            .map(|mip| PreparedIblCubeMip {
                size: mip.size,
                texels: vec![[radiance as f32, radiance as f32, radiance as f32, 1.0]; mip.texels.len()],
            })
            .collect(),
    };
    let specular = fill_cube(&builtin.specular);
    let diffuse = fill_cube(&builtin.diffuse);
    let content_hash = crate::shader_package::hash::sha256(
        &specular.mips[0]
            .texels
            .iter()
            .flat_map(|texel| texel.map(f32::to_le_bytes))
            .flatten()
            .collect::<Vec<u8>>(),
    );
    PreparedIblEnvironment::imported_hdri(
        "deep.probe.white-furnace.v1",
        1,
        content_hash,
        specular,
        diffuse,
        PreparedIblTexture2d {
            width: builtin.brdf_lut.width,
            height: builtin.brdf_lut.height,
            texels: builtin.brdf_lut.texels.clone(),
        },
    )
    .expect("uniform furnace environment must satisfy the imported HDRI contract")
}

/// 能量守恒判据(TS `evaluateFurnaceChecks` 逐式移植):存在的域在 pixels>0 时
/// 逐项断言,全空帧 fail-closed。腿按场景声明域;缺域不是缺陷。
pub fn evaluate_furnace_checks(
    background: Option<FurnaceRegionStats>,
    geometry: Option<FurnaceRegionStats>,
) -> Vec<FurnaceCheck> {
    let mut checks = Vec::new();
    let background_pixels = background.map(|s| s.pixels).unwrap_or(0);
    let geometry_pixels = geometry.map(|s| s.pixels).unwrap_or(0);
    checks.push(FurnaceCheck {
        name: "furnace-frame-nonempty",
        passed: background_pixels > 0 || geometry_pixels > 0,
        detail: format!("background={background_pixels} geometry={geometry_pixels}"),
    });
    if let Some(background) = background.filter(|s| s.pixels > 0) {
        checks.push(FurnaceCheck {
            name: "furnace-background-uniform",
            passed: background.mean_relative_error.abs()
                <= FURNACE_TOLERANCES.background_mean_relative
                && background.max_abs_relative_error
                    <= FURNACE_TOLERANCES.background_max_relative,
            detail: format!(
                "pixels={} meanErr={} maxErr={}",
                background.pixels,
                percent(background.mean_relative_error),
                percent(background.max_abs_relative_error)
            ),
        });
        checks.push(FurnaceCheck {
            name: "furnace-background-no-chroma-drift",
            passed: background
                .channel_gain
                .iter()
                .all(|gain| (gain - 1.0).abs() <= FURNACE_TOLERANCES.channel_gain_drift),
            detail: format!(
                "gain=[{:.4}, {:.4}, {:.4}]",
                background.channel_gain[0], background.channel_gain[1], background.channel_gain[2]
            ),
        });
    }
    if let Some(geometry) = geometry.filter(|s| s.pixels > 0) {
        checks.push(FurnaceCheck {
            name: "furnace-geometry-conserved",
            passed: geometry.mean_relative_error.abs()
                <= FURNACE_TOLERANCES.geometry_mean_relative
                && geometry.max_abs_relative_error <= FURNACE_TOLERANCES.geometry_max_relative,
            detail: format!(
                "pixels={} meanErr={} maxErr={} p99={}",
                geometry.pixels,
                percent(geometry.mean_relative_error),
                percent(geometry.max_abs_relative_error),
                percent(geometry.p99_abs_relative_error)
            ),
        });
        checks.push(FurnaceCheck {
            name: "furnace-geometry-no-chroma-drift",
            passed: geometry
                .channel_gain
                .iter()
                .all(|gain| (gain - 1.0).abs() <= FURNACE_TOLERANCES.channel_gain_drift),
            detail: format!(
                "gain=[{:.4}, {:.4}, {:.4}]",
                geometry.channel_gain[0], geometry.channel_gain[1], geometry.channel_gain[2]
            ),
        });
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOLERANCE_LABELS: [(&str, f64); 5] = [
        ("backgroundMeanRelative", 0.005),
        ("backgroundMaxRelative", 0.02),
        ("geometryMeanRelative", 0.02),
        ("geometryMaxRelative", 0.08),
        ("channelGainDrift", 0.02),
    ];

    #[test]
    fn tolerances_match_ts_authority() {
        // TS 权威字面量锁(whiteFurnace.ts FURNACE_TOLERANCES):任一端单独改容差
        // 即同时失败,防双端漂移。SSR toggle 容差(0.02)不移植:web SSR 合成链专属。
        let values = [
            FURNACE_TOLERANCES.background_mean_relative,
            FURNACE_TOLERANCES.background_max_relative,
            FURNACE_TOLERANCES.geometry_mean_relative,
            FURNACE_TOLERANCES.geometry_max_relative,
            FURNACE_TOLERANCES.channel_gain_drift,
        ];
        for ((label, expected), actual) in TOLERANCE_LABELS.iter().zip(values) {
            assert_eq!(*expected, actual, "furnace tolerance {label} drifted from TS authority");
        }
        assert_eq!(FURNACE_ENVIRONMENT_RADIANCE, 0.5, "furnace radiance drifted from TS authority");
    }

    #[test]
    fn fixed_split_constructively_conserves_furnace_energy() {
        // 修复式对任意 (f0, rough, nv) 构造性守恒:f64 恒等于 1;
        // 修复前同点全部欠冲(Schlick 储备 > 0 而 LUT 分数偏小)。
        let builtin = crate::ibl::builtin_default_environment();
        let lut = &builtin.brdf_lut;
        let sample_lut = |nv: f64, rough: f64| -> [f64; 2] {
            let x = ((nv * lut.width as f64) as usize).min(lut.width as usize - 1);
            let y = ((rough * lut.height as f64) as usize).min(lut.height as usize - 1);
            let texel = lut.texels[y * lut.width as usize + x];
            [f64::from(texel[0]), f64::from(texel[1])]
        };
        let mut before_worst = 0.0f64;
        let mut before_at_nv1 = 0.0f64;
        for rough in [0.06, 0.3, 0.7, 1.0] {
            for nv in [0.05, 0.2, 0.5, 0.8, 1.0] {
                for f0 in [0.04, 0.2, 0.5, 1.0] {
                    let dfg = sample_lut(nv, rough);
                    let after = fixed_split_total(f0, dfg);
                    assert!(
                        (after - 1.0).abs() < 1e-12,
                        "fixed split must conserve exactly at f0={f0} rough={rough} nv={nv}, got {after}"
                    );
                    let before = legacy_defect_total(f0, rough, nv, dfg);
                    let undershoot = 1.0 - before;
                    before_worst = before_worst.max(undershoot);
                    if (rough - 1.0).abs() < 1e-9 && (nv - 1.0).abs() < 1e-9 && f0 == 0.04 {
                        before_at_nv1 = undershoot;
                    }
                }
            }
        }
        // 白粗糙正入射(f0=0.04, rough→1, nv=1)欠冲量化:C12 口径 ≈ −2.65%
        // (web 真机实测 max −2.637%,native GPU 真机见白炉门 before 证据)。
        assert!(
            (0.02..=0.035).contains(&before_at_nv1),
            "legacy undershoot at (f0=0.04, rough=1, nv=1) expected ≈2.65%, got {before_at_nv1}"
        );
        // 宽网格(nv 低至 0.05)上缺陷更深(Schlick 储备随掠射角放大吞噬漫反射),
        // 只断言欠冲存在,不设上界——修复式已全点构造性守恒,缺陷模型仅存档。
        assert!(
            before_worst > 0.02,
            "legacy defect must undershoot somewhere on the grid, worst {before_worst}"
        );
        println!("C12 defect model grid: undershoot@nv=1 = {before_at_nv1:.6}, worst-on-grid = {before_worst:.6}");
    }

    #[test]
    fn defect_model_matches_ts_c12_prediction() {
        // TS 权威口径:predictedFurnaceOvershoot(0.04, 1, 1, dfg) ≈ −0.0265。
        let builtin = crate::ibl::builtin_default_environment();
        let lut = &builtin.brdf_lut;
        let texel = lut.texels[(lut.height as usize - 1) * lut.width as usize + (lut.width as usize - 1)];
        let dfg = [f64::from(texel[0]), f64::from(texel[1])];
        let overshoot = predicted_furnace_overshoot(0.04, 1.0, 1.0, dfg);
        assert!(
            (-0.04..=-0.015).contains(&overshoot),
            "C12 defect model at (f0=0.04, rough=1, nv=1) expected ≈ −0.0265, got {overshoot}"
        );
        let total = legacy_defect_total(0.04, 1.0, 1.0, dfg);
        assert!(
            (0.95..=0.99).contains(&total),
            "legacy white rough exitance expected ≈ 0.9735, got {total}"
        );
        println!("C12 defect model: dfg={dfg:?} total_before={total:.6} overshoot={overshoot:.6}");
    }

    #[test]
    fn cpu_reference_split_sum_is_furnace_exact_after_fix() {
        // 修复后的 CPU 参考 split_sum_ibl 在均匀白炉(irradiance=radiance=E)下
        // 对 nv/rough 网格逐点输出 ≡ E(f32 参考量级)。
        let environment = FURNACE_ENVIRONMENT_RADIANCE as f32;
        let builtin = crate::ibl::builtin_default_environment();
        let lut = &builtin.brdf_lut;
        let sample_lut = |nv: f32, rough: f32| -> [f32; 2] {
            let x = ((nv * lut.width as f32) as usize).min(lut.width as usize - 1);
            let y = ((rough * lut.height as f32) as usize).min(lut.height as usize - 1);
            let texel = lut.texels[y * lut.width as usize + x];
            [texel[0], texel[1]]
        };
        let mut worst = 0.0f64;
        for rough in [0.06f32, 0.5, 1.0] {
            for nv in [0.05f32, 0.3, 0.7, 1.0] {
                let dfg = sample_lut(nv, rough);
                let total = crate::ibl::split_sum_ibl(crate::ibl::SplitSumIblInput {
                    base: [1.0, 1.0, 1.0],
                    metallic: 0.0,
                    roughness: rough,
                    occlusion: 1.0,
                    n_dot_v: nv,
                    irradiance: [environment; 3],
                    radiance: [environment; 3],
                    dfg,
                });
                for channel in total {
                    let error = (f64::from(channel) - FURNACE_ENVIRONMENT_RADIANCE).abs()
                        / FURNACE_ENVIRONMENT_RADIANCE;
                    worst = worst.max(error);
                }
            }
        }
        assert!(
            worst < 1e-5,
            "fixed CPU reference must reproduce E in the uniform furnace, worst relative error {worst}"
        );
        println!("CPU reference furnace worst relative error after fix: {worst:.3e}");
    }

    #[test]
    fn uniform_furnace_environment_is_exact_and_validated() {
        let builtin = crate::ibl::builtin_default_environment();
        let furnace = uniform_furnace_environment(&builtin, FURNACE_ENVIRONMENT_RADIANCE);
        assert_eq!(furnace.specular.mips.len(), builtin.specular.mips.len());
        for (furnace_mip, builtin_mip) in furnace.specular.mips.iter().zip(&builtin.specular.mips) {
            assert_eq!(furnace_mip.size, builtin_mip.size);
            assert!(furnace_mip
                .texels
                .iter()
                .all(|t| (f64::from(t[0]) - FURNACE_ENVIRONMENT_RADIANCE).abs() < 1e-6));
        }
        assert!(furnace.diffuse.mips.iter().all(|mip| mip
            .texels
            .iter()
            .all(|t| (f64::from(t[0]) - FURNACE_ENVIRONMENT_RADIANCE).abs() < 1e-6)));
        assert_eq!(furnace.brdf_lut.texels.len(), builtin.brdf_lut.texels.len());
    }

    #[test]
    fn furnace_checks_fail_closed_and_cover_chroma() {
        // 全空帧 fail-closed;构造色偏帧验证 channelGain 判据会拦截。
        let empty = evaluate_furnace_checks(None, None);
        assert_eq!(empty.len(), 1);
        assert_eq!(empty[0].name, "furnace-frame-nonempty");
        assert!(!empty[0].passed, "empty frame must fail closed");

        let environment = FURNACE_ENVIRONMENT_RADIANCE;
        let conserved = vec![[environment as f32; 3]; 16];
        let stats = region_stats(&conserved, None, environment, FurnaceRegion::Geometry).unwrap();
        assert_eq!(stats.mean_relative_error, 0.0);
        assert_eq!(stats.max_abs_relative_error, 0.0);
        for gain in stats.channel_gain {
            assert!((gain - 1.0).abs() < 1e-9);
        }
        let checks = evaluate_furnace_checks(None, Some(stats));
        assert!(checks.iter().all(|check| check.passed), "{checks:?}");

        let mut chroma_shifted = conserved.clone();
        for pixel in &mut chroma_shifted {
            pixel[0] = (environment * 1.5) as f32;
        }
        let drifted = region_stats(&chroma_shifted, None, environment, FurnaceRegion::Geometry).unwrap();
        let chroma_checks = evaluate_furnace_checks(None, Some(drifted));
        let chroma = chroma_checks
            .iter()
            .find(|check| check.name == "furnace-geometry-no-chroma-drift")
            .expect("chroma check must exist");
        assert!(!chroma.passed, "red channel energy leak must be caught: {chroma:?}");
    }

    #[test]
    fn sphere_segmentation_partitions_frame() {
        let segmentation = furnace_sphere_segmentation(256, 256, 4.0, 1.2, 2.0 * (1.0f64 / 2.05).atan());
        let geometry = segmentation.iter().filter(|r| **r == 0).count();
        let background = segmentation.iter().filter(|r| **r == 1).count();
        let excluded = segmentation.iter().filter(|r| **r == SEGMENT_EXCLUDED).count();
        assert!(geometry > 1000, "sphere disc must cover a real region, got {geometry}");
        assert!(background > 1000, "background must cover the rest, got {background}");
        assert!(excluded > 0, "guard ring must exist");
        assert_eq!(geometry + background + excluded, 256 * 256);
    }

    #[test]
    fn native_mesh_ibl_split_keeps_ts_authoritative_formula() {
        // J2-B3 双侧锁(Rust 半):native 的 IBL 能量分配必须保持 TS C12 修复式
        // ——同一 split-sum 分数进 diffuse 与 specular 两路。
        // (TS 半的权威证据是 C12 真机白炉全绿 + 本测试与 pbrShader.ts 修复式逐字
        // 同构;webgpu/** 为只读基线,TS 半不再另行加锁。)
        // I-C23 起:光照响应体抽为 native_mesh_v1.wgsl 的 native_lit_response
        // 共享函数,RT fragment 变体经函数共享(同步契约从文本重复升级为单源),
        // 因此修复式只允许在本体出现恰一次,且 RT 必须消费该函数而非自带副本。
        let mesh = include_str!("../assets/shaders/native_mesh_v1.wgsl");
        let rt = include_str!("../assets/shaders/native_mesh_rt_fragment_v1.wgsl");
        for (label, source, expected) in [
            ("native_mesh_v1", mesh, 1),
            ("native_mesh_rt_fragment_v1", rt, 0),
        ] {
            assert_eq!(
                source.matches("let specular_fraction = clamp(f0 * dfg.x + dfg.y, vec3f(0.0), vec3f(1.0)) * energy_compensation;").count(),
                expected,
                "{label}: IBL split-sum fraction must stay on the TS C12 fixed formula (shared via native_lit_response)"
            );
            assert_eq!(
                source.matches("(1.0 - specular_fraction)").count(),
                expected,
                "{label}: diffuse reserve must be (1 - specular_fraction)"
            );
            assert_eq!(
                source.matches("radiance * specular_fraction").count(),
                expected,
                "{label}: specular must consume the same specular_fraction"
            );
            assert!(
                !source.contains("let f = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);"),
                "{label}: specular Schlick must not return as the diffuse reserve (C12 defect)"
            );
        }
        // RT 变体必须经共享响应核(rt_shade_surface 被 plain/layered 两入口
        // 复用,故恰一次调用),不允许光照体文本副本。
        assert_eq!(rt.matches("native_lit_response(").count(), 1,
            "RT fragment must consume the shared native_lit_response");
    }
}
