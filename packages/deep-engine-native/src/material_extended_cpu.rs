//! C9/native 材质扩展带 CPU 权威镜像(f64)。
//!
//! 逐式移植 TS 生产 CPU 权威(与 material_parity_tests 共同消费
//! `deep-engine/fixtures/material-native-parity-v1.json` 对拍):
//! - [`evaluate_extended_material_direct`] ← shader/materialEvaluate.ts
//!   (clearcoat 层叠直接光调用 shaderAuthoring/packageClearcoat v3 参考,
//!   [`evaluate_clearcoat_reference`]);
//! - sheen 原语 ← shader/materialAdvancedReference.ts;
//! - 打包带词 ← prepare_material_uniform 的扩展/advanced 带(TS
//!   packExtendedParameterBlock / packAdvancedParameterBlock 同序同缺省);
//! - [`native_extended_response`] ← native_mesh_v1.wgsl `native_extended_shade`
//!   的无 IBL/无局部灯/无阴影合成腿(GPU 探针 expected 值),其中直射支路
//!   (brdfDirectLighting.wgsl / brdfDirectMultiscattering.wgsl)与 r185 DFG 表
//!   (directDfgLut185.wgsl,表值从生产着色器单源解析)逐式同构。
//!
//! 对拍纪律:f64 相对 ≤1e-9(跨 libm pow/exp2 哨兵),f32 打包词位级,
//! 求值 f32 词 ≤2 ulp。仅供测试与真机对拍;生产渲染不引用本模块。

/// TS `dielectricF0`(materialDielectric.ts):ior=1.5 精确退化为 0.04。
pub fn dielectric_f0(ior: f64) -> f64 {
    if ior == 1.5 {
        return 0.04;
    }
    let reflectance = 1.0 - 2.0 / (ior + 1.0);
    reflectance * reflectance
}

const PI: f64 = std::f64::consts::PI;
const ROUGHNESS_FLOOR: f64 = 0.045;

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn map3(a: [f64; 3], f: impl Fn(f64) -> f64) -> [f64; 3] {
    [f(a[0]), f(a[1]), f(a[2])]
}

fn mul3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}

