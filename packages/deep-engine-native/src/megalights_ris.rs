//! P1 质量主线(六引擎对标刀位 2):native MegaLights 万灯直接光 RIS 的 CPU 权威镜像。
//!
//! 与 TS 权威 `packages/deep-engine/src/lighting/megaLightsRisCpu.ts` 逐式同构
//! (f64 中间量 = JS number 语义;唯 hypot/pow/2**x 跨 libm,由 fixture 哨兵容差
//! 覆盖,见 megalights_parity_tests):
//! - RIS 采样:K=32 候选均匀 i.i.d. → 加权蓄水池 → 时域合并(单候选,深度门)
//!   → 5×5 空间值域无偏平均(法线/深度门,源像素评价 W_src)→ 胜者着色
//!   (可见性 mask 只乘 shade 侧:自路径乘本像素、空间分支乘源像素);
//! - 穷举对拍模式(K≥N 遍历全灯,输出恒等于精确和)与穷举精确参考;
//! - 直射通路选择(≤64 盏走既有簇光快路径 = [`crate::clustered_lighting`],
//!   超出/显式开关走本模块 RIS)——与 TS `resolveDirectLightingPath` 同词汇。
//!
//! 数学出处:Bitterli et al., "Spatiotemporal Reservoir Resampling for
//! Real-Time Ray Tracing with Dynamic Direct Lighting", TOG 2022(公开领域
//! 算法自实现,与 WGSL 单源同款注释)。

pub use crate::megalights_abi::{
    MAX_MEGA_LIGHTS, MEGA_LIGHT_ABI_VERSION, MEGA_LIGHT_KIND_AREA_RECT, MEGA_LIGHT_KIND_POINT,
    MEGA_LIGHT_KIND_SPOT, MEGA_LIGHT_STRIDE_BYTES, MEGA_LIGHT_STRIDE_VEC4, MEGA_LIGHT_WORDS,
    MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET, MEGALIGHTS_DEFAULT_ALPHA_BLEND, MEGALIGHTS_INVALID_LIGHT,
    MEGALIGHTS_RIS_CANDIDATES, MEGALIGHTS_RIS_M, MEGALIGHTS_SPATIAL_NORMAL_GATE,
    MEGALIGHTS_SPATIAL_REUSE_RADIUS, MEGALIGHTS_TEMPORAL_DEPTH_GATE, MegaLight, MegaLightKind,
    MegaLightsFrameConfig, MegaLightsFrameInput, MegaLightsFrameOutput, MegaSurfaceRow,
    PackedMegaLights, RisReservoir, pack_mega_lights, sha256_of_words,
};
pub use crate::megalights_ies::{
    IES_EXPANDED_COLUMNS, IES_TABLE_ROW_STRIDE_VEC4, MegaLightsIesPacking,
    evaluate_ies_shading_factor,
};

// ---- 随机(确定性;与 WGSL deepMega* 与 TS mega* 逐位同式,u32 wrapping) ----

/// 32 位整数哈希(wang hash 家族;TS megaHashU32 逐位)。
pub fn mega_hash_u32(value: u32) -> u32 {
    let mut state = value;
    state = (state ^ 61) ^ (state >> 16);
    state = state.wrapping_add(state << 3);
    state ^= state >> 4;
    state = state.wrapping_mul(0x27d4_eb2d);
    state ^ (state >> 15)
}

/// PCG 输出函数:返回 (新 state, [0,1) 均匀值;TS megaRandomNext 逐位)。
pub fn mega_random_next(state: u32) -> (u32, f64) {
    let next = state.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let word = (next >> ((next >> 28) + 4)) ^ next;
    (next, f64::from(word) / 4_294_967_296.0)
}

/// 确定性像素种子(TS megaPixelSeed 逐位;imul 位型经 wrapping 加法同余)。
pub fn mega_pixel_seed(pixel_index: u32, frame_index: i32, stream: i32) -> u32 {
    mega_hash_u32(pixel_index.wrapping_add(0x9e37_79b9))
        .wrapping_add(frame_index.wrapping_mul(0x85eb_ca6bu32 as i32) as u32)
        .wrapping_add(stream.wrapping_mul(0xc2b2_ae35u32 as i32) as u32)
}

/// 流式 RNG(与 TS openStream 同构;单测直接消费锚值)。
pub(crate) struct RandomStream {
    pub(crate) state: u32,
}

