//! native 物理大气散射天空(I-C6/J4 atmosphere-sky 能力行的 native 缺位补齐)。
//!
//! 仲裁基准是 Web 端 T09 解析参考 `packages/deep-engine/src/environment/skyReference.ts`
//! 的 **analytic 单散射解析解**(任务口径:保守实施,先做单次散射近似,不做多次
//! 散射;I-C6 的 Bruneton 类预计算表链仍属 web radiance-hdr 权威路径,native 不复制):
//! - CPU 镜像 [`sample_analytic_sky_cpu`] 与 TS `sampleAnalyticSky` 逐式同构
//!   (f64 域,表达式顺序一致;Rayleigh 1/λ⁴ + Mie-HG,视线/太阳路径 Beer-Lambert,
//!   散射积分闭式 + k→0 极限分支,地平线路径地球曲率封顶,太阳地平下平滑熄灭);
//! - 常量与 TS 同值(680/550/450 nm 海平面 Rayleigh 系数、均匀大气 8000 m、
//!   地球半径 6371000 m、熄灭窗口 4°);参数合同同构:turbidity ∈ [1.9,10]、
//!   太阳方向 ENU 单位矢量(±1e-4)、Mie 各向异性缺省 0.8;
//! - WGSL 核 [`ATMOSPHERE_SKY_WGSL`] 与 TS 公式逐行同构(f32 域;唯一算子偏离:
//!   TS `Math.expm1(-k·L)` 在 WGSL 以 `1.0 - exp(-k·L)` 表达——f32 下 |k·L| ≥ 1e-3
//!   时相对误差 ≤ 2e-4,GPU 探针几何保证该下限);
//! - [`create_atmosphere_sky_pipeline`]:全屏三角背景 pass(线性 HDR 目标,输出
//!   未做曝光/ACES——与 forward 缓冲同域,色调映射归 OutputPass)。
//!
//! 登记口径(J4):native atmosphere-sky = supported/harness-only——CPU 镜像对
//! TS 金样逐位/1e-9 对拍 + WGSL 核真机 GPU readback 对拍(tests/atmosphere_sky_gpu.rs),
//! 生产 renderer 背景 pass 接线为后继切片。如实缺位:TS `samplePerezSky`
//! (Preetham 天顶亮度 + Perez 分布)与 `perezLuminanceDistribution` 未移植,
//! 属后继切片;solarTransmittance 已移植(供方向灯颜色映射同用途)。

/// 680/550/450 nm 海平面 Rayleigh 散射系数(1/m,教科书常数,与 TS 同值)。
pub const RAYLEIGH_BETA_RGB: [f64; 3] = [5.8045e-6, 1.35629e-5, 3.02659e-5];
/// 均匀大气等效高度(米,标高近似;任务口径中的"大气厚度"参数锚点)。
pub const ATMOSPHERE_HEIGHT_M: f64 = 8000.0;
/// 地球半径(米),只用于地平线路径封顶。
pub const EARTH_RADIUS_M: f64 = 6_371_000.0;
/// 太阳在地平以下时散射照度的平滑熄灭窗口(度)。
pub const TWILIGHT_FADE_DEG: f64 = 4.0;
/// DEG2RAD(与 TS `solarPosition.ts` 同值)。
const DEG2RAD: f64 = core::f64::consts::PI / 180.0;
/// Mie HG 缺省各向异性(与 TS `parameters.mieAnisotropy ?? 0.8` 同值)。
pub const DEFAULT_MIE_ANISOTROPY: f64 = 0.8;
/// HG 分母数值下限(与 TS `volumetricFog.ts` EPSILON 同值)。
const HG_EPSILON: f64 = 1e-8;

/// 天空参数合同(与 TS `SkyReferenceParameters` 同构;mode 固定 analytic,
/// perez 档缺位如实声明于模块头)。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AtmosphereSkyParameters {
    /// 大气浑浊度,有效域 [1.9, 10](任务口径"湍流系数")。
    pub turbidity: f64,
    /// 太阳方向(ENU 单位矢量,z 向上;±1e-4 容差)。
    pub sun_direction_enu: [f64; 3],
    /// Mie HG 各向异性(None = 0.8)。
    pub mie_anisotropy: Option<f64>,
}

