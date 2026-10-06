//! native MegaLights IES 因子注入(2026-10-06 后继切片 1):E02 IES 打包载荷的
//! CPU 评测端——TS 权威 `packages/deep-engine/src/lighting/iesShading.ts`
//! `evaluateIesShadingFactor` 逐式同构(与 WGSL 单源 `deepSpotIesFactor` 同式同序;
//! 消费同一份 packIesShading 字节 = GPU binding 8 同源)。
//!
//! 采样次序合同(TS 同序,round 输入全为非负 → JS ties-up 与 Rust ties-away 一致;
//! 0.5° 网格量化吸收两端 acos/atan2 的跨 libm ULP 差异):
//!   θ = acos(clamp(dot(-s, l))) → 0.5° 网格;
//!   φ = atan2(dot(-s, pole), dot(-s, right)) − rotationDeg → floor 模 360 → 0.5° 网格;
//!   φ 按对称系数折叠(symmetry 2 镜像半周 / 4 周期 180+镜像)→
//!   行 = round(gHalf/rowHalfStep) 夹紧(对称 1 → 行 0);列 = θ 半度数直取;
//!   factor = 展开表值(f32 存储) × scaleFactor(f32)——f64 乘积双端精确。
//! 展开表已内化「垂直角最近邻 + 角域外为 0」(packIesShading 展开),无间接寻址。
//! 退化输入 fail-safe(profileIndex < 0 / right 模长 0 → 恒等 1.0;越界词 → 0.0),
//! 与 TS 同款,热路径不 panic。

/// 展开表的列数:θ ∈ [0,180] 按 0.5° 网格 → 361 列(TS IES_EXPANDED_COLUMNS 同值)。
pub const IES_EXPANDED_COLUMNS: usize = 361;
/// 每行占用的 vec4 数:ceil(361/4),尾部 3 个分量填 0(TS IES_TABLE_ROW_STRIDE_VEC4)。
pub const IES_TABLE_ROW_STRIDE_VEC4: usize = 91;

/// E02 打包载荷视图(vec4 字流;spot 参数节 + profile 元数据节 + 展开表)。
/// 布局: [0, max(spotCount,1)) 每灯参数 (profileIndex|-1, rotationHalfDeg,
/// scaleFactor, metaBase);[其后] 每 profile 元数据 (tableBase, rowCount,
/// rowHalfStep, symmetry);[之后] 展开的归一化光度表。
#[derive(Debug, Clone, Copy)]
pub struct MegaLightsIesPacking<'a> {
    pub words: &'a [f32],
    pub spot_count: usize,
}

impl<'a> MegaLightsIesPacking<'a> {
    pub fn new(words: &'a [f32], spot_count: usize) -> Self {
        Self { words, spot_count }
    }
}

#[inline]
fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[inline]
fn hypot3(value: [f64; 3]) -> f64 {
    f64::hypot(f64::hypot(value[0], value[1]), value[2])
}