impl RandomStream {
    pub(crate) fn open(pixel_index: u32, frame: u32, stream: u32) -> Self {
        Self {
            state: mega_pixel_seed(pixel_index, frame as i32, stream as i32),
        }
    }
    pub(crate) fn next(&mut self) -> f64 {
        let (state, value) = mega_random_next(self.state);
        self.state = state;
        value
    }
}

// ---- 标量数学(f64;TS 同式。hypot/pow 跨 libm 由 fixture 哨兵覆盖) ----

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// TS Math.hypot 的 Rust 端(跨 libm 哨兵;非位级锚)。
fn hypot3(value: [f64; 3]) -> f64 {
    f64::hypot(f64::hypot(value[0], value[1]), value[2])
}

fn safe_normalize(value: [f64; 3], fallback: [f64; 3]) -> [f64; 3] {
    let length = hypot3(value);
    if length > 1e-8 {
        [value[0] / length, value[1] / length, value[2] / length]
    } else {
        fallback
    }
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    if value < low {
        low
    } else if value > high {
        high
    } else {
        value
    }
}

/// range 衰减(TS megaLightRangeAttenuationCpu 同式)。
pub fn mega_light_range_attenuation(distance_squared: f64, range: f64, decay: f64) -> f64 {
    let falloff = 1.0 / f64::powf(f64::max(f64::sqrt(distance_squared), 1e-8), decay).max(0.01);
    if range == 0.0 {
        return falloff;
    }
    if distance_squared >= range * range {
        return 0.0;
    }
    let ratio_squared = distance_squared / f64::max(range * range, 1e-4);
    let window = f64::max(1.0 - ratio_squared * ratio_squared, 0.0);
    if decay == 2.0 {
        return window * window / f64::max(distance_squared, 0.01);
    }
    window * window * falloff
}

/// 聚光锥 smoothstep(TS megaLightSpotConeCpu 同式)。
pub fn mega_light_spot_cone(cone_cos: f64, outer_cos: f64, cone_scale: f64) -> f64 {
    if cone_scale == 0.0 {
        return if cone_cos >= outer_cos { 1.0 } else { 0.0 };
    }
    let cone_weight = clamp((cone_cos - outer_cos) * cone_scale, 0.0, 1.0);
    cone_weight * cone_weight * (3.0 - 2.0 * cone_weight)
}

/// 面积光「中心点近似」的辐射缩放:半宽×半高×4。
pub fn mega_area_light_extent_factor(light: &MegaLight) -> f64 {
    light.half_extent[0] * light.half_extent[1] * 4.0
}

