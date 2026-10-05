//! Native 自动曝光(F8,Z1 默认画质审计提案 P2)——TS `pbrAutoExposure.ts`
//! 的逐式移植仲裁实现(CPU 域,零 GPU readback)。
//!
//! 语义:环境亮度静态代理(等距柱全景按纬度立体角加权 / 预滤波 IBL 最粗
//! specular mip 按立体角加权)→ `0.6·middleGrey / L` 曝光目标 → ±EV 包络
//! (缺省 ±2,对标 UE5/HDRP 眼适应)→ EV 空间指数平滑(时间常数 τ)+ 帧间
//! 变化率硬顶(防闪烁)。亮度估计失败 fail-closed:advance 返回 None,调用方
//! 沿用既有曝光,遥测显式 fallbackReason,不伪零。
//!
//! 登记口径(J4):native auto-exposure = supported/harness-only——数学与
//! 状态机经 TS 真实输出 golden 对拍;生产渲染路径的消费接线(scene exposure
//! 注入,web 端为 view.exposure)属后继切片,不在本模块内。

/// 缺省配置(与 TS `DEFAULT_PBR_AUTO_EXPOSURE` 逐词一致)。
pub const DEFAULT_ADAPTATION_TIME_CONSTANT_SECONDS: f64 = 0.35;
pub const DEFAULT_MAX_EV_PER_SECOND: f64 = 4.0;
pub const DEFAULT_EV_ENVELOPE: f64 = 2.0;
pub const DEFAULT_MIDDLE_GREY: f64 = 0.18;
pub const DEFAULT_SCENE_EXPOSURE_BIAS: f64 = 1.0;
/// EV 包络半宽硬顶(TS `MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE`)。
pub const MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE: f64 = 8.0;

const MAX_LATITUDE_SAMPLES: f64 = 64.0;
const MAX_AZIMUTH_SAMPLES: f64 = 128.0;
const MAX_MIP_SAMPLES_PER_FACE: f64 = 32.0;
const MIN_SAMPLED_SECONDS: f64 = 0.0;
const MAX_SAMPLED_SECONDS: f64 = 0.25;
const LUMA: [f64; 3] = [0.2126, 0.7152, 0.0722];

/// 解析后的配置(与 TS `ResolvedPbrAutoExposureOptions` 同形)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoExposureConfig {
    pub adaptation_time_constant_seconds: f64,
    pub max_ev_per_second: f64,
    pub ev_envelope: f64,
    pub middle_grey: f64,
    pub scene_exposure_bias: f64,
}

impl Default for AutoExposureConfig {
    fn default() -> Self {
        Self {
            adaptation_time_constant_seconds: DEFAULT_ADAPTATION_TIME_CONSTANT_SECONDS,
            max_ev_per_second: DEFAULT_MAX_EV_PER_SECOND,
            ev_envelope: DEFAULT_EV_ENVELOPE,
            middle_grey: DEFAULT_MIDDLE_GREY,
            scene_exposure_bias: DEFAULT_SCENE_EXPOSURE_BIAS,
        }
    }
}

/// 非法配置 fail-closed 回缺省(与 TS `resolvePbrAutoExposureOptions`/
/// `finitePositive` 同式:正值且 ≤ 天花板才采纳,否则缺省),不抛——
/// 渲染循环必须存活。
#[must_use]
pub fn resolve_auto_exposure_config(
    adaptation_time_constant_seconds: Option<f64>,
    max_ev_per_second: Option<f64>,
    ev_envelope: Option<f64>,
    middle_grey: Option<f64>,
    scene_exposure_bias: Option<f64>,
) -> AutoExposureConfig {
    let defaults = AutoExposureConfig::default();
    let finite_positive = |value: Option<f64>, fallback: f64, ceiling: f64| {
        match value {
            Some(value) if value.is_finite() && value > 0.0 && value <= ceiling => value,
            _ => fallback,
        }
    };
    AutoExposureConfig {
        adaptation_time_constant_seconds: finite_positive(
            adaptation_time_constant_seconds,
            defaults.adaptation_time_constant_seconds,
            f64::INFINITY,
        ),
        max_ev_per_second: finite_positive(
            max_ev_per_second,
            defaults.max_ev_per_second,
            f64::INFINITY,
        ),
        ev_envelope: finite_positive(
            ev_envelope,
            defaults.ev_envelope,
            MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE,
        ),
        middle_grey: finite_positive(middle_grey, defaults.middle_grey, f64::INFINITY),
        scene_exposure_bias: finite_positive(
            scene_exposure_bias,
            defaults.scene_exposure_bias,
            f64::INFINITY,
        ),
    }
}