fn scale3(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn safe_normalize(value: [f64; 3], fallback: [f64; 3]) -> [f64; 3] {
    let length_squared = dot3(value, value);
    if length_squared <= 1e-8 {
        return fallback;
    }
    scale3(value, 1.0 / length_squared.sqrt())
}

/// packageClearcoat.evaluateClearcoatReference 的 f64 移植;返回
/// (direct_base_attenuation, direct_lobe, ibl_base_attenuation, ibl_lobe)。
pub fn evaluate_clearcoat_reference(
    factor: f64,
    roughness: f64,
    n_dot_l: f64,
    n_dot_v: f64,
    n_dot_h: f64,
    v_dot_h: f64,
    dfg: [f64; 2],
) -> [f64; 4] {
    let fresnel = |cosine: f64| 0.04 + 0.96 * (1.0 - cosine).powi(5);
    let distribution = |n_dot_h: f64, roughness: f64| {
        let alpha = roughness * roughness;
        let alpha2 = alpha * alpha;
        let denominator = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
        alpha2 / (PI * denominator * denominator).max(0.000_001)
    };
    let geometry = |n_dot_x: f64, roughness: f64| {
        let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        n_dot_x / (n_dot_x * (1.0 - k) + k).max(0.0001)
    };
    let roughness = clamp(roughness, ROUGHNESS_FLOOR, 1.0);
    let n_dot_l = clamp(n_dot_l, 0.0, 1.0);
    let n_dot_v = clamp(n_dot_v, 0.0001, 1.0);
    let direct_fresnel = fresnel(clamp(v_dot_h, 0.0, 1.0));
    let direct_specular = distribution(clamp(n_dot_h, 0.0, 1.0), roughness)
        * geometry(n_dot_v, roughness)
        * geometry(n_dot_l, roughness)
        * direct_fresnel
        / (4.0 * n_dot_v * n_dot_l).max(0.0001);
    let view_fresnel = fresnel(n_dot_v);
    let dfg_sum = (dfg[0] + dfg[1]).max(0.05);
    let energy_compensation = 1.0 + 0.04 * (1.0 / dfg_sum - 1.0);
    [
        1.0 - factor * direct_fresnel,
        factor * direct_specular,
        1.0 - factor * view_fresnel,
        factor * (0.04 * dfg[0] + dfg[1]) * energy_compensation,
    ]
}

/// 材质求值输入(TS `ExtendedMaterialParameters` 展平域,TS 缺省域)。
#[derive(Clone, Copy, Debug)]
pub struct ExtendedInputs {
    pub ior: f64,
    pub clearcoat_factor: f64,
    pub clearcoat_roughness: f64,
    pub anisotropy_strength: f64,
    pub anisotropy_rotation: f64,
    pub transmission_factor: f64,
}

impl Default for ExtendedInputs {
    fn default() -> Self {
        Self {
            ior: 1.5,
            clearcoat_factor: 0.0,
            clearcoat_roughness: 0.0,
            anisotropy_strength: 0.0,
            anisotropy_rotation: 0.0,
            transmission_factor: 0.0,
        }
    }
}

/// materialEvaluate.evaluateExtendedMaterialDirect 的 f64 移植。
/// 返回 (rgb, diffuse, specular, clearcoat, transmission)。
#[allow(clippy::too_many_arguments)]
pub fn evaluate_extended_material_direct(
    base_color: [f64; 3],
    metallic: f64,
    roughness: f64,
    params: ExtendedInputs,
    normal_in: [f64; 3],
    view_in: [f64; 3],
    light_in: [f64; 3],
    tangent_in: Option<[f64; 3]>,
    radiance: [f64; 3],
) -> ([f64; 3], [f64; 3], [f64; 3], [f64; 3], [f64; 3]) {
    let normal = safe_normalize(normal_in, [0.0, 1.0, 0.0]);
    let view = safe_normalize(view_in, [0.0, 0.0, 1.0]);
    let light = safe_normalize(light_in, [0.0, 1.0, 0.0]);
    let half_vector = safe_normalize(add3(view, light), normal);

    let metallic = clamp(metallic, 0.0, 1.0);
    let roughness = clamp(roughness, ROUGHNESS_FLOOR, 1.0);
    let base_color = map3(base_color, |value| value.max(0.0));
    let n_dot_l = clamp(dot3(normal, light), 0.0, 1.0);
    let n_dot_v = clamp(dot3(normal, view), 1e-4, 1.0);
    let n_dot_h = clamp(dot3(normal, half_vector), 0.0, 1.0);
    let v_dot_h = clamp(dot3(view, half_vector), 0.0, 1.0);

    let f0_dielectric = dielectric_f0(params.ior);
    let f0: [f64; 3] =
        [f0_dielectric + (base_color[0] - f0_dielectric) * metallic,
         f0_dielectric + (base_color[1] - f0_dielectric) * metallic,
         f0_dielectric + (base_color[2] - f0_dielectric) * metallic];
    let schlick_scalar = |f0: f64, cosine: f64| f0 + (1.0 - f0) * (1.0 - cosine).powi(5);
    let fresnel: [f64; 3] = map3(f0, |channel| schlick_scalar(channel, v_dot_h));

    let distribution_ggx = |n_dot_h: f64, roughness: f64| {
        let alpha = roughness * roughness;
        let alpha2 = alpha * alpha;
        let denominator = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
        alpha2 / (PI * denominator * denominator).max(1e-6)
    };
    let distribution_ggx_anisotropic = |t_dot_h: f64, b_dot_h: f64, n_dot_h: f64, alpha: f64, strength: f64| {
        let ax = (alpha * (1.0 + strength)).max(1e-3);
        let ay = alpha.max(1e-3);
        let d = (t_dot_h / ax) * (t_dot_h / ax) + (b_dot_h / ay) * (b_dot_h / ay) + n_dot_h * n_dot_h;
        1.0 / (PI * ax * ay * d * d).max(1e-12)
    };
    let mut distribution = distribution_ggx(n_dot_h, roughness);
    if params.anisotropy_strength != 0.0 {
        // anisotropicFrame(TS 同式:投影正交化 + 旋转)。
        let cross3 = |a: [f64; 3], b: [f64; 3]| {
            [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
        };
        let raw = tangent_in.unwrap_or([1.0, 0.0, 0.0]);
        let projection = dot3(raw, normal);
        let projected = safe_normalize(
            [raw[0] - normal[0] * projection, raw[1] - normal[1] * projection, raw[2] - normal[2] * projection],
            [1.0, 0.0, 0.0],
        );
        let (sin_rotation, cos_rotation) = params.anisotropy_rotation.sin_cos();
        let bitangent = safe_normalize(cross3(normal, projected), [0.0, 1.0, 0.0]);
        let t: [f64; 3] = std::array::from_fn(|axis| {
            projected[axis] * cos_rotation + bitangent[axis] * sin_rotation
        });
        let b: [f64; 3] = std::array::from_fn(|axis| {
            bitangent[axis] * cos_rotation - projected[axis] * sin_rotation
        });
        let alpha = roughness * roughness;
        distribution = distribution_ggx_anisotropic(dot3(t, half_vector), dot3(b, half_vector), n_dot_h, alpha, params.anisotropy_strength);
    }
    let geometry_schlick = |n_dot_x: f64, roughness: f64| {
        let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
        n_dot_x / (n_dot_x * (1.0 - k) + k).max(1e-4)
    };
    let geometry_term = geometry_schlick(n_dot_v, roughness) * geometry_schlick(n_dot_l, roughness);
    let specular_scalar = distribution * geometry_term / (4.0 * n_dot_v * n_dot_l).max(1e-4);
    let specular = scale3(fresnel, specular_scalar);
    let diffuse = scale3(mul3(map3(fresnel, |value| 1.0 - value), base_color), (1.0 - metallic) / PI);

    let transmission = params.transmission_factor;
    let transmittance = schlick_scalar(f0_dielectric, n_dot_v);
    let transmission_lobe = scale3(
        mul3(base_color, [1.0 - metallic; 3]),
        transmission * (1.0 - transmittance) / PI,
    );
    let scaled_diffuse = scale3(diffuse, 1.0 - transmission);

    let coat = evaluate_clearcoat_reference(
        params.clearcoat_factor, params.clearcoat_roughness, n_dot_l, n_dot_v, n_dot_h, v_dot_h, [0.0, 0.0],
    );
    let base = [
        scaled_diffuse[0] + specular[0] + transmission_lobe[0],
        scaled_diffuse[1] + specular[1] + transmission_lobe[1],
        scaled_diffuse[2] + specular[2] + transmission_lobe[2],
    ];
    let layered = [
        base[0] * coat[0] + coat[1],
        base[1] * coat[0] + coat[1],
        base[2] * coat[0] + coat[1],
    ];
    // TS 同式:rgb = layered * radiance[i] * nDotL(逐通道 radiance)。
    let rgb = [
        layered[0] * radiance[0] * n_dot_l,
        layered[1] * radiance[1] * n_dot_l,
        layered[2] * radiance[2] * n_dot_l,
    ];
    let components = |lobe: [f64; 3], attenuation: f64| -> [f64; 3] {
        std::array::from_fn(|axis| lobe[axis] * attenuation * radiance[axis] * n_dot_l)
    };
    (
        rgb,
        components(scaled_diffuse, coat[0]),
        components(specular, coat[0]),
        std::array::from_fn(|axis| coat[1] * radiance[axis] * n_dot_l),
        components(transmission_lobe, coat[0]),
    )
}

// ===== sheen 原语(materialAdvancedReference.ts 同式)=====

/// three F_Schlick exp2 近似形式。
pub fn f_schlick(f0: f64, cosine: f64) -> f64 {
    let f = ((-5.55473 * cosine - 6.98316) * cosine).exp2();
    f0 * (1.0 - f) + f
}

/// three D_Charlie。
pub fn d_charlie(roughness: f64, nh: f64) -> f64 {
    let inv_alpha = 1.0 / (roughness * roughness);
    let sin2h = (1.0 - nh * nh).max(0.007_812_5);
    (2.0 + inv_alpha) * sin2h.powf(inv_alpha * 0.5) / (2.0 * PI)
}

/// three V_Neubelt。
pub fn v_neubelt(nv: f64, nl: f64) -> f64 {
    (1.0 / (4.0 * (nl + nv - nl * nv).max(1e-6))).clamp(0.0, 1.0)
}

/// three IBLSheenBRDF(Charlie 半球积分拟合)。
pub fn ibl_sheen_brdf(nv: f64, roughness: f64) -> f64 {
    let r2 = roughness * roughness;
    let r_inv = 1.0 / (roughness + 0.1);
    let a = -1.9362 + 1.0678 * roughness + 0.4573 * r2 - 0.8469 * r_inv;
    let b = -0.6014 + 0.5538 * roughness - 0.4670 * r2 - 0.1255 * r_inv;
    (a * nv + b).exp().clamp(0.0, 1.0)
}

/// three 直射 sheen 项:sheenColor·D·V(nl 与 radiance 由调用方乘)。
pub fn sheen_direct_brdf(color: [f64; 3], roughness: f64, nv: f64, nl: f64, nh: f64) -> [f64; 3] {
    let scale = d_charlie(roughness, nh) * v_neubelt(nv, nl);
    map3(color, |value| value * scale)
}

/// 直射能量补偿 1 − max3(color)·max(A(nv), A(nl))。
pub fn sheen_direct_energy(color: [f64; 3], roughness: f64, nv: f64, nl: f64) -> f64 {
    let peak = color[0].max(color[1]).max(color[2]);
    1.0 - peak * ibl_sheen_brdf(nv, roughness).max(ibl_sheen_brdf(nl, roughness))
}

/// 间接能量补偿 1 − max3(color)·A(nv)。
pub fn sheen_indirect_energy(color: [f64; 3], roughness: f64, nv: f64) -> f64 {
    1.0 - color[0].max(color[1]).max(color[2]) * ibl_sheen_brdf(nv, roughness)
}

// ===== native 直射支路镜像(brdfDirectLighting.wgsl / brdfDirectMultiscattering.wgsl)=====

/// r185 直射 DFG 表(16×16,uv=(roughness, dotNV));表值从生产 WGSL
/// directDfgLut185.wgsl 单源解析(跨包 include_str!),与 WGSL 同为 f32 值。
fn direct_dfg_table() -> &'static [[f32; 2]; 256] {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[[f32; 2]; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        const SOURCE: &str = include_str!("../../deep-engine/wgsl/directDfgLut185.wgsl");
        let start = SOURCE.find("array<vec2f, 256>(").expect("dfg table header");
        let body = &SOURCE[start..];
        let end = body.find("\n  );").expect("dfg table tail");
        let mut table = [[0.0f32; 2]; 256];
        let mut index = 0usize;
        for pair in body[..end].split("vec2f(").skip(1) {
            let (a, b) = pair.split_once(",").expect("dfg pair");
            table[index] = [
                a.trim().parse::<f32>().expect("dfg x"),
                b.trim().trim_end_matches(')').trim().parse::<f32>().expect("dfg y"),
            ];
            index += 1;
        }
        assert_eq!(index, 256, "dfg table must hold 256 entries");
        table
    })
}