impl AtmosphereSkyParameters {
    /// 校验并展开缺省值(fail-closed,与 TS `sampleSkyReference` 同域同序)。
    fn resolve(self) -> Result<(f64, [f64; 3], f64), String> {
        let anisotropy = self.mie_anisotropy.unwrap_or(DEFAULT_MIE_ANISOTROPY);
        if !self.turbidity.is_finite() || !(1.9..=10.0).contains(&self.turbidity) {
            return Err("Sky turbidity must be finite in [1.9, 10].".to_string());
        }
        let sun_length =
            (self.sun_direction_enu[0] * self.sun_direction_enu[0]
                + self.sun_direction_enu[1] * self.sun_direction_enu[1]
                + self.sun_direction_enu[2] * self.sun_direction_enu[2])
                .sqrt();
        if !sun_length.is_finite() || (sun_length - 1.0).abs() > 1e-4 {
            return Err("Sky sunDirectionEnu must be a unit vector.".to_string());
        }
        Ok((self.turbidity, self.sun_direction_enu, anisotropy))
    }
}

fn clamp_unit(value: f64) -> f64 {
    value.max(-1.0).min(1.0)
}

/// Rayleigh 相函数 `3/(16π)·(1+γ²)`(纯算术,与 TS 表达式顺序逐位同构)。
pub fn rayleigh_phase(cos_gamma: f64) -> f64 {
    3.0 / (16.0 * core::f64::consts::PI) * (1.0 + cos_gamma * cos_gamma)
}

/// Mie HG 相函数(与 TS `volumetricFog.ts::henyeyGreensteinPhase` 同式:
/// 先立方后开方,分母带 EPSILON 地板)。
fn henyey_greenstein_phase(cos_theta: f64, anisotropy: f64) -> f64 {
    let g2 = anisotropy * anisotropy;
    let base = (1.0 - 2.0 * anisotropy * cos_theta + g2).max(HG_EPSILON);
    let denominator = 4.0 * core::f64::consts::PI * (base * base * base).sqrt();
    (1.0 - g2) / denominator
}

/// 视线路径长:平面大气 h/cosθ,地球曲率封顶(θ→地平线时发散;与 TS 同式)。
fn view_path_length_meters(cos_view_zenith: f64) -> f64 {
    let clamped = cos_view_zenith.max(1e-4);
    let horizon_path = (2.0 * EARTH_RADIUS_M * ATMOSPHERE_HEIGHT_M
        + ATMOSPHERE_HEIGHT_M * ATMOSPHERE_HEIGHT_M)
        .sqrt();
    (ATMOSPHERE_HEIGHT_M / clamped).min(horizon_path)
}

/// 太阳在地平下的平滑熄灭因子(−4°..0° 线性 smoothstep 3t²−2t³);地平上恒为 1。
fn solar_visibility(sun_up_component: f64) -> f64 {
    if sun_up_component >= 0.0 {
        return 1.0;
    }
    let t = (1.0f64).min(-sun_up_component / (TWILIGHT_FADE_DEG * DEG2RAD));
    1.0 - (t * t * (3.0 - 2.0 * t))
}