/// 单灯 BRDF 贡献(TS megaLightBrdfCpu 同式:Lambert + GGX 相关 Smith;
/// fresnelFactor = 2**x 为跨 libm 哨兵位)。
#[allow(clippy::too_many_arguments)]
pub fn mega_light_brdf(
    light: &MegaLight,
    position_view: [f64; 3],
    normal_view: [f64; 3],
    view: [f64; 3],
    base_color: [f64; 3],
    metallic: f64,
    roughness: f64,
    radiance_scale: f64,
) -> [f64; 3] {
    const PI: f64 = std::f64::consts::PI;
    let to_light = [
        light.position_view[0] - position_view[0],
        light.position_view[1] - position_view[1],
        light.position_view[2] - position_view[2],
    ];
    let distance_squared = dot3(to_light, to_light);
    let attenuation = mega_light_range_attenuation(distance_squared, light.range, light.decay);
    if attenuation <= 0.0 {
        return [0.0; 3];
    }
    let surface_to_light = safe_normalize(to_light, normal_view);
    let n_dot_l = clamp(dot3(normal_view, surface_to_light), 0.0, 1.0);
    if n_dot_l <= 0.0 {
        return [0.0; 3];
    }
    let normal = safe_normalize(normal_view, [0.0, 0.0, 1.0]);
    let view_direction = safe_normalize(view, normal);
    let half_vector = safe_normalize(
        [
            view_direction[0] + surface_to_light[0],
            view_direction[1] + surface_to_light[1],
            view_direction[2] + surface_to_light[2],
        ],
        normal,
    );
    let n_dot_v = clamp(dot3(normal, view_direction), 1e-4, 1.0);
    let n_dot_h = clamp(dot3(normal, half_vector), 0.0, 1.0);
    let v_dot_h = clamp(dot3(view_direction, half_vector), 0.0, 1.0);
    let roughness = clamp(roughness, 0.045, 1.0);
    let metallic = clamp(metallic, 0.0, 1.0);
    let base_color = [
        f64::max(base_color[0], 0.0),
        f64::max(base_color[1], 0.0),
        f64::max(base_color[2], 0.0),
    ];
    let f0 = [
        0.04 * (1.0 - metallic) + base_color[0] * metallic,
        0.04 * (1.0 - metallic) + base_color[1] * metallic,
        0.04 * (1.0 - metallic) + base_color[2] * metallic,
    ];
    // TS 2 ** x(WGSL exp2);跨 libm 哨兵。
    let fresnel_factor = f64::powf(2.0, (-5.55473 * v_dot_h - 6.98316) * v_dot_h);
    let fresnel = [
        f0[0] * (1.0 - fresnel_factor) + fresnel_factor,
        f0[1] * (1.0 - fresnel_factor) + fresnel_factor,
        f0[2] * (1.0 - fresnel_factor) + fresnel_factor,
    ];
    let alpha = roughness * roughness;
    let alpha2 = alpha * alpha;
    let denominator = n_dot_h * n_dot_h * (alpha2 - 1.0) + 1.0;
    let distribution = alpha2 / f64::max(PI * denominator * denominator, 1e-6);
    let gv = n_dot_l * f64::sqrt(alpha2 + (1.0 - alpha2) * n_dot_v * n_dot_v);
    let gl = n_dot_v * f64::sqrt(alpha2 + (1.0 - alpha2) * n_dot_l * n_dot_l);
    let visibility = 0.5 / f64::max(gv + gl, 1e-6);
    let diffuse = [
        base_color[0] * (1.0 - metallic) / PI,
        base_color[1] * (1.0 - metallic) / PI,
        base_color[2] * (1.0 - metallic) / PI,
    ];
    let radiance = [
        light.color[0] * light.intensity * attenuation * radiance_scale,
        light.color[1] * light.intensity * attenuation * radiance_scale,
        light.color[2] * light.intensity * attenuation * radiance_scale,
    ];
    [
        (diffuse[0] + distribution * visibility * fresnel[0]) * radiance[0] * n_dot_l,
        (diffuse[1] + distribution * visibility * fresnel[1]) * radiance[1] * n_dot_l,
        (diffuse[2] + distribution * visibility * fresnel[2]) * radiance[2] * n_dot_l,
    ]
}

/// 表面解码(TS megaSurfaceDecodeCpu 同式;w 槽截断 = metallic/roughness 读位)。
pub fn mega_surface_decode(
    surface: &MegaSurfaceRow,
) -> ([f64; 3], [f64; 3], [f64; 3], [f64; 3], f64, f64) {
    let position = [surface[0][0], surface[0][1], surface[0][2]];
    let normal = [surface[1][0], surface[1][1], surface[1][2]];
    let base_color = [surface[2][0], surface[2][1], surface[2][2]];
    let view_length = hypot3(position);
    let view = if view_length > 1e-8 {
        [
            -position[0] / view_length,
            -position[1] / view_length,
            -position[2] / view_length,
        ]
    } else {
        [0.0, 0.0, 1.0]
    };
    (
        position,
        normal,
        view,
        base_color,
        surface[0][3],
        surface[1][3],
    )
}

/// 单灯贡献(TS evaluateMegaLightCpu 同式;ies 缺省恒等——TS CPU oracle
/// 同口径,真 IES 由 `evaluate_mega_light_ies` 注入)。
pub fn evaluate_mega_light(light: &MegaLight, surface: &MegaSurfaceRow) -> [f64; 3] {
    evaluate_mega_light_ies(light, surface, None)
}