/// 亮度 → 曝光目标:ACES 拟合前有 /0.6 归一化,middle grey 0.18 对应
/// exposure = 0.6·middleGrey / L;叠加场景偏置(EV 域)后夹进 ±EV 包络。
#[must_use]
pub fn target_exposure_from_luminance(luminance: f64, config: &AutoExposureConfig) -> f64 {
    let physical_exposure = config.middle_grey * 0.6 / luminance.max(1e-6);
    let ev = physical_exposure.log2() + config.scene_exposure_bias.log2();
    (ev.clamp(-config.ev_envelope, config.ev_envelope)).exp2()
}

/// 环境亮度估计来源标签(与 TS `PbrAutoExposureProvenance` 同词)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoExposureProvenance {
    PrefilteredIblMip,
    RadianceHdr,
}

impl AutoExposureProvenance {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PrefilteredIblMip => "prefiltered-ibl-mip",
            Self::RadianceHdr => "radiance-hdr",
        }
    }
}

/// 亮度估计结果(fail-closed:不可估计时带记录式原因)。
#[derive(Debug, Clone, PartialEq)]
pub enum LuminanceEstimateOutcome {
    Estimated { luminance: f64, provenance: AutoExposureProvenance },
    Unavailable { reason: String },
}

/// 等距柱状全景(RadianceHdrImage 同形:线性 RGB 行主序)。
pub struct EquirectLuminanceInput<'a> {
    pub width: u32,
    pub height: u32,
    /// 线性 RGB,length ≥ width*height*3。
    pub data: &'a [f64],
}

/// 预滤波 IBL 最粗 specular mip(rgba16float 字节,面主序 size×size×6×4 通道)。
pub struct PrefilteredMipLuminanceInput<'a> {
    pub size: u32,
    pub rgba16float_bytes: &'a [u8],
}

fn luminance_outcome(
    sum: f64,
    weight: f64,
    provenance: AutoExposureProvenance,
) -> LuminanceEstimateOutcome {
    if !(weight > 0.0) {
        return LuminanceEstimateOutcome::Unavailable {
            reason: format!("{}:no-samples", provenance.as_str()),
        };
    }
    let luminance = sum / weight;
    if !luminance.is_finite() || luminance <= 0.0 {
        return LuminanceEstimateOutcome::Unavailable {
            reason: format!("{}:luminance-not-positive", provenance.as_str()),
        };
    }
    LuminanceEstimateOutcome::Estimated { luminance, provenance }
}