/// analytic 单次散射解析解 CPU 镜像(TS `sampleAnalyticSky` 逐式同构,f64 域)。
///
/// 视点在地面,视线天顶角 θv,路径长 L=h/cosθv(封顶);均匀介质散射积分闭式:
/// `I = exp(−βtot·hA/cosθs) · (1 − exp(−k·L)) / k`,`k = βtot·(1 − cosθv/cosθs)`,
/// k→0 取极限 `exp(−βtot·hA/cosθs)·L`(数值稳定用 expm1,与 TS 同)。
pub fn sample_analytic_sky_cpu(
    parameters: AtmosphereSkyParameters,
    view_direction_enu: [f64; 3],
) -> Result<[f64; 3], String> {
    let (turbidity, sun, anisotropy) = parameters.resolve()?;
    let view_length = (view_direction_enu[0] * view_direction_enu[0]
        + view_direction_enu[1] * view_direction_enu[1]
        + view_direction_enu[2] * view_direction_enu[2])
        .sqrt();
    if !view_length.is_finite() || (view_length - 1.0).abs() > 1e-4 {
        return Err("Sky viewDirectionEnu must be a unit vector.".to_string());
    }
    let cos_gamma =
        clamp_unit(sun[0] * view_direction_enu[0] + sun[1] * view_direction_enu[1] + sun[2] * view_direction_enu[2]);
    let cos_view = clamp_unit(view_direction_enu[2]);
    let cos_sun = clamp_unit(sun[2]);
    let visibility = solar_visibility(sun[2]);
    let mie_beta = RAYLEIGH_BETA_RGB[1] * 0.75 * (turbidity / 4.0);
    let mut rgb = [0.0f64; 3];
    if cos_sun <= 0.0 && visibility <= 0.0 {
        return Ok(rgb);
    }
    let path_length = view_path_length_meters(cos_view);
    for (channel, &rayleigh) in RAYLEIGH_BETA_RGB.iter().enumerate() {
        let beta_total = rayleigh + mie_beta;
        let scattering_coefficient =
            rayleigh * rayleigh_phase(cos_gamma) + mie_beta * henyey_greenstein_phase(cos_gamma, anisotropy);
        let sun_optical_depth = beta_total * ATMOSPHERE_HEIGHT_M / cos_sun.max(1e-4);
        let sun_term = (-sun_optical_depth).exp() * visibility;
        let k = beta_total * (1.0 - cos_view / cos_sun.max(1e-4));
        let integral = if (k * path_length).abs() < 1e-8 {
            (-sun_optical_depth).exp() * path_length
        } else {
            (-sun_optical_depth).exp() * (-(-k * path_length).exp_m1() / k)
        };
        rgb[channel] = sun_term * scattering_coefficient * integral;
    }
    Ok(rgb)
}

/// 沿太阳方向到大气顶的通道透射率(含地平下熄灭;TS `solarTransmittance` 同构)。
pub fn solar_transmittance_cpu(
    parameters: AtmosphereSkyParameters,
) -> Result<[f64; 3], String> {
    let (turbidity, sun, _anisotropy) = parameters.resolve()?;
    let cos_sun = clamp_unit(sun[2]);
    let visibility = solar_visibility(sun[2]);
    let mie_beta = RAYLEIGH_BETA_RGB[1] * 0.75 * (turbidity / 4.0);
    let mut rgb = [0.0f64; 3];
    for (channel, &rayleigh) in RAYLEIGH_BETA_RGB.iter().enumerate() {
        let beta_total = rayleigh + mie_beta;
        rgb[channel] =
            (-beta_total * ATMOSPHERE_HEIGHT_M / cos_sun.max(1e-4)).exp() * visibility;
    }
    Ok(rgb)
}