/// deepDirectDfg185 的 f32 逐式移植(双线性,clamp-to-edge at half-texel)。
pub fn direct_dfg_185(roughness: f64, dot_nv: f64) -> [f32; 2] {
    let table = direct_dfg_table();
    let u = (roughness as f32).clamp(0.0, 1.0) * 16.0 - 0.5;
    let v = (dot_nv as f32).clamp(0.0, 1.0) * 16.0 - 0.5;
    let fu0 = u.floor();
    let fv0 = v.floor();
    let i0 = fu0.clamp(0.0, 15.0) as usize;
    let j0 = fv0.clamp(0.0, 15.0) as usize;
    let i1 = (fu0 + 1.0).clamp(0.0, 15.0) as usize;
    let j1 = (fv0 + 1.0).clamp(0.0, 15.0) as usize;
    let fu = (u - fu0).clamp(0.0, 1.0);
    let fv = (v - fv0).clamp(0.0, 1.0);
    let sample = |j: usize, i: usize| table[j * 16 + i];
    let a00 = sample(j0, i0);
    let a10 = sample(j0, i1);
    let a01 = sample(j1, i0);
    let a11 = sample(j1, i1);
    let mut out = [0.0f32; 2];
    for lane in 0..2 {
        out[lane] = a00[lane] * (1.0 - fu) * (1.0 - fv)
            + a10[lane] * fu * (1.0 - fv)
            + a01[lane] * (1.0 - fu) * fv
            + a11[lane] * fu * fv;
    }
    out
}