/// 等距柱全景:纬度立体角 ∝ sin(纬度),按行加权;抽样上限约 64×128。
#[must_use]
pub fn estimate_luminance_from_equirect(
    image: &EquirectLuminanceInput<'_>,
) -> LuminanceEstimateOutcome {
    let width = image.width;
    let height = image.height;
    if image.data.len() < width as usize * height as usize * 3 || width < 1 || height < 1 {
        return LuminanceEstimateOutcome::Unavailable {
            reason: "radiance-hdr:image-shape-invalid".to_string(),
        };
    }
    let step_x = ((width as f64) / MAX_AZIMUTH_SAMPLES).floor().max(1.0) as u32;
    let step_y = ((height as f64) / MAX_LATITUDE_SAMPLES).floor().max(1.0) as u32;
    let mut weight = 0.0f64;
    let mut sum = 0.0f64;
    let mut y = step_y >> 1;
    while y < height {
        let latitude_weight = (std::f64::consts::PI * (f64::from(y) + 0.5) / f64::from(height)).sin();
        let mut x = step_x >> 1;
        while x < width {
            let offset = (y as usize * width as usize + x as usize) * 3;
            let texel = [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
            if !texel.iter().all(|value| value.is_finite()) || texel.iter().any(|value| *value < 0.0) {
                return LuminanceEstimateOutcome::Unavailable {
                    reason: "environment-texel-invalid".to_string(),
                };
            }
            sum += latitude_weight
                * (LUMA[0] * texel[0] + LUMA[1] * texel[1] + LUMA[2] * texel[2]);
            weight += latitude_weight;
            x += step_x;
        }
        y += step_y;
    }
    luminance_outcome(sum, weight, AutoExposureProvenance::RadianceHdr)
}

/// 预滤波 IBL:最粗 specular mip(≈全环境平均辐射,静态代理),六面逐纹素按
/// 立体角 1/(1+s²+t²)^{3/2} 加权(权重归一,面基向量方向不影响)。
#[must_use]
pub fn estimate_luminance_from_prefiltered_mip(
    mip: &PrefilteredMipLuminanceInput<'_>,
) -> LuminanceEstimateOutcome {
    let size = mip.size;
    let expected = size as usize * size as usize * 6 * 8;
    if size < 1 || mip.rgba16float_bytes.len() < expected {
        return LuminanceEstimateOutcome::Unavailable {
            reason: "prefiltered-ibl:mip-size-invalid".to_string(),
        };
    }
    let words: Vec<u16> = mip
        .rgba16float_bytes[..expected]
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    let stride = ((f64::from(size) / MAX_MIP_SAMPLES_PER_FACE).ceil() as u32).max(1);
    let mut weight = 0.0f64;
    let mut sum = 0.0f64;
    for face in 0..6usize {
        let mut y = stride >> 1;
        while y < size {
            let mut x = stride >> 1;
            while x < size {
                let s = 2.0 * (f64::from(x) + 0.5) / f64::from(size) - 1.0;
                let t = 2.0 * (f64::from(y) + 0.5) / f64::from(size) - 1.0;
                let texel_weight = 1.0 / (1.0 + s * s + t * t).powf(1.5);
                let word = (face * size as usize * size as usize
                    + y as usize * size as usize
                    + x as usize)
                    * 4;
                let texel = [
                    f64::from(crate::half_decode::half_to_f32(words[word])),
                    f64::from(crate::half_decode::half_to_f32(words[word + 1])),
                    f64::from(crate::half_decode::half_to_f32(words[word + 2])),
                ];
                if !texel.iter().all(|value| value.is_finite())
                    || texel.iter().any(|value| *value < 0.0)
                {
                    return LuminanceEstimateOutcome::Unavailable {
                        reason: "environment-texel-invalid".to_string(),
                    };
                }
                sum += texel_weight
                    * (LUMA[0] * texel[0] + LUMA[1] * texel[1] + LUMA[2] * texel[2]);
                weight += texel_weight;
                x += stride;
            }
            y += stride;
        }
    }
    luminance_outcome(sum, weight, AutoExposureProvenance::PrefilteredIblMip)
}

/// 单帧结果(与 TS `PbrAutoExposureFrameResult` 同形)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AutoExposureFrameResult {
    pub exposure: f64,
    pub luminance: f64,
    pub target_exposure: f64,
    pub provenance: AutoExposureProvenance,
}

/// 逐渲染器实例的曝光状态(与 TS `PbrAutoExposureRuntime` 同构):
/// EV 空间指数平滑 + 帧间收敛硬顶;首帧/相机切换直取目标。
#[derive(Debug)]
pub struct PbrAutoExposureRuntime {
    config: AutoExposureConfig,
    luminance: Option<(f64, AutoExposureProvenance)>,
    fallback_reason: String,
    current_ev: f64,
    seeded: bool,
    last_now_ms: Option<f64>,
}

impl PbrAutoExposureRuntime {
    #[must_use]
    pub fn new(config: AutoExposureConfig) -> Self {
        Self {
            config,
            luminance: None,
            fallback_reason: "no-environment-source".to_string(),
            current_ev: 0.0,
            seeded: false,
            last_now_ms: None,
        }
    }

    /// 环境每次 stage 时观察新源;估计失败即落回 fail-closed 原因,不抛。
    pub fn observe_estimate(&mut self, outcome: LuminanceEstimateOutcome) {
        match outcome {
            LuminanceEstimateOutcome::Estimated { luminance, provenance } => {
                self.luminance = Some((luminance, provenance));
            }
            LuminanceEstimateOutcome::Unavailable { reason } => {
                self.luminance = None;
                self.fallback_reason = reason;
                self.seeded = false;
            }
        }
    }

    fn clamp_seconds(seconds: f64) -> f64 {
        if seconds.is_finite() {
            seconds.clamp(MIN_SAMPLED_SECONDS, MAX_SAMPLED_SECONDS)
        } else {
            0.0
        }
    }

    /// 每个实际渲染帧调用一次;返回 None 表示本帧沿用调用方曝光(fail-closed)。
    pub fn advance(&mut self, now_ms: f64, snap: bool) -> Option<AutoExposureFrameResult> {
        let (luminance, provenance) = *self.luminance.as_ref()?;
        let target = target_exposure_from_luminance(luminance, &self.config);
        let target_ev = target.log2();
        if !self.seeded || snap {
            self.current_ev = target_ev;
            self.seeded = true;
        } else {
            let delta_seconds = Self::clamp_seconds(
                (now_ms - self.last_now_ms.unwrap_or(f64::NAN)) / 1000.0,
            );
            let alpha =
                1.0 - (-delta_seconds / self.config.adaptation_time_constant_seconds).exp();
            let max_step = self.config.max_ev_per_second * delta_seconds;
            let smooth_step = (target_ev - self.current_ev) * alpha;
            self.current_ev += smooth_step.clamp(-max_step, max_step);
        }
        self.last_now_ms = Some(now_ms);
        Some(AutoExposureFrameResult {
            exposure: self.current_ev.exp2(),
            luminance,
            target_exposure: target,
            provenance,
        })
    }