/// IES 角度衰减因子(TS evaluateIesShadingFactor 逐式;因子乘在 cone 侧——
/// 目标权重与胜者着色同变,与 WGSL deepMegaContribution 的
/// `radiance × attenuation × cone × ies` 同位)。
///
/// `light_direction` 必须是打包口径的单位向量(打包时归一);`surface_to_light`
/// 为表面指向灯的单位向量(evaluateMegaLight 链同域)。
pub fn evaluate_ies_shading_factor(
    packing: &MegaLightsIesPacking<'_>,
    spot_index: usize,
    light_direction: [f64; 3],
    surface_to_light: [f64; 3],
) -> f64 {
    const DEG_PER_RAD: f64 = 180.0 / std::f64::consts::PI;
    if spot_index >= packing.spot_count {
        return 1.0;
    }
    let base = spot_index * 4;
    let Some(profile_index) = packing.words.get(base).copied() else {
        return 1.0;
    };
    if profile_index < 0.0 {
        return 1.0;
    }
    let Some(meta_base) = packing.words.get(base + 3).copied().map(f64::from) else {
        return 1.0;
    };
    let meta = meta_base * 4.0;
    let Some(table_base) = packing.words.get(meta as usize).copied().map(f64::from) else {
        return 0.0;
    };
    let Some(row_count) = packing.words.get(meta as usize + 1).copied().map(f64::from) else {
        return 0.0;
    };
    let Some(row_half_step) = packing.words.get(meta as usize + 2).copied().map(f64::from) else {
        return 0.0;
    };
    let Some(symmetry) = packing.words.get(meta as usize + 3).copied().map(f64::from) else {
        return 0.0;
    };
    let to_surface = [
        -surface_to_light[0],
        -surface_to_light[1],
        -surface_to_light[2],
    ];
    let cos_theta = dot3(to_surface, light_direction).clamp(-1.0, 1.0);
    let theta_half = (f64::acos(cos_theta) * DEG_PER_RAD * 2.0)
        .round()
        .clamp(0.0, 360.0);
    // right = normalize(cross(up, light)):up = (0,1,0),光轴近 ±Y 时取 (1,0,0)。
    let up: [f64; 3] = if light_direction[1].abs() > 0.999 {
        [1.0, 0.0, 0.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let raw_right = cross3(up, light_direction);
    let right_length = hypot3(raw_right);
    if right_length <= 0.0 || right_length.is_nan() {
        return 1.0; // 非单位向量等退化输入:fail-safe 恒等(TS `!(rightLength > 0)` 同语义)。
    }
    let right = [
        raw_right[0] / right_length,
        raw_right[1] / right_length,
        raw_right[2] / right_length,
    ];
    let pole = cross3(light_direction, right);
    let azimuth_x = dot3(to_surface, right);
    let azimuth_y = dot3(to_surface, pole);
    let rotation_half_deg = f64::from(packing.words[base + 1]);
    let mut phi = f64::atan2(azimuth_y, azimuth_x) * DEG_PER_RAD - rotation_half_deg * 0.5;
    phi -= (phi / 360.0).floor() * 360.0;
    let mut phi_half = (phi * 2.0).round();
    if phi_half >= 720.0 {
        phi_half = 0.0;
    }
    let mut g_half = phi_half;
    if symmetry == 2.0 && g_half > 360.0 {
        g_half = 720.0 - g_half;
    }
    if symmetry == 4.0 {
        g_half %= 360.0;
        if g_half > 180.0 {
            g_half = 360.0 - g_half;
        }
    }
    let row = if symmetry == 1.0 {
        0.0
    } else {
        // TS Math.min(Math.max(round(gHalf/rowHalfStep), 0), rowCount−1) 同式
        // (比较链,不用 clamp:退化行距 0/0 的 NaN 按取不到行 fail-safe → 值 0,
        // 与 TS undefined→0 同义;f64::clamp 对 min>max 会 panic,热路径禁异常)。
        let rounded = (g_half / row_half_step).round();
        if rounded.is_nan() {
            return 0.0;
        }
        if rounded < 0.0 {
            0.0
        } else if rounded > row_count - 1.0 {
            row_count - 1.0
        } else {
            rounded
        }
    };
    let word_index =
        (table_base as usize + row as usize * IES_TABLE_ROW_STRIDE_VEC4) * 4 + theta_half as usize;
    let value = f64::from(packing.words.get(word_index).copied().unwrap_or(0.0));
    value * f64::from(packing.words[base + 2])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小打包:1 spot 参数行 + 1 profile 元数据 + 2 行展开表(91 vec4/行)。
    /// profile symmetry=2、rowCount=2、rowHalfStep=180(半度);展开表值手写。
    fn mini_packing() -> MegaLightsIesPacking<'static> {
        let mut words = vec![0.0f32; 2 * 4 + 2 * 91 * 4];
        // spot 参数行 0:(profile 0, rotation 0, scale 0.5, metaBase 1)。
        words[0] = 0.0;
        words[1] = 0.0;
        words[2] = 0.5;
        words[3] = 1.0;
        // profile 元数据(tableBase=2, rowCount=2, rowHalfStep=180, symmetry=2)。
        words[4] = 2.0;
        words[5] = 2.0;
        words[6] = 180.0;
        words[7] = 2.0;
        // 展开表:word 索引 (tableBase + row*91)*4 + thetaHalf;row0 θ=0 → 1.0,
        // θ=90(半度 180)→ 0.25;row1 θ=0 → 0.5、θ=45(半度 90)→ 0.4。其余零。
        let row0 = 2 * 4; // tableBase(vec4 单位)× 4 = 词偏移。
        let row1 = (2 + IES_TABLE_ROW_STRIDE_VEC4) * 4;
        words[row0] = 1.0;
        words[row0 + 180] = 0.25;
        words[row1] = 0.5;
        words[row1 + 90] = 0.4;
        MegaLightsIesPacking::new(Box::leak(words.into_boxed_slice()), 1)
    }

    #[test]
    fn identity_branches_return_one() {
        let words: Vec<f32> = vec![-1.0, 0.0, 0.0, 0.0];
        let packing = MegaLightsIesPacking::new(&words, 1);
        // profileIndex < 0 → 恒等(无 IES 灯占位行)。
        assert_eq!(
            evaluate_ies_shading_factor(&packing, 0, [0.0, -1.0, 0.0], [0.0, 1.0, 0.0]),
            1.0
        );
        // 越界 spot 行 → 恒等。
        assert_eq!(
            evaluate_ies_shading_factor(&packing, 3, [0.0, -1.0, 0.0], [0.0, 1.0, 0.0]),
            1.0
        );
    }

    #[test]
    fn theta_quantization_reads_expanded_table() {
        let packing = mini_packing();
        let down = [0.0, -1.0, 0.0];
        // θ=0(正对灯轴)→ row0 col0 = 1.0 × scale 0.5。
        let factor = evaluate_ies_shading_factor(&packing, 0, down, [0.0, 1.0, 0.0]);
        assert!((factor - 0.5).abs() < 1e-12, "factor {factor}");
        // θ=90° 且 φ=0(toSurface = -[0,0,1] 落在 +right 反向?—— surfaceToLight=[0,0,1]
        // → toSurface=[0,0,-1] = +right 方向 → φ=0)→ row0 col180 = 0.25 × 0.5。
        let factor = evaluate_ies_shading_factor(&packing, 0, down, [0.0, 0.0, 1.0]);
        assert!((factor - 0.125).abs() < 1e-12, "factor {factor}");
    }

    #[test]
    fn out_of_domain_returns_zero_and_azimuth_folds() {
        let packing = mini_packing();
        // 表面在灯上方:θ=180 → 角域外,展开表该列全零 → 0。
        let factor = evaluate_ies_shading_factor(&packing, 0, [0.0, -1.0, 0.0], [0.0, -1.0, 0.0]);
        assert_eq!(factor, 0.0);
        // 镜像半周:rowHalfStep=180(半度),gHalf>360 折回——φ=270° 与 φ=90° 同行。
        // 两侧向量都取 θ=45°(col 90):φ=90 直取 row1;φ=270 折回 row1 → 同值(0.4 × 0.5)。
        let c = std::f64::consts::FRAC_1_SQRT_2;
        let factor_east = evaluate_ies_shading_factor(&packing, 0, [0.0, -1.0, 0.0], [-c, c, 0.0]);
        let factor_west = evaluate_ies_shading_factor(&packing, 0, [0.0, -1.0, 0.0], [c, c, 0.0]);
        assert!(factor_east == factor_west, "{factor_east} vs {factor_west}");
        assert!(
            (factor_east - 0.2).abs() < 1e-6,
            "row1 θ=45 = 0.4f32 × scale 0.5, got {factor_east}"
        );
    }

    #[test]
    fn degenerate_light_direction_is_fail_safe_identity() {
        let packing = mini_packing();
        // 零方向:right 模长 0 → 恒等 1.0(不 panic)。
        assert_eq!(
            evaluate_ies_shading_factor(&packing, 0, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            1.0
        );
    }
}