/// 单灯贡献 + IES 因子注入(2026-10-06;TS evaluateMegaLightCpu 的 iesFactor 钩子
/// 同位:因子 = evaluate_ies_shading_factor(打包字节, 行号, 打包方向, surfaceToLight),
/// 乘在 cone 侧——目标权重与胜者着色同变,与 WGSL deepMegaContribution 一致;
/// ies=None 或灯无行号 → 恒 1.0,与 v1 逐位一致)。
pub fn evaluate_mega_light_ies(
    light: &MegaLight,
    surface: &MegaSurfaceRow,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> [f64; 3] {
    let (position, normal, view, base_color, metallic, roughness) = mega_surface_decode(surface);
    if light.kind == MegaLightKind::AreaRect {
        let to_surface = [
            position[0] - light.position_view[0],
            position[1] - light.position_view[1],
            position[2] - light.position_view[2],
        ];
        let facing = dot3(
            to_surface,
            safe_normalize(light.direction_view, [0.0, 0.0, 1.0]),
        );
        if !light.two_sided && facing < 0.0 {
            return [0.0; 3];
        }
        if light.range > 0.0 && hypot3(to_surface) > light.range {
            return [0.0; 3];
        }
        return mega_light_brdf(
            light,
            position,
            normal,
            view,
            base_color,
            metallic,
            roughness,
            mega_area_light_extent_factor(light),
        );
    }
    let to_light = [
        light.position_view[0] - position[0],
        light.position_view[1] - position[1],
        light.position_view[2] - position[2],
    ];
    let distance = f64::max(hypot3(to_light), 1e-8);
    // surfaceToLight 提升到锥分支外(与 TS 同位:IES 钩子与锥共用同一单位向量)。
    let surface_to_light = [
        to_light[0] / distance,
        to_light[1] / distance,
        to_light[2] / distance,
    ];
    let mut cone = 1.0;
    if light.kind == MegaLightKind::Spot {
        let direction = safe_normalize(light.direction_view, [0.0, 0.0, 1.0]);
        let cone_scale = if light.inner_cone_cos == light.outer_cone_cos {
            0.0
        } else {
            1.0 / (light.inner_cone_cos - light.outer_cone_cos)
        };
        cone = mega_light_spot_cone(
            -dot3(surface_to_light, direction),
            light.outer_cone_cos,
            cone_scale,
        );
    }
    if cone <= 0.0 {
        return [0.0; 3];
    }
    let ies_factor = match (ies, light.ies_spot_index) {
        (Some(packing), Some(row)) => evaluate_ies_shading_factor(
            packing,
            row as usize,
            safe_normalize(light.direction_view, [0.0, 0.0, 1.0]),
            surface_to_light,
        ),
        _ => 1.0,
    };
    mega_light_brdf(
        light,
        position,
        normal,
        view,
        base_color,
        metallic,
        roughness,
        cone * ies_factor,
    )
}

/// 目标权重 = luminance(全量单灯贡献)。
pub fn mega_target_weight(lights: &[MegaLight], surface: &MegaSurfaceRow, index: usize) -> f64 {
    mega_target_weight_ies(lights, surface, index, None)
}

/// 目标权重(IES 注入版;`ies` 缺省 None = 恒 1)。
pub fn mega_target_weight_ies(
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    index: usize,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> f64 {
    let contribution = evaluate_mega_light_ies(&lights[index], surface, ies);
    0.2126 * contribution[0] + 0.7152 * contribution[1] + 0.0722 * contribution[2]
}

/// 胜者着色(可见性因子乘 shade 侧;缺省 1.0 = M1 恒 1 行为)。
pub fn mega_shade_winner(
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    index: usize,
    visibility: f64,
) -> [f64; 3] {
    mega_shade_winner_ies(lights, surface, index, visibility, None)
}

/// 胜者着色(IES 注入版;可见性乘 shade 侧、IES 乘 cone 侧,与 WGSL 同位)。
pub fn mega_shade_winner_ies(
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    index: usize,
    visibility: f64,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> [f64; 3] {
    let shade = evaluate_mega_light_ies(&lights[index], surface, ies);
    [
        shade[0] * visibility,
        shade[1] * visibility,
        shade[2] * visibility,
    ]
}

/// 视深(视空间 -z;相似门用)。
pub fn mega_view_depth(surface: &MegaSurfaceRow) -> f64 {
    -surface[0][2]
}

// ---- 蓄水池(TS mergeReservoirCpu/finishReservoirCpu 同式) ----

/// 加权蓄水池合并(m 带权累积 + 单均匀值竞选)。
pub fn merge_reservoir(
    reservoir: &mut RisReservoir,
    weight: f64,
    winner: u32,
    count: u32,
    uniform: f64,
) {
    if count == 0 || weight <= 0.0 {
        return;
    }
    let added = weight * f64::from(count);
    let total = reservoir.weight_sum + added;
    if uniform * total < added {
        reservoir.winner = winner;
    }
    reservoir.weight_sum = total;
    reservoir.m += count;
}

/// 蓄水池收尾:W_Y = N × w_sum/(M × t_y)(胜者目标权重在本像素重评价)。
pub fn finish_reservoir(
    reservoir: &RisReservoir,
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    light_count: usize,
) -> f64 {
    if reservoir.winner == MEGALIGHTS_INVALID_LIGHT || reservoir.m == 0 {
        return 0.0;
    }
    let winner_weight = mega_target_weight(lights, surface, reservoir.winner as usize);
    if winner_weight <= 0.0 {
        return 0.0;
    }
    f64::from(light_count as u32) * reservoir.weight_sum / (f64::from(reservoir.m) * winner_weight)
}

// ---- 趟一:K 候选 + 时域合并 ----

fn temporal_previous_pixel(
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    motion_uv: Option<&[f64]>,
) -> i64 {
    let motion = match motion_uv {
        Some(motion) => motion,
        None => return -1,
    };
    let index = (y * width + x) as usize;
    let px = f64::from(x) + 0.5 + motion.get(index * 2).copied().unwrap_or(0.0);
    let py = f64::from(y) + 0.5 + motion.get(index * 2 + 1).copied().unwrap_or(0.0);
    let ix = px.floor();
    let iy = py.floor();
    if ix < 0.0 || iy < 0.0 || ix >= f64::from(width) || iy >= f64::from(height) {
        return -1;
    }
    i64::from(iy as u32) * i64::from(width) + i64::from(ix as u32)
}

fn depth_gate(depth: f64, other_depth: f64) -> bool {
    (depth - other_depth).abs() <= MEGALIGHTS_TEMPORAL_DEPTH_GATE * f64::max(depth, other_depth)
}

/// 趟一(TS buildReservoirPassCpu 同式:RNG 短路语义一致——穷举模式候选不消费
/// 随机流,merge uniform 仅 weight>0 时消费)。
pub fn build_reservoir_pass(input: &MegaLightsFrameInput) -> Vec<RisReservoir> {
    let width = input.config.width;
    let height = input.config.height;
    let light_count = input.lights.len();
    let ies = input.ies;
    let requested = input
        .config
        .candidate_count
        .unwrap_or(MEGALIGHTS_RIS_CANDIDATES);
    let candidate_count = if input.config.exhaustive {
        f64::max(f64::from(requested), light_count as f64) as u32
    } else {
        requested
    };
    let temporal = input.config.temporal
        && input
            .previous
            .is_some_and(|previous| previous.len() == (width * height) as usize);
    let mut reservoirs = vec![RisReservoir::default(); (width * height) as usize];
    for y in 0..height {
        for x in 0..width {
            let pixel_index = (y * width + x) as usize;
            let surface = &input.surfaces[pixel_index];
            let mut stream = RandomStream::open(pixel_index as u32, input.frame, 0);
            let mut reservoir = RisReservoir::default();
            for k in 0..candidate_count {
                // 穷举模式第 k 个候选恒 k(遍历全灯;TS 三元短路:不消费随机流);
                // 随机模式均匀 i.i.d.。
                let candidate = if input.config.exhaustive && k < light_count as u32 {
                    k
                } else {
                    f64::min(
                        f64::from(light_count as u32) - 1.0,
                        f64::floor(stream.next() * f64::from(light_count as u32)),
                    ) as u32
                };
                let weight = mega_target_weight_ies(input.lights, surface, candidate as usize, ies);
                if weight > 0.0 {
                    merge_reservoir(&mut reservoir, weight, candidate, 1, stream.next());
                }
            }
            if temporal {
                let previous_index = temporal_previous_pixel(x, y, width, height, input.motion_uv);
                if previous_index >= 0 {
                    let previous = input.previous.expect("temporal implies previous");
                    let history = previous[previous_index as usize];
                    let previous_surface = &input.surfaces[previous_index as usize];
                    let depth = mega_view_depth(surface);
                    let previous_depth = mega_view_depth(previous_surface);
                    let gate = previous_depth > 0.0
                        && (depth - previous_depth).abs()
                            <= MEGALIGHTS_TEMPORAL_DEPTH_GATE * f64::max(depth, previous_depth);
                    if history.winner != MEGALIGHTS_INVALID_LIGHT && gate {
                        let weight = mega_target_weight_ies(
                            input.lights,
                            surface,
                            history.winner as usize,
                            ies,
                        );
                        // 历史胜者按**单候选**合并(2026-10-04 定案:克隆计权产生持久
                        // 像素偏置;单候选合并不偏,方差收敛交颜色 EMA)。
                        merge_reservoir(&mut reservoir, weight, history.winner, 1, stream.next());
                    }
                }
            }
            reservoirs[pixel_index] = reservoir;
        }
    }
    reservoirs
}

// ---- 趟二:5×5 空间值域无偏平均 + 胜者着色 ----

/// 空间值域无偏平均(TS spatialUnbiasedAverageCpu 同式;返回 None = 无有效源)。
#[allow(clippy::too_many_arguments)]
fn spatial_unbiased_average(
    lights: &[MegaLight],
    surfaces: &[MegaSurfaceRow],
    surface: &MegaSurfaceRow,
    built: &[RisReservoir],
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    radius: i32,
    light_count: usize,
    visibility: Option<&[f32]>,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> Option<[f64; 3]> {
    let mut acc = [0.0f64; 3];
    let mut sources = 0u32;
    let normal = [surface[1][0], surface[1][1], surface[1][2]];
    let depth = mega_view_depth(surface);
    for offset_y in -radius..=radius {
        for offset_x in -radius..=radius {
            let nx = x as i64 + i64::from(offset_x);
            let ny = y as i64 + i64::from(offset_y);
            if nx < 0 || ny < 0 || nx >= i64::from(width) || ny >= i64::from(height) {
                continue;
            }
            let source_index = (ny as u32) * width + (nx as u32);
            let source = built[source_index as usize];
            if source.winner == MEGALIGHTS_INVALID_LIGHT || source.m == 0 {
                continue;
            }
            let source_surface = &surfaces[source_index as usize];
            // 相似门:法线点积 + 视深(TS spatialGateCpu 同式)。
            let source_depth = mega_view_depth(source_surface);
            let normal_dot = dot3(
                normal,
                [
                    source_surface[1][0],
                    source_surface[1][1],
                    source_surface[1][2],
                ],
            );
            if normal_dot < MEGALIGHTS_SPATIAL_NORMAL_GATE || !depth_gate(depth, source_depth) {
                continue;
            }
            // 源像素目标权重(W 公式的分母;无偏恒等式要求在**源像素**评价)。
            let source_target =
                mega_target_weight_ies(lights, source_surface, source.winner as usize, ies);
            if source_target <= 0.0 {
                continue;
            }
            let source_weight = f64::from(light_count as u32) * source.weight_sum
                / (f64::from(source.m) * source_target);
            // 源像素可见性复用(过门传递;ReSTIR DI visibility reuse 惯例)。
            let source_visibility = visibility
                .and_then(|mask| mask.get(source_index as usize).copied())
                .unwrap_or(1.0);
            let shade = mega_shade_winner_full(
                lights,
                surface,
                source.winner as usize,
                f64::from(source_visibility),
                ies,
            );
            acc[0] += shade[0] * source_weight;
            acc[1] += shade[1] * source_weight;
            acc[2] += shade[2] * source_weight;
            sources += 1;
        }
    }
    (sources > 0).then(|| {
        [
            acc[0] / f64::from(sources),
            acc[1] / f64::from(sources),
            acc[2] / f64::from(sources),
        ]
    })
}

/// 胜者着色(全量几何;spatial 分支与本像素着色共用)。
fn mega_shade_winner_full(
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    index: usize,
    visibility: f64,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> [f64; 3] {
    mega_shade_winner_ies(lights, surface, index, visibility, ies)
}

/// 趟二(TS reuseAndShadePassCpu 同式):5×5 空间值域平均 + self 回落 + 颜色 EMA。
pub fn reuse_and_shade_pass(
    input: &MegaLightsFrameInput,
    built: &[RisReservoir],
) -> MegaLightsFrameOutput {
    let width = input.config.width;
    let height = input.config.height;
    let light_count = input.lights.len();
    let ies = input.ies;
    let spatial = input.config.spatial && !input.config.exhaustive;
    let radius = MEGALIGHTS_SPATIAL_REUSE_RADIUS;
    let mut color = vec![0.0f32; (width * height * 3) as usize];
    let mut reservoirs = vec![RisReservoir::default(); (width * height) as usize];
    for y in 0..height {
        for x in 0..width {
            let pixel_index = (y * width + x) as usize;
            let surface = &input.surfaces[pixel_index];
            // 趟二不再改写蓄水池:输出 reservoir 保持趟一 self 状态(下一帧时域
            // 历史只消费 winner/无效位)。
            let reservoir = built[pixel_index];
            reservoirs[pixel_index] = reservoir;
            if input.config.exhaustive {
                // 穷举对拍模式:逐灯求和(⑤ 退化一致性腿;IES 随贡献同位消费,
                // 与 WGSL 穷举分支一致;无 EMA,与 TS 同序)。
                let mut total = [0.0f64; 3];
                for index in 0..light_count {
                    let contribution =
                        mega_shade_winner_ies(input.lights, surface, index, 1.0, ies);
                    total[0] += contribution[0];
                    total[1] += contribution[1];
                    total[2] += contribution[2];
                }
                color[pixel_index * 3] = total[0] as f32;
                color[pixel_index * 3 + 1] = total[1] as f32;
                color[pixel_index * 3 + 2] = total[2] as f32;
                continue;
            }
            let (r, g, b) = if spatial {
                match spatial_unbiased_average(
                    input.lights,
                    input.surfaces,
                    surface,
                    built,
                    x,
                    y,
                    width,
                    height,
                    radius,
                    light_count,
                    input.visibility,
                    ies,
                ) {
                    Some(averaged) => (averaged[0], averaged[1], averaged[2]),
                    None => self_reservoir_shade(
                        input.lights,
                        surface,
                        &reservoir,
                        light_count,
                        input.visibility,
                        pixel_index,
                        ies,
                    ),
                }
            } else {
                self_reservoir_shade(
                    input.lights,
                    surface,
                    &reservoir,
                    light_count,
                    input.visibility,
                    pixel_index,
                    ies,
                )
            };
            // 颜色时域 EMA(首帧 previousColor 缺省 = 全量替换;只看 config.temporal)。
            let (r, g, b) = if input.config.temporal {
                match input.previous_color {
                    Some(previous) => {
                        let alpha = input
                            .config
                            .alpha_blend
                            .unwrap_or(MEGALIGHTS_DEFAULT_ALPHA_BLEND);
                        let pr = f64::from(previous[pixel_index * 3]);
                        let pg = f64::from(previous[pixel_index * 3 + 1]);
                        let pb = f64::from(previous[pixel_index * 3 + 2]);
                        (
                            pr + (r - pr) * alpha,
                            pg + (g - pg) * alpha,
                            pb + (b - pb) * alpha,
                        )
                    }
                    None => (r, g, b),
                }
            } else {
                (r, g, b)
            };
            color[pixel_index * 3] = r as f32;
            color[pixel_index * 3 + 1] = g as f32;
            color[pixel_index * 3 + 2] = b as f32;
        }
    }
    MegaLightsFrameOutput { color, reservoirs }
}

/// self reservoir 着色(spatial 关闭或无有效源回落;可见性乘本像素 mask)。
#[allow(clippy::too_many_arguments)]
fn self_reservoir_shade(
    lights: &[MegaLight],
    surface: &MegaSurfaceRow,
    reservoir: &RisReservoir,
    light_count: usize,
    visibility: Option<&[f32]>,
    pixel_index: usize,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> (f64, f64, f64) {
    if reservoir.winner == MEGALIGHTS_INVALID_LIGHT || reservoir.m == 0 {
        return (0.0, 0.0, 0.0);
    }
    let self_visibility = visibility
        .and_then(|mask| mask.get(pixel_index).copied())
        .unwrap_or(1.0);
    let shade = mega_shade_winner_ies(
        lights,
        surface,
        reservoir.winner as usize,
        f64::from(self_visibility),
        ies,
    );
    let weight_y = mega_target_weight_ies(lights, surface, reservoir.winner as usize, ies);
    if weight_y <= 0.0 {
        return (0.0, 0.0, 0.0);
    }
    let scale_y =
        f64::from(light_count as u32) * reservoir.weight_sum / (f64::from(reservoir.m) * weight_y);
    (shade[0] * scale_y, shade[1] * scale_y, shade[2] * scale_y)
}

/// 整帧(CPU 镜像入口):趟一 + 趟二。
pub fn mega_lights_frame(input: &MegaLightsFrameInput) -> MegaLightsFrameOutput {
    let built = build_reservoir_pass(input);
    reuse_and_shade_pass(input, &built)
}

/// 穷举精确参考(验收②真值端):逐灯求和 = 零方差真值(无遮挡精确和;
/// `ies` 缺省恒等,帧内穷举腿与参考须同口径消费)。
pub fn mega_lights_exhaustive_reference(
    lights: &[MegaLight],
    surfaces: &[MegaSurfaceRow],
    width: u32,
    height: u32,
) -> Vec<f32> {
    mega_lights_exhaustive_reference_ies(lights, surfaces, width, height, None)
}

/// 穷举精确参考(IES 注入版;与 WGSL 穷举分支同口径)。
pub fn mega_lights_exhaustive_reference_ies(
    lights: &[MegaLight],
    surfaces: &[MegaSurfaceRow],
    width: u32,
    height: u32,
    ies: Option<&MegaLightsIesPacking<'_>>,
) -> Vec<f32> {
    let mut color = vec![0.0f32; (width * height * 3) as usize];
    for pixel in 0..(width * height) as usize {
        let surface = &surfaces[pixel];
        let mut total = [0.0f64; 3];
        for index in 0..lights.len() {
            let shade = mega_shade_winner_ies(lights, surface, index, 1.0, ies);
            total[0] += shade[0];
            total[1] += shade[1];
            total[2] += shade[2];
        }
        color[pixel * 3] = total[0] as f32;
        color[pixel * 3 + 1] = total[1] as f32;
        color[pixel * 3 + 2] = total[2] as f32;
    }
    color
}

/// RMSE(线性 RGB,逐通道平方均值开根)。
pub fn rmse(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len(), "rmse length mismatch");
    let mut total = 0.0f64;
    for index in 0..a.len() {
        let d = f64::from(a[index]) - f64::from(b[index]);
        total += d * d;
    }
    f64::sqrt(total / a.len() as f64)
}

// ---- 直射通路选择(与 TS resolveDirectLightingPath 同词汇) ----

/// 直射通路(簇光快路径 = clustered_lighting 逐灯;RIS = 本模块)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectLightingPath {
    ClusterForwardPlus,
    MegalightsRis,
}

/// 决策依据(词汇封闭,与 TS 同)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectLightingPathReason {
    WithinClusterBudget,
    LightCountExceedsClusterBudget,
    MegalightsForced,
}

/// 通路决策结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DirectLightingPathDecision {
    pub path: DirectLightingPath,
    pub reason: DirectLightingPathReason,
    pub local_light_count: usize,
    pub area_count: usize,
}

/// 直射通路选择:≤预算走既有簇光快路径(逐灯着色,零回归),超预算或显式开关
/// 走 MegaLights RIS(每像素常数次采样,成本与灯数解耦)。
pub fn resolve_direct_lighting_path(
    points: usize,
    spots: usize,
    areas: usize,
    force_mega_lights: bool,
    cluster_budget: Option<usize>,
) -> DirectLightingPathDecision {
    let cluster_budget = cluster_budget.unwrap_or(MEGALIGHTS_CLUSTER_PATH_LIGHT_BUDGET);
    assert!(
        (1..=MAX_MEGA_LIGHTS).contains(&cluster_budget),
        "cluster budget out of range"
    );
    let local_light_count = points + spots;
    let area_count = areas;
    if force_mega_lights {
        return DirectLightingPathDecision {
            path: DirectLightingPath::MegalightsRis,
            reason: DirectLightingPathReason::MegalightsForced,
            local_light_count,
            area_count,
        };
    }
    if local_light_count > cluster_budget {
        return DirectLightingPathDecision {
            path: DirectLightingPath::MegalightsRis,
            reason: DirectLightingPathReason::LightCountExceedsClusterBudget,
            local_light_count,
            area_count,
        };
    }
    DirectLightingPathDecision {
        path: DirectLightingPath::ClusterForwardPlus,
        reason: DirectLightingPathReason::WithinClusterBudget,
        local_light_count,
        area_count,
    }
}