/// 天空核:逐像素 analytic 单散射(f32;宿主经 uniform 供给射线基与参数)。
/// 与 TS `sampleAnalyticSky` 逐行同构;唯一算子偏离(1−exp 替代 expm1)见模块头。
pub const ATMOSPHERE_SKY_WGSL: &str = r#"
const deepAtmosphereBeta = vec3f(5.8045e-6, 1.35629e-5, 3.02659e-5);
const deepAtmosphereHeight = 8000.0;
const deepAtmosphereEarthRadius = 6371000.0;
const deepAtmosphereTwilightFade = 0.06981317007977318; // 4° in radians
fn deepAtmosphereClampUnit(v: f32) -> f32 { return clamp(v, -1.0, 1.0); }
fn deepAtmosphereRayleighPhase(cosGamma: f32) -> f32 {
  return 3.0 / (16.0 * 3.141592653589793) * (1.0 + cosGamma * cosGamma);
}
fn deepAtmosphereHenyeyGreenstein(cosTheta: f32, anisotropy: f32) -> f32 {
  let g2 = anisotropy * anisotropy;
  let base = max(1.0 - 2.0 * anisotropy * cosTheta + g2, 1e-8);
  let denominator = 4.0 * 3.141592653589793 * sqrt(base * base * base);
  return (1.0 - g2) / denominator;
}
fn deepAtmosphereViewPath(cosViewZenith: f32) -> f32 {
  let clamped = max(cosViewZenith, 1e-4);
  let horizonPath = sqrt(2.0 * deepAtmosphereEarthRadius * deepAtmosphereHeight
    + deepAtmosphereHeight * deepAtmosphereHeight);
  return min(deepAtmosphereHeight / clamped, horizonPath);
}
fn deepAtmosphereSolarVisibility(sunUp: f32) -> f32 {
  if (sunUp >= 0.0) { return 1.0; }
  let t = min(1.0, -sunUp / deepAtmosphereTwilightFade);
  return 1.0 - (t * t * (3.0 - 2.0 * t));
}
fn deepAtmosphereAnalyticSky(viewDirection: vec3f, sunDirection: vec3f,
  turbidity: f32, anisotropy: f32) -> vec3f {
  let cosGamma = deepAtmosphereClampUnit(dot(sunDirection, viewDirection));
  let cosView = deepAtmosphereClampUnit(viewDirection.z);
  let cosSun = deepAtmosphereClampUnit(sunDirection.z);
  let visibility = deepAtmosphereSolarVisibility(sunDirection.z);
  let mieBeta = deepAtmosphereBeta[1] * 0.75 * (turbidity / 4.0);
  if (cosSun <= 0.0 && visibility <= 0.0) { return vec3f(0.0); }
  let pathLength = deepAtmosphereViewPath(cosView);
  var rgb = vec3f(0.0);
  for (var channel = 0u; channel < 3u; channel++) {
    let rayleigh = deepAtmosphereBeta[channel];
    let betaTotal = rayleigh + mieBeta;
    let scattering = rayleigh * deepAtmosphereRayleighPhase(cosGamma)
      + mieBeta * deepAtmosphereHenyeyGreenstein(cosGamma, anisotropy);
    let sunOpticalDepth = betaTotal * deepAtmosphereHeight / max(cosSun, 1e-4);
    let sunTerm = exp(-sunOpticalDepth) * visibility;
    let k = betaTotal * (1.0 - cosView / max(cosSun, 1e-4));
    let kl = k * pathLength;
    let limit = exp(-sunOpticalDepth) * pathLength;
    var integral = exp(-sunOpticalDepth) * ((1.0 - exp(-kl)) / k);
    if (abs(kl) < 1e-8) { integral = limit; }
    rgb[channel] = sunTerm * scattering * integral;
  }
  return rgb;
}
"#;

/// Sky 背景 pass 着色器(binding 0 uniform;全屏三角;线性 HDR 目标直写)。
pub fn atmosphere_sky_shader() -> String {
    let mut shader = String::from(
        r#"
struct SkyUniforms {
  rayRightScaled: vec4f, // right.xyz * (tanHalfFov * aspect)
  rayUpScaled: vec4f,    // up.xyz * tanHalfFov
  camForward: vec4f,     // forward.xyz(单位矢量)
  sunParams: vec4f,      // sun.xyz(ENU 单位矢量), turbidity
  misc: vec4f,           // x = mieAnisotropy
};
@group(0) @binding(0) var<uniform> sky: SkyUniforms;
"#,
    );
    shader.push_str(ATMOSPHERE_SKY_WGSL);
    shader.push_str(
        r#"
struct SkyVertex { @builtin(position) position: vec4f, @location(0) ndc: vec2f };
@vertex fn vertex_main(@builtin(vertex_index) i: u32) -> SkyVertex {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[i];
  var v: SkyVertex; v.position = vec4f(p, 0.0, 1.0); v.ndc = p; return v;
}
@fragment fn fragment_main(v: SkyVertex) -> @location(0) vec4f {
  let dir = normalize(sky.camForward.xyz + v.ndc.x * sky.rayRightScaled.xyz + v.ndc.y * sky.rayUpScaled.xyz);
  return vec4f(deepAtmosphereAnalyticSky(dir, sky.sunParams.xyz, sky.sunParams.w, sky.misc.x), 1.0);
}
"#,
    );
    shader
}

/// Sky pass uniform 打包(80 B,repr(C),与 WGSL `SkyUniforms` 逐槽对齐)。
#[repr(C)]
#[derive(Debug, Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SkyDrawUniforms {
    pub ray_right_scaled: [f32; 4],
    pub ray_up_scaled: [f32; 4],
    pub cam_forward: [f32; 4],
    pub sun_params: [f32; 4],
    pub misc: [f32; 4],
}