/// deepDirectMultiscatteringEnergy(brdfDirectMultiscattering.wgsl 同式)。
pub fn direct_multiscattering_energy(f0: [f64; 3], dfg_view: [f32; 2], dfg_light: [f32; 2]) -> [f64; 3] {
    let view = [dfg_view[0] as f64, dfg_view[1] as f64];
    let light = [dfg_light[0] as f64, dfg_light[1] as f64];
    let single_view: [f64; 3] = std::array::from_fn(|axis| f0[axis] * view[0] + view[1]);
    let single_light: [f64; 3] = std::array::from_fn(|axis| f0[axis] * light[0] + light[1]);
    let lost_view = 1.0 - (view[0] + view[1]);
    let lost_light = 1.0 - (light[0] + light[1]);
    let average_fresnel: [f64; 3] =
        std::array::from_fn(|axis| f0[axis] + (1.0 - f0[axis]) * 0.047_619);
    let multiple: [f64; 3] = std::array::from_fn(|axis| {
        single_view[axis] * single_light[axis] * average_fresnel[axis]
            / (1.0 - lost_view * lost_light * average_fresnel[axis] + 0.000_001)
    });
    map3(multiple, |value| value * (lost_view * lost_light))
}

/// brdfWithDielectricF0(brdfDirectLighting.wgsl 同式;PI 字面量 3.14159265 与
/// WGSL 逐字一致,不用 std 常量)。
#[allow(clippy::too_many_arguments)]
pub fn brdf_with_dielectric_f0(
    n: [f64; 3], v: [f64; 3], l: [f64; 3], base: [f64; 3], metal: f64, rough: f64, dielectric: f64,
) -> [f64; 3] {
    const WGSL_PI: f64 = 3.141_592_65;
    let fresnel = |cosine: f64, f0: [f64; 3]| -> [f64; 3] {
        let factor = ((-5.55473 * cosine - 6.98316) * cosine).exp2();
        std::array::from_fn(|axis| f0[axis] * (1.0 - factor) + factor)
    };
    let h = safe_normalize(add3(v, l), n);
    let nv = dot3(n, v).clamp(0.0001, 1.0);
    let nl = dot3(n, l).clamp(0.0, 1.0);
    let nh = dot3(n, h).clamp(0.0, 1.0);
    let vh = dot3(v, h).clamp(0.0, 1.0);
    let alpha = rough * rough;
    let a2 = alpha * alpha;
    let denom = nh * nh * (a2 - 1.0) + 1.0;
    let distribution = a2 / (WGSL_PI * denom * denom).max(0.000_001);
    let gv = nl * (a2 + (1.0 - a2) * nv * nv).sqrt();
    let gl = nv * (a2 + (1.0 - a2) * nl * nl).sqrt();
    let visibility = 0.5 / (gv + gl).max(0.000_001);
    let f0: [f64; 3] = std::array::from_fn(|axis| dielectric + (base[axis] - dielectric) * metal);
    let f = fresnel(vh, f0);
    let specular: [f64; 3] = std::array::from_fn(|axis| f[axis] * visibility * distribution);
    let diffuse: [f64; 3] = std::array::from_fn(|axis| (1.0 - metal) * base[axis] / WGSL_PI);
    std::array::from_fn(|axis| (diffuse[axis] + specular[axis]) * nl)
}

