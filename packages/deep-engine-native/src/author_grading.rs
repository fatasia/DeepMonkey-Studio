//! 作者色彩分级六通道（hue/saturation/brightness/contrast/temperature/tint）。
//!
//! 语义仲裁基准是 Web 端 `pbrAuthorColorEffects.ts::applyPbrAuthorColorEffects`
//! （在固定 ACES/显示变换之前的 HDR 线性域逐式应用）；本模块提供：
//! - 运行包 wire 值的 fail-fast 校验（范围与 TS `scalar()` 一致）；
//! - 输出 uniform 的 12-float 打包（与 Web `packPbrAuthorColorEffects`
//!   的 `switches/grading/whiteBalance` 三 vec4 布局逐位一致）；
//! - CPU 参考实现（golden 测试与 WGSL 镜像同构，见 native_output_*.wgsl 的
//!   `author_grading_apply`；GPU 侧仅可能差乘加融合的 1 ulp 级噪声）。
//!
//! 六通道全零 = 精确中性：有限输入下逐位等于不启用分级的输出，
//! 宿主侧不写非零 uniform、渲染路径不增加状态。

/// TS 侧 hue 旋转使用的截断 π 字面量（非 f32::consts::PI，逐式镜像必须保留）。
const AUTHOR_PI: f32 = 3.14159265;
/// Rec.709 亮度权重，与 Web temperature/tint 亮度保持项同源。
const LUMA_WEIGHTS: [f32; 3] = [0.2126, 0.7152, 0.0722];

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AuthorGrading {
    /// 色相旋转角度，度，[-180, 180]。
    hue: f32,
    /// 饱和度，[-1, 1]；正值走 (0,1) 的压缩公式，负值为线性去饱和。
    saturation: f32,
    /// 亮度偏移，[-1, 1]。
    brightness: f32,
    /// 对比度增益增量，[-1, 1]；生效增益为 contrast + 1。
    contrast: f32,
    /// 色温，[-1, 1]；与 tint 同为保持亮度的白平衡增益。
    temperature: f32,
    /// 色调（绿-品红），[-1, 1]。
    tint: f32,
}

impl AuthorGrading {
    /// 六通道全零的精确中性档；等价于不声明 colorGrading 的旧运行包。
    pub const NEUTRAL: Self = Self {
        hue: 0.0,
        saturation: 0.0,
        brightness: 0.0,
        contrast: 0.0,
        temperature: 0.0,
        tint: 0.0,
    };

    /// fail-fast 构造：有限性 + 范围与 TS `scalar()` 的 min/max 一致。
    pub fn new(
        hue: f32,
        saturation: f32,
        brightness: f32,
        contrast: f32,
        temperature: f32,
        tint: f32,
    ) -> Result<Self, String> {
        let grading = Self {
            hue,
            saturation,
            brightness,
            contrast,
            temperature,
            tint,
        };
        const HUE_RANGE: (f32, f32) = (-180.0, 180.0);
        const CHANNEL_RANGE: (f32, f32) = (-1.0, 1.0);
        for (name, value, (min, max)) in [
            ("hue", grading.hue, HUE_RANGE),
            ("saturation", grading.saturation, CHANNEL_RANGE),
            ("brightness", grading.brightness, CHANNEL_RANGE),
            ("contrast", grading.contrast, CHANNEL_RANGE),
            ("temperature", grading.temperature, CHANNEL_RANGE),
            ("tint", grading.tint, CHANNEL_RANGE),
        ] {
            if !value.is_finite() || !(min..=max).contains(&value) {
                return Err(format!(
                    "author color grading {name} must be finite and within {min}..={max}"
                ));
            }
        }
        Ok(grading)
    }

    /// 六通道全零即精确中性（负零同样视为零）。
    pub fn is_neutral(self) -> bool {
        self == Self::NEUTRAL
    }

    /// 输出 uniform 打包：与 Web `packPbrAuthorColorEffects` 逐位一致。
    ///
    /// `switches = [effects, vignette, grading, vignette-darkness]`；
    /// vignette 属后续切片，本切片恒未启用（槽位保留，避免未来迁移布局）。
    pub fn pack(self) -> [f32; 12] {
        [
            1.0,
            0.0,
            1.0,
            0.0,
            self.hue,
            self.saturation,
            self.brightness,
            self.contrast,
            self.temperature,
            self.tint,
            0.0,
            0.0,
        ]
    }