    /// 当前 fail-closed 原因(遥测:降级帧显式给原因,不伪零)。
    #[must_use]
    pub fn fallback_reason(&self) -> &str {
        &self.fallback_reason
    }

    /// EV 包络(遥测:与 TS metrics().evEnvelope 同形)。
    #[must_use]
    pub fn ev_envelope(&self) -> (f64, f64) {
        (
            (-self.config.ev_envelope).exp2(),
            self.config.ev_envelope.exp2(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 亮度→曝光目标族:TS 真实输出 golden(f64,f64 运算 1 ulp 容差)。
    #[test]
    fn target_exposure_matches_ts_reference() {
        let config = AutoExposureConfig::default();
        let cases: &[(f64, f64)] = &[
            (0.18, 0.6),
            (1.0, 0.25),
            (1e-7, 4.0),
            (100.0, 0.25),
        ];
        for (luminance, expected) in cases {
            let actual = target_exposure_from_luminance(*luminance, &config);
            assert!(
                (actual - expected).abs() <= 1e-9 * (1.0 + expected.abs()),
                "t({luminance}) = {actual} vs ts {expected}"
            );
        }
        // 配置变体:包络收窄 / 场景偏置。
        let narrow = resolve_auto_exposure_config(None, None, Some(1.0), None, None);
        assert!(
            (target_exposure_from_luminance(0.18, &narrow) - 0.6).abs() <= 1e-9,
            "env1 keeps 0.6"
        );
        let biased = resolve_auto_exposure_config(None, None, None, None, Some(2.0));
        assert!(
            (target_exposure_from_luminance(0.18, &biased) - 1.2).abs() <= 1e-9,
            "bias2 doubles to 1.2"
        );
    }

    /// 非法配置 fail-closed 回缺省(非正/NaN);包络超天花板(>8)与 TS 同式
    /// 回缺省 2(不是夹取);中灰无天花板。
    #[test]
    fn invalid_config_falls_closed_to_defaults() {
        let resolved = resolve_auto_exposure_config(
            Some(-1.0),
            Some(0.0),
            Some(f64::NAN),
            Some(-0.5),
            Some(f64::INFINITY),
        );
        assert_eq!(resolved, AutoExposureConfig::default());
        // 包络 ≤8 采纳、>8 回缺省(TS finitePositive 同式);中灰无天花板。
        let edge = resolve_auto_exposure_config(None, None, Some(8.0), Some(9.0), None);
        assert_eq!(edge.ev_envelope, 8.0);
        assert_eq!(edge.middle_grey, 9.0);
        let over = resolve_auto_exposure_config(None, None, Some(100.0), None, None);
        assert_eq!(over.ev_envelope, 2.0);
    }

    /// 状态机全序列 vs TS 真实输出(f64 1e-9 容差):
    /// 首帧直取 → 亮度跳变后指数平滑 + 率硬顶 → 无效源 fail-closed →
    /// snap 直取 → NaN 时间增量钳 0。
    #[test]
    fn runtime_sequence_matches_ts_reference() {
        let mut rt = PbrAutoExposureRuntime::new(AutoExposureConfig::default());
        rt.observe_estimate(estimate_luminance_from_equirect(&EquirectLuminanceInput {
            width: 1,
            height: 1,
            data: &[0.18, 0.18, 0.18],
        }));
        let first = rt.advance(0.0, false).expect("first frame seeds");
        assert!((first.exposure - 0.6).abs() <= 1e-9);
        assert_eq!(first.provenance, AutoExposureProvenance::RadianceHdr);

        rt.observe_estimate(estimate_luminance_from_equirect(&EquirectLuminanceInput {
            width: 1,
            height: 1,
            data: &[1.0, 1.0, 1.0],
        }));
        let ts_sequence: [(f64, f64); 3] = [
            (100.0, 0.4826809106131664),
            (200.0, 0.40987571479492907),
            (1200.0, 0.31845682786898266),
        ];
        for (now, expected) in ts_sequence {
            let frame = rt.advance(now, false).expect("advancing frame");
            assert!(
                (frame.exposure - expected).abs() <= 1e-9,
                "advance({now}) = {} vs ts {expected}",
                frame.exposure
            );
            assert!((frame.target_exposure - 0.25).abs() <= 1e-9);
        }

        // 无效源:fail-closed 沿用调用方曝光,不伪零。
        rt.observe_estimate(LuminanceEstimateOutcome::Unavailable {
            reason: "radiance-hdr:luminance-not-positive".to_string(),
        });
        assert!(rt.advance(1300.0, false).is_none());
        assert_eq!(rt.fallback_reason(), "radiance-hdr:luminance-not-positive");

        // snap 直取(相机切换语义):0.001 → EV +2 包络顶 = 4。
        rt.observe_estimate(estimate_luminance_from_equirect(&EquirectLuminanceInput {
            width: 1,
            height: 1,
            data: &[0.001, 0.001, 0.001],
        }));
        let snapped = rt.advance(1300.0, true).expect("snap frame");
        assert!((snapped.exposure - 4.0).abs() <= 1e-9);

        // NaN 时间增量钳 0:不移动,也不 panic。
        rt.observe_estimate(estimate_luminance_from_equirect(&EquirectLuminanceInput {
            width: 1,
            height: 1,
            data: &[0.5, 0.5, 0.5],
        }));
        let stalled = rt.advance(f64::NAN, false).expect("nan-dt frame");
        assert!((stalled.exposure - 4.0).abs() <= 1e-9);
        assert!((stalled.target_exposure - 0.25).abs() <= 1e-9);
        assert_eq!(rt.ev_envelope(), (0.25, 4.0));
    }

    /// 估计器:均匀场按行/立体角加权仍是均匀值;形状非法/负纹素 fail-closed。
    #[test]
    fn estimators_weight_constant_fields_to_constant() {
        // 2×2 常量 0.18(TS 同输入 luminance=0.18)。
        let outcome = estimate_luminance_from_equirect(&EquirectLuminanceInput {
            width: 2,
            height: 2,
            data: &[0.18; 12],
        });
        match outcome {
            LuminanceEstimateOutcome::Estimated { luminance, .. } => {
                assert!((luminance - 0.18).abs() <= 1e-12, "{luminance}");
            }
            other => panic!("expected estimated, got {other:?}"),
        }
        // 形状非法。
        assert!(matches!(
            estimate_luminance_from_equirect(&EquirectLuminanceInput {
                width: 0,
                height: 2,
                data: &[],
            }),
            LuminanceEstimateOutcome::Unavailable { ref reason }
                if reason == "radiance-hdr:image-shape-invalid"
        ));
        // 负纹素拒绝。
        assert!(matches!(
            estimate_luminance_from_equirect(&EquirectLuminanceInput {
                width: 1,
                height: 1,
                data: &[-0.1, 0.18, 0.18],
            }),
            LuminanceEstimateOutcome::Unavailable { ref reason }
                if reason == "environment-texel-invalid"
        ));
        // 预滤波 mip:常量 half 场(0.18 = 0x345C)按立体角加权仍为常量。
        let mut bytes = Vec::new();
        for _ in 0..6 * 2 * 2 {
            bytes.extend_from_slice(&0x345Cu16.to_le_bytes());
            bytes.extend_from_slice(&0x345Cu16.to_le_bytes());
            bytes.extend_from_slice(&0x345Cu16.to_le_bytes());
            bytes.extend_from_slice(&0x3C00u16.to_le_bytes()); // alpha=1
        }
        let outcome = estimate_luminance_from_prefiltered_mip(&PrefilteredMipLuminanceInput {
            size: 2,
            rgba16float_bytes: &bytes,
        });
        match outcome {
            LuminanceEstimateOutcome::Estimated { luminance, provenance } => {
                assert_eq!(provenance, AutoExposureProvenance::PrefilteredIblMip);
                // half(0x345C) 的 f32 值 ≈ 0.17993164,f64 亮度与该值一致。
                let half_value = f64::from(crate::half_decode::half_to_f32(0x345C));
                assert!((luminance - half_value).abs() <= 1e-12, "{luminance}");
            }
            other => panic!("expected estimated, got {other:?}"),
        }
        // 字节数不足 fail-closed。
        assert!(matches!(
            estimate_luminance_from_prefiltered_mip(&PrefilteredMipLuminanceInput {
                size: 2,
                rgba16float_bytes: &bytes[..bytes.len() - 8],
            }),
            LuminanceEstimateOutcome::Unavailable { .. }
        ));
    }
}