/// native_direct_multiscattering(native_mesh_v1.wgsl 同式)。
pub fn native_direct_multiscattering(
    normal: [f64; 3], light: [f64; 3], base: [f64; 3], metal: f64, rough: f64, dielectric: f64,
    dfg_view: [f32; 2],
) -> [f64; 3] {
    let nl = dot3(normal, light).clamp(0.0, 1.0);
    if nl <= 0.0 {
        return [0.0; 3];
    }
    let dfg_light = direct_dfg_185(rough, nl);
    scale3(
        direct_multiscattering_energy(
            std::array::from_fn(|axis| dielectric + (base[axis] - dielectric) * metal),
            dfg_view,
            dfg_light,
        ),
        nl,
    )
}

/// native 直射 stock 项:(brdf + multiscatter) × sun × visibility
/// (native_extended_shade 的 stock_direct,rough 先 min(1,clamp+几何粗糙度);
/// GPU 探针腿用,几何粗糙度在恒定法线面上为 0,由调用方传入)。
#[allow(clippy::too_many_arguments)]
pub fn native_stock_direct(
    normal: [f64; 3], view: [f64; 3], light: [f64; 3], base: [f64; 3],
    metal: f64, rough: f64, dielectric: f64, sun: [f64; 3], visibility: f64,
) -> [f64; 3] {
    let nv = dot3(normal, view).clamp(0.001, 1.0);
    let dfg_view = direct_dfg_185(rough, nv);
    let brdf_sum = add3(
        brdf_with_dielectric_f0(normal, view, light, base, metal, rough, dielectric),
        native_direct_multiscattering(normal, light, base, metal, rough, dielectric, dfg_view),
    );
    [
        brdf_sum[0] * sun[0] * visibility,
        brdf_sum[1] * sun[1] * visibility,
        brdf_sum[2] * sun[2] * visibility,
    ]
}