    /// CPU 参考实现：与 WGSL `author_grading_apply` 同构，镜像 TS 仲裁基准。
    ///
    /// TS 中间运算在 f64 域，本实现按 Native f32 uniform/WGSL 语义在 f32 域
    /// 计算；golden 测试按 f32 精度容差对拍 TS 输出常量。
    pub fn apply(self, source: [f32; 3]) -> [f32; 3] {
        let mut color = source;
        // 1) hue：Three r185 HueSaturation 的旋转矩阵，行循环移位。
        if self.hue != 0.0 {
            let angle = self.hue / 180.0 * AUTHOR_PI;
            let s = angle.sin();
            let c = angle.cos();
            let weights = [
                (2.0 * c + 1.0) / 3.0,
                (-3.0_f32.sqrt() * s - c + 1.0) / 3.0,
                (3.0_f32.sqrt() * s - c + 1.0) / 3.0,
            ];
            color = [
                color[0] * weights[0] + color[1] * weights[1] + color[2] * weights[2],
                color[0] * weights[2] + color[1] * weights[0] + color[2] * weights[1],
                color[0] * weights[1] + color[1] * weights[2] + color[2] * weights[0],
            ];
        }
        // 2) saturation：TS 三元式——正值压缩、其余（含 0 与负值）线性。
        let average = (color[0] + color[1] + color[2]) / 3.0;
        let factor = if self.saturation > 0.0 {
            1.0 - 1.0 / (1.001 - self.saturation)
        } else {
            -self.saturation
        };
        color = [
            color[0] + (average - color[0]) * factor,
            color[1] + (average - color[1]) * factor,
            color[2] + (average - color[2]) * factor,
        ];
        // 3) brightness/contrast：仅任一非零时偏移后过对比度增益。
        if self.brightness != 0.0 || self.contrast != 0.0 {
            color = [
                (color[0] + self.brightness - 0.5) * (self.contrast + 1.0) + 0.5,
                (color[1] + self.brightness - 0.5) * (self.contrast + 1.0) + 0.5,
                (color[2] + self.brightness - 0.5) * (self.contrast + 1.0) + 0.5,
            ];
        }
        // 4) temperature/tint：仅任一非零时做保持亮度的白平衡增益；
        //    分母取 |balancedLuminance| 下限 1e-6，与 TS `Math.max(Math.abs(...))` 一致。
        if self.temperature != 0.0 || self.tint != 0.0 {
            let gains = [
                1.0 + self.temperature * 0.14 + self.tint * 0.07,
                1.0 - self.tint * 0.12,
                1.0 - self.temperature * 0.14 + self.tint * 0.07,
            ];
            let luma = color[0] * LUMA_WEIGHTS[0]
                + color[1] * LUMA_WEIGHTS[1]
                + color[2] * LUMA_WEIGHTS[2];
            let balanced = [
                color[0] * gains[0],
                color[1] * gains[1],
                color[2] * gains[2],
            ];
            let balanced_luma = balanced[0] * LUMA_WEIGHTS[0]
                + balanced[1] * LUMA_WEIGHTS[1]
                + balanced[2] * LUMA_WEIGHTS[2];
            // TS 的 `(value * luminance) / max(...)` 左结合顺序。
            color = [
                balanced[0] * luma / balanced_luma.abs().max(0.000001),
                balanced[1] * luma / balanced_luma.abs().max(0.000001),
                balanced[2] * luma / balanced_luma.abs().max(0.000001),
            ];
        }
        color
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 Web `packPbrAuthorColorEffects`（真实 TS 运行输出）逐位对拍的 golden。
    #[test]
    fn pack_matches_web_layout_bit_for_bit() {
        // node(--experimental-strip-types) 跑 packages/deep-engine/src 的真实输出：
        // packPbrAuthorColorEffects({colorGrading:{hue:30,saturation:0.5,brightness:-0.25,
        //   contrast:0.1,temperature:0.8,tint:-0.4}})
        // = [1,0,1,0,30,0.5,-0.25,0.1,0.8,-0.4,0,0]（f32）。
        let grading = AuthorGrading::new(30.0, 0.5, -0.25, 0.1, 0.8, -0.4).unwrap();
        assert_eq!(
            grading.pack(),
            [1.0, 0.0, 1.0, 0.0, 30.0, 0.5, -0.25, 0.1, 0.8, -0.4, 0.0, 0.0]
        );
        // 边界常量也由真实 TS 输出对拍：
        // {hue:-45,saturation:-0.6,brightness:0.2,contrast:-0.3,temperature:-1,tint:1}。
        let boundary = AuthorGrading::new(-45.0, -0.6, 0.2, -0.3, -1.0, 1.0).unwrap();
        assert_eq!(
            boundary.pack(),
            [1.0, 0.0, 1.0, 0.0, -45.0, -0.6, 0.2, -0.3, -1.0, 1.0, 0.0, 0.0]
        );
        // hue 之外可选通道缺省 0：wire 层 unwrap_or(0.0) 后 pack 与显式 0 一致。
        let defaults = AuthorGrading::new(15.0, 0.25, 0.05, 0.05, 0.0, 0.0).unwrap();
        assert_eq!(defaults.pack()[10..], [0.0, 0.0]);
    }

    /// 校验拒绝族：NaN、越界（含 1e300 反序列化为 inf 的路径）与边界内侧放行。
    #[test]
    fn rejects_non_finite_and_out_of_range_channels() {
        assert!(AuthorGrading::new(180.0, 0.0, 0.0, 0.0, 0.0, 0.0).is_ok());
        assert!(AuthorGrading::new(-180.0, -1.0, 1.0, -1.0, 1.0, -1.0).is_ok());
        for invalid in [
            AuthorGrading::new(180.1, 0.0, 0.0, 0.0, 0.0, 0.0),
            AuthorGrading::new(-180.1, 0.0, 0.0, 0.0, 0.0, 0.0),
            AuthorGrading::new(0.0, 1.1, 0.0, 0.0, 0.0, 0.0),
            AuthorGrading::new(0.0, 0.0, -1.1, 0.0, 0.0, 0.0),
            AuthorGrading::new(0.0, 0.0, 0.0, 1.01, 0.0, 0.0),
            AuthorGrading::new(0.0, 0.0, 0.0, 0.0, 1.0001, 0.0),
            AuthorGrading::new(0.0, 0.0, 0.0, 0.0, 0.0, -1.0001),
            AuthorGrading::new(f32::NAN, 0.0, 0.0, 0.0, 0.0, 0.0),
            AuthorGrading::new(0.0, f32::INFINITY, 0.0, 0.0, 0.0, 0.0),
            // 注：JSON 大数（如 1e300）反序列化为 inf 的路径由 solid_environment
            // 的 wire 层非法值族覆盖，这里不重复 f32 字面量溢出无法编译的分支。
        ] {
            assert!(invalid.is_err());
        }
    }

    /// 零值精确中性：有限输入（含负零与随机样本）逐位等于原值。
    #[test]
    fn neutral_grading_is_bit_exact_identity() {
        let samples = [
            [0.8, 0.5, 0.2],
            [1.5, -0.3, 2.0],
            [0.0, 0.0, 0.0],
            [-0.0, 0.25, -4.0],
            [0.2126, 0.7152, 0.0722],
            [12.5, 0.001, -0.001],
        ];
        for sample in samples {
            assert_eq!(AuthorGrading::NEUTRAL.apply(sample), sample);
        }
        assert!(AuthorGrading::NEUTRAL.is_neutral());
    }

    /// 逐通道数学 golden：常量来自真实 TS `applyPbrAuthorColorEffects` 输出
    /// （f64 域），按 f32 精度容差对拍（公式/顺序错误会远超该容差）。
    #[test]
    fn channel_math_matches_web_reference_within_f32_tolerance() {
        let cases: &[([f32; 3], AuthorGrading, [f64; 3])] = &[
            // hue=30, sat=0.5, bright=-0.25, contrast=0.1, temp=0.8, tint=-0.4
            (
                [0.8, 0.5, 0.2],
                AuthorGrading::new(30.0, 0.5, -0.25, 0.1, 0.8, -0.4).unwrap(),
                [0.6127742070936731, 0.5924237711205729, -0.43016100310583805],
            ),
            (
                [1.5, -0.3, 2.0],
                AuthorGrading::new(30.0, 0.5, -0.25, 0.1, 0.8, -0.4).unwrap(),
                [-3.2544811634689563, 2.0780075106558042, -1.222611202511523],
            ),
            (
                [0.0, 0.0, 0.0],
                AuthorGrading::new(30.0, 0.5, -0.25, 0.1, 0.8, -0.4).unwrap(),
                [0.3380738536449025, 0.3268463085355668, 0.2682135729645912],
            ),
            // hue=-45, sat=-0.6, bright=0.2, contrast=-0.3, temp=-1, tint=1
            (
                [0.8, 0.5, 0.2],
                AuthorGrading::new(-45.0, -0.6, 0.2, -0.3, -1.0, 1.0).unwrap(),
                [0.744204814355468, 0.548442125337779, 0.811491534441681],
            ),
            (
                [1.5, -0.3, 2.0],
                AuthorGrading::new(-45.0, -0.6, 0.2, -0.3, -1.0, 1.0).unwrap(),
                [0.860170481060293, 0.7795372387467431, 1.8582528676161847],
            ),
            (
                [0.2126, 0.7152, 0.0722],
                AuthorGrading::new(-45.0, -0.6, 0.2, -0.3, -1.0, 1.0).unwrap(),
                [0.5867688422141693, 0.5648739391813496, 0.5518948492432841],
            ),
            // 全通道边界：hue=180, sat=bright=contrast=temp=tint=1
            (
                [0.8, 0.5, 0.2],
                AuthorGrading::new(180.0, 1.0, 1.0, 1.0, 1.0, 1.0).unwrap(),
                [529.1754581252752, -1.6102730573294899, -410.12515971499437],
            ),
            (
                [0.0, 0.0, 0.0],
                AuthorGrading::new(180.0, 1.0, 1.0, 1.0, 1.0, 1.0).unwrap(),
                [1.902978502109528, 1.3839843651705654, 1.4626198404643478],
            ),
            // 小幅微调档：hue=15, sat=0.25, bright=contrast=0.05, temp=-0.5, tint=0.25
            (
                [0.8, 0.5, 0.2],
                AuthorGrading::new(15.0, 0.25, 0.05, 0.05, -0.5, 0.25).unwrap(),
                [0.8789515822534533, 0.6815282274026765, 0.09544626287925062],
            ),
            (
                [0.2126, 0.7152, 0.0722],
                AuthorGrading::new(15.0, 0.25, 0.05, 0.05, -0.5, 0.25).unwrap(),
                [0.0781704348151667, 0.9215474115569201, 0.14541671567584433],
            ),
        ];
        for (source, grading, expected) in cases {
            let output = grading.apply(*source);
            for (channel, golden) in output.iter().zip(expected.iter()) {
                let tolerance = 2e-4 * (1.0 + golden.abs());
                assert!(
                    (f64::from(*channel) - golden).abs() <= tolerance,
                    "grading {grading:?} on {source:?}: {output:?} vs web {expected:?}"
                );
            }
        }
    }

    /// 各通道独立生效的定性检查：锁住「条件分支与 TS 一致」这一契约
    /// （hue=0 跳过旋转、b/c 全零跳过增益、白平衡全零跳过亮度保持）。
    #[test]
    fn skipped_channels_leave_prior_stage_output() {
        // 仅 hue：非零 hue 旋转灰阶在数学上不变（权重行和为 1）；f32 舍入
        // 允许 ~1 ulp 差异，精确中性契约只由全零档逐位保证。
        let gray = AuthorGrading::new(90.0, 0.0, 0.0, 0.0, 0.0, 0.0)
            .unwrap()
            .apply([0.5, 0.5, 0.5]);
        for channel in gray {
            assert!((channel - 0.5).abs() < 1e-6, "hue gray {gray:?}");
        }
        // 仅 saturation=0：线性分支因子 0，恒等。
        let identity = AuthorGrading::new(0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
            .unwrap()
            .apply([0.25, 0.5, 0.75]);
        assert_eq!(identity, [0.25, 0.5, 0.75]);
        // 仅 saturation 正值：灰色不动（average=color）。
        let gray_sat = AuthorGrading::new(0.0, 0.75, 0.0, 0.0, 0.0, 0.0)
            .unwrap()
            .apply([0.5, 0.5, 0.5]);
        assert_eq!(gray_sat, [0.5, 0.5, 0.5]);
        // 仅白平衡：纯白亮度保持后仍为 1 增益行和（temperature=1 → R 增益放大）。
        let warm = AuthorGrading::new(0.0, 0.0, 0.0, 0.0, 1.0, 0.0)
            .unwrap()
            .apply([1.0, 1.0, 1.0]);
        let luma: f32 = warm[0] * 0.2126 + warm[1] * 0.7152 + warm[2] * 0.0722;
        assert!((luma - 1.0).abs() < 1e-5, "warm {warm:?} must keep luma");
        assert!(warm[0] > 1.0 && warm[2] < 1.0);
    }
}