/// 打包射线基与天空参数(缩放基由调用方按 tanHalfFov/aspect 预乘)。
pub fn pack_sky_draw_uniforms(
    ray_right_scaled: [f32; 3],
    ray_up_scaled: [f32; 3],
    cam_forward: [f32; 3],
    sun_direction_enu: [f32; 3],
    turbidity: f32,
    mie_anisotropy: f32,
) -> SkyDrawUniforms {
    SkyDrawUniforms {
        ray_right_scaled: [ray_right_scaled[0], ray_right_scaled[1], ray_right_scaled[2], 0.0],
        ray_up_scaled: [ray_up_scaled[0], ray_up_scaled[1], ray_up_scaled[2], 0.0],
        cam_forward: [cam_forward[0], cam_forward[1], cam_forward[2], 0.0],
        sun_params: [sun_direction_enu[0], sun_direction_enu[1], sun_direction_enu[2], turbidity],
        misc: [mie_anisotropy, 0.0, 0.0, 0.0],
    }
}

/// 全屏天空背景渲染管线(线性 HDR/浮点目标;生产接线时目标格式随 pass 传入)。
pub fn create_atmosphere_sky_pipeline(
    device: &wgpu::Device,
    target_format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Deep Engine native atmosphere sky shader"),
        source: wgpu::ShaderSource::Wgsl(atmosphere_sky_shader().into()),
    });
    let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("Deep Engine native atmosphere sky bind layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: Some(std::num::NonZeroU64::new(
                    std::mem::size_of::<SkyDrawUniforms>() as u64,
                )
                .expect("non-zero uniform size")),
            },
            count: None,
        }],
    });
    let real_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("Deep Engine native atmosphere sky pipeline layout (bound)"),
        bind_group_layouts: &[Some(&bind_layout)],
        immediate_size: 0,
    });
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Deep Engine native atmosphere sky pipeline"),
        layout: Some(&real_layout),
        vertex: wgpu::VertexState {
            module: &module,
            entry_point: Some("vertex_main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fragment_main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: target_format,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS 金样(vitest 直跑 `skyReference.ts` 采集的 f64 位型;采集脚本参数
    /// 写死在断言里,重跑 TS 侧同参即可复核)。libm 哨兵(exp/pow/sqrt/hypot
    /// 跨 V8/Rust libm 可差 1-2 ulp)如实以 1e-9 相对容差对拍;纯算术函数逐位。
    fn bits(value: f64) -> u64 {
        value.to_bits()
    }

    fn assert_bit(value: f64, expected_hex: &str, what: &str) {
        assert_eq!(
            format!("{:016x}", bits(value)),
            expected_hex,
            "bit drift on {what}"
        );
    }

    fn assert_close(value: f64, expected_hex: &str, what: &str) {
        let expected = f64::from_bits(u64::from_str_radix(expected_hex, 16).expect("hex"));
        let scale = expected.abs().max(1e-300);
        assert!(
            (value - expected).abs() / scale < 1e-9,
            "{what}: {value} vs {expected}"
        );
    }

    /// 纯算术相函数逐位(Rayleigh 系数与 π 常量两侧同精度,无超越函数)。
    #[test]
    fn rayleigh_phase_is_bit_exact() {
        assert_bit(rayleigh_phase(1.0), "3fbe8ec8a4aeacc4", "rayleigh up");
        assert_bit(rayleigh_phase(0.0), "3fae8ec8a4aeacc4", "rayleigh perp");
        assert_bit(rayleigh_phase(0.5), "3fb3193d66ed2bfa", "rayleigh half");
    }

    /// HG 相函数(pow/sqrt 哨兵 → 1e-9 相对)。
    #[test]
    fn henyey_greenstein_matches_ts_reference() {
        let cases: [(f64, f64, &str); 4] = [
            (1.0, 0.8, "400ca5dc1a63c1eb"),
            (0.0, 0.8, "3f8bef7e7ac16739"),
            (-1.0, 0.8, "3f741ecddb0cd2ab"),
            (0.5, 0.8, "3fa30d58c5bb5bf6"),
        ];
        for (cos_theta, g, golden) in cases {
            let value = {
                let g2 = g * g;
                let base = (1.0 - 2.0 * g * cos_theta + g2).max(HG_EPSILON);
                let denominator =
                    4.0 * core::f64::consts::PI * (base * base * base).sqrt();
                (1.0 - g2) / denominator
            };
            assert_close(value, golden, "hg({cos_theta},{g})");
            let mirrored = henyey_greenstein_phase(cos_theta, g);
            assert_close(mirrored, golden, "hg mirror({cos_theta},{g})");
        }
    }

    /// 与 TS 采集脚本同表达式(f64 逐位同源):√(1−0.25−0.36)。
    fn sun_t4() -> [f64; 3] {
        [0.5, 0.6, (1.0_f64 - 0.25 - 0.36).sqrt()]
    }
    /// 单位矢量低太阳 [0.8,0,0.6](19.5° 高度角,t19 场景)。
    const SUN_LOW: [f64; 3] = [0.8, 0.0, 0.6];

    fn analytic(turbidity: f64, sun: [f64; 3], view: [f64; 3], anisotropy: Option<f64>) -> [f64; 3] {
        sample_analytic_sky_cpu(
            AtmosphereSkyParameters { turbidity, sun_direction_enu: sun, mie_anisotropy: anisotropy },
            view,
        )
        .expect("valid sky sample")
    }

    /// TS 金样场景族(单位矢量场景,1e-9 相对容差,exp/expm1/pow 跨 libm
    /// 哨兵如实;turbidity 4/1.9 × 天顶/地平/顺光/逆光/中天)。
    #[test]
    fn analytic_sky_matches_ts_golden_scenes() {
        let mid = [0.3, 0.4, (1.0_f64 - 0.09 - 0.16).sqrt()];
        let scenes: [(&str, f64, [f64; 3], Option<f64>, [f64; 3], [&str; 3]); 10] = [
            ("t4_zenith", 4.0, sun_t4(), None, [0.0, 0.0, 1.0],
                ["3f77bde5ebceef5f", "3f7fff31719a67bd", "3f83c2ac0e81449a"]),
            ("t4_horizon", 4.0, sun_t4(), None, [1.0, 0.0, 0.0],
                ["3fa12aa45bfa7e43", "3fa051a05b7d3a31", "3f97b0e5c6b77b80"]),
            ("t4_sun", 4.0, sun_t4(), None, sun_t4(),
                ["3fd435c55b1111a0", "3fd0faeee76db687", "3fc74c174bfb8695"]),
            ("t4_antisun", 4.0, sun_t4(), None,
                [-sun_t4()[0], -sun_t4()[1], -sun_t4()[2]],
                ["3f8f9ddebc3f53d6", "3f939929883a7742", "3f9074cf5a06fbfc"]),
            ("t4_mid", 4.0, sun_t4(), None, mid,
                ["3fa232302ee1e258", "3fa172e8bf9319bd", "3f9e2b7287cc2172"]),
            ("t19_zenith", 1.9, SUN_LOW, Some(0.6), [0.0, 0.0, 1.0],
                ["3f782a1eac1558d7", "3f80ab8b30c9ed45", "3f84c1e70521b293"]),
            ("t19_horizon", 1.9, SUN_LOW, Some(0.6), [1.0, 0.0, 0.0],
                ["3fbafe24d380d676", "3fb38bebd8e733f4", "3fa683e00e57c15d"]),
            ("t19_sun", 1.9, SUN_LOW, Some(0.6), SUN_LOW,
                ["3fa7540128e2e85b", "3fa6d6e1280c0870", "3fa3f7e80c827319"]),
            ("t19_antisun", 1.9, SUN_LOW, Some(0.6),
                [-SUN_LOW[0], -SUN_LOW[1], -SUN_LOW[2]],
                ["3f9b434ee82c78a9", "3f9c9d8dbb014809", "3f9503ae067a3da8"]),
            ("t19_mid", 1.9, SUN_LOW, Some(0.6), mid,
                ["3f83e2fd97eadeee", "3f8937a347169872", "3f8d456dcd3327ff"]),
        ];
        for (name, turbidity, sun, anisotropy, view, golden) in scenes {
            let rgb = analytic(turbidity, sun, view, anisotropy);
            for channel in 0..3 {
                assert_close(rgb[channel], golden[channel], "{name} ch{channel}");
            }
        }
    }

    /// turbidity=10 高角太阳场景(单位矢量 [0.2,0.2,√0.92];TS 金样 1e-9 相对)。
    #[test]
    fn analytic_sky_turbid_sun_scene_matches_ts() {
        let mid = [0.3, 0.4, (1.0_f64 - 0.09 - 0.16).sqrt()];
        let sun = [0.2, 0.2, (1.0_f64 - 0.04 - 0.04).sqrt()];
        let scenes: [(&str, [f64; 3], [&str; 3]); 3] = [
            ("t10_zenith", [0.0, 0.0, 1.0],
                ["3fbadf41f9c86eb9", "3fb89901f6a393bd", "3fb43b6a6b1ffafa"]),
            ("t10_horizon", [1.0, 0.0, 0.0],
                ["3f905e120f47d44d", "3f921e66646b33c6", "3f9120c5646fb650"]),
            ("t10_mid", mid,
                ["3fc42571da8d66b4", "3fc22f4b6e107f25", "3fbd15c5cad1de08"]),
        ];
        for (name, view, golden) in scenes {
            let rgb = analytic(10.0, sun, view, None);
            for channel in 0..3 {
                assert_close(rgb[channel], golden[channel], "{name} ch{channel}");
            }
        }
    }

    /// 太阳透射率(TS 金样 1e-9 相对)。
    #[test]
    fn solar_transmittance_matches_ts() {
        let rgb = solar_transmittance_cpu(AtmosphereSkyParameters {
            turbidity: 4.0,
            sun_direction_enu: sun_t4(),
            mie_anisotropy: None,
        })
        .expect("valid transmittance");
        let golden = ["3fea13d34400da26", "3fe79c3d773d24c7", "3fe30ff4a3484e28"];
        for channel in 0..3 {
            assert_close(rgb[channel], golden[channel], "trans ch{channel}");
        }
    }

    /// 物理哨兵:天顶 Rayleigh 蓝胜红(t4);太阳方向全场最亮;熄灭档
    /// (太阳 ≥ −4° 以下且 cosSun ≤ 0)严格归零;地平下视向退化为地平路径。
    #[test]
    fn analytic_sky_physical_sentinels_hold() {
        let rgb = analytic(4.0, sun_t4(), [0.0, 0.0, 1.0], None);
        assert!(rgb[2] > rgb[0], "zenith must be blue-dominant: {rgb:?}");
        let sun_view = analytic(4.0, sun_t4(), sun_t4(), None);
        let anti_view = analytic(4.0, sun_t4(), [-sun_t4()[0], -sun_t4()[1], -sun_t4()[2]], None);
        assert!(sun_view[0] > anti_view[0] * 5.0, "circumsolar brightening");
        // 太阳沉入熄灭窗口之下(−10°,单位矢量)→ 全零。
        let sunk = [0.984807753012208, 0.0, -0.17364817766693041];
        let night = analytic(4.0, sunk, [0.0, 0.0, 1.0], None);
        assert_eq!(night, [0.0, 0.0, 0.0], "below twilight window must vanish");
        // 地平上 +2° 低太阳 → 强地平消光(TS 实证 2.4498e-5,对 38.6° 太阳
        // 0.0057963 约衰减 237×)。
        let low_above = analytic(
            4.0,
            [0.9993908270190958, 0.0, 0.03490658503988659],
            [0.0, 0.0, 1.0],
            None,
        );
        assert!(
            (low_above[0] - 0.000024497546116903347).abs() / 0.000024497546116903347 < 1e-9
                && low_above[0] < rgb[0] / 100.0,
            "horizon extinction must attenuate strongly: {:?}",
            low_above[0]
        );
        // 如实声明(与 TS 共有的公式瑕疵,镜像逐位复现):太阳在 0..−4° 熄灭
        // 窗口内(visibility>0 而 cosSun≤0)时 expm1 溢出 → TS 同样产出
        // NaN(vitest 实证 JSON [null,null,null]);生产接线必须保证太阳在地平上
        // 或先做钳制。断言非有限,钉住该共有行为防止"看似修复"的静默漂移。
        let dusk_below = analytic(
            4.0,
            [0.9993908270190958, 0.0, -0.03490658503988659],
            [0.0, 0.0, 1.0],
            None,
        );
        assert!(
            !dusk_below[0].is_finite(),
            "in-window below-horizon sun must reproduce the shared TS non-finite quirk"
        );
        // 同输入逐位同输出(确定性)。
        let again = analytic(4.0, sun_t4(), [0.0, 0.0, 1.0], None);
        assert_eq!(format!("{:016x}", bits(rgb[0])), format!("{:016x}", bits(again[0])));
    }

    /// 参数合同 fail-closed(与 TS 同域:浊度 [1.9,10]、双单位矢量 ±1e-4)。
    #[test]
    fn parameter_contract_fails_closed() {
        let view = [0.0, 0.0, 1.0];
        let low = AtmosphereSkyParameters { turbidity: 1.8, sun_direction_enu: sun_t4(), mie_anisotropy: None };
        let high = AtmosphereSkyParameters { turbidity: 10.1, sun_direction_enu: sun_t4(), mie_anisotropy: None };
        let nan = AtmosphereSkyParameters { turbidity: f64::NAN, sun_direction_enu: sun_t4(), mie_anisotropy: None };
        let bad_sun = AtmosphereSkyParameters { turbidity: 4.0, sun_direction_enu: [1.0, 0.0, 0.5], mie_anisotropy: None };
        assert!(sample_analytic_sky_cpu(low, view).is_err());
        assert!(sample_analytic_sky_cpu(high, view).is_err());
        assert!(sample_analytic_sky_cpu(nan, view).is_err());
        assert!(sample_analytic_sky_cpu(bad_sun, view).is_err());
        let bad_view = [0.5, 0.5, 0.5]; // 长度 0.866
        let good = AtmosphereSkyParameters { turbidity: 4.0, sun_direction_enu: sun_t4(), mie_anisotropy: None };
        assert!(sample_analytic_sky_cpu(good, bad_view).is_err());
        // 边界值 1.9/10 合法。
        assert!(sample_analytic_sky_cpu(
            AtmosphereSkyParameters { turbidity: 1.9, sun_direction_enu: sun_t4(), mie_anisotropy: None }, view
        )
        .is_ok());
    }

    /// uniform 打包布局槽位核对(80 B,通道顺序与 WGSL 逐槽一致)。
    #[test]
    fn draw_uniforms_pack_slot_aligned() {
        let uniforms = pack_sky_draw_uniforms(
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, -1.0],
            sun_t4().map(|v| v as f32),
            4.0,
            0.8,
        );
        assert_eq!(uniforms.ray_right_scaled, [1.0, 0.0, 0.0, 0.0]);
        assert_eq!(uniforms.ray_up_scaled, [0.0, 1.0, 0.0, 0.0]);
        assert_eq!(uniforms.cam_forward, [0.0, 0.0, -1.0, 0.0]);
        assert_eq!(uniforms.sun_params[3], 4.0);
        assert_eq!(uniforms.misc, [0.8, 0.0, 0.0, 0.0]);
        assert_eq!(std::mem::size_of::<SkyDrawUniforms>(), 80);
    }

    /// WGSL 核与 CPU 镜像同构哨兵:关键分支(k→0 极限、熄灭早退、曲率封顶)
    /// 在 WGSL 文本中以同型表达式存在,防止单源漂移(结构性守门,真机数值
    /// 对拍在 tests/atmosphere_sky_gpu.rs)。
    #[test]
    fn wgsl_core_mirrors_cpu_branches() {
        let core = ATMOSPHERE_SKY_WGSL;
        assert!(core.contains("1e-8") && core.contains("abs(kl) < 1e-8"), "k→0 limit branch");
        assert!(core.contains("cosSun <= 0.0 && visibility <= 0.0"), "twilight early-out");
        assert!(core.contains("sqrt(2.0 * deepAtmosphereEarthRadius"), "horizon cap");
        assert!(core.contains("1.0 - exp(-kl)"), "expm1 deviation is the documented one");
        assert!(core.contains("(turbidity / 4.0)"), "turbidity scaling");
        let shader = atmosphere_sky_shader();
        assert!(shader.contains("normalize(sky.camForward.xyz"), "ray reconstruction");
        assert!(shader.contains("@fragment fn fragment_main"), "entry points");
    }
}