/// native_extended_shade 的合成腿(无 IBL/无局部灯 → original ≡ stock_direct):
/// 返回 (original − stock_direct − emissive)·energyIndirect + direct·energyDirect
/// + sheenDirect + emissive;direct = extended.rgb·visibility(扩展带激活)否则
/// stock_direct。与 WGSL wrapper 逐式同构(合成序见 native_mesh_v1.wgsl 注释)。
#[allow(clippy::too_many_arguments)]
pub fn native_extended_response(
    original: [f64; 3],
    stock_direct: [f64; 3],
    direct_term: [f64; 3],
    emission: [f64; 3],
    sheen_color: [f64; 3],
    sheen_roughness: f64,
    nv: f64,
    nl: f64,
    nh: f64,
    sun: [f64; 3],
    visibility: f64,
) -> [f64; 3] {
    let sheen_peak = sheen_color[0].max(sheen_color[1]).max(sheen_color[2]);
    if sheen_peak <= 0.0 {
        return std::array::from_fn(|axis| original[axis] - stock_direct[axis] + direct_term[axis]);
    }
    let sheen_albedo_view = ibl_sheen_brdf(nv, sheen_roughness);
    let energy_indirect = 1.0 - sheen_peak * sheen_albedo_view;
    let energy_direct =
        1.0 - sheen_peak * sheen_albedo_view.max(ibl_sheen_brdf(nl, sheen_roughness));
    let sheen_brdf = sheen_direct_brdf(sheen_color, sheen_roughness, nv, nl, nh);
    let sheen_direct = [
        sheen_brdf[0] * sun[0] * visibility,
        sheen_brdf[1] * sun[1] * visibility,
        sheen_brdf[2] * sun[2] * visibility,
    ];
    std::array::from_fn(|axis| {
        (original[axis] - stock_direct[axis] - emission[axis]) * energy_indirect
            + direct_term[axis] * energy_direct
            + sheen_direct[axis]
            + emission[axis]
    })
}

/// 扩展带 6 词(TS packExtendedParameterBlock 同序同缺省)。
pub fn extended_band_words(params: ExtendedInputs) -> [f32; 6] {
    [
        params.ior as f32,
        params.clearcoat_factor as f32,
        params.clearcoat_roughness as f32,
        params.anisotropy_strength as f32,
        params.anisotropy_rotation as f32,
        params.transmission_factor as f32,
    ]
}
