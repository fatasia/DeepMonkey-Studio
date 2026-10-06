//! Brief-GI native 探针 SH 更新链(CPU 权威镜像)。
//!
//! 唯一语义源 = Web `deep-engine/src/gi/probeShUpdate.ts` + `probeSkyVisibilitySh.ts`
//! + `sdfGiPacking.ts`(窗口计划/命中统计归约/记录初值)。链路:天光可见度向量 →
//! L1 SH 投影 → 目标场(可见度加权天空 + SSGDI 叠加 + 静态 1 bounce 哨兵)→
//! 时域滤波 α → 96B [`crate::probe_gi_abi::IrradianceProbeRecord`](与既有 probe_gi
//! 骨架的组合点:记录经 `validate()`/`pack_records` 直供 storage 合同)。
//!
//! == F5 合同不动 ==
//! record 的 `reserved`(words[12..23] RGB L1 SH 方向可见度)本链**绝不写**
//! ——保持全零 =「SH 缺失」,白炉 gate≡1 逐位负控与 F5-L5 三区哨兵的输入面零变化;
//! `occlusionFloor` 写可见度均值 c0。生产 GPU 核(`wgsl/sdfGiProbeUpdate.wgsl`,
//! 经 [`crate::sdf_gi_wgsl`] 消费)同合同。
//!
//! == 白炉稳定性(TS 域同款)==
//! 均匀天空 + 全开可见度时 target ≡ E;稳态场在任意 α 下逐位不动(lerp 不动点)。

// 探针更新链:GPU dispatch 与 renderer 生产接线在后继切片,合同与对拍先行落库。
#![allow(dead_code)]

use crate::probe_gi_abi::IrradianceProbeRecord;
use crate::sdf_gi_scene::{fround, hypot3};

/** 探针场时域滤波缺省系数(Brief-GI M1:α≈0.1)。 */
pub const DEEP_GI_PROBE_TEMPORAL_ALPHA: f64 = 0.1;
/// α 解析下限(>0 保收敛方向;再低等价关闭,直接给 0.1)。
pub const DEEP_GI_PROBE_TEMPORAL_ALPHA_MIN: f64 = 0.01;
/// bounce 能量哨兵上限(ρ≤1 物理上界 ×2,+1% 余量;与 TS/WGSL 同值)。
pub const BOUNCE_ENERGY_LIMIT: f64 = 2.01;
/// 96B 记录 ABI 的 vec4 步长(=6;与 WGSL `SDF_GI_PROBE_RECORD_VEC4_STRIDE` 互钉)。
pub const SDF_GI_PROBE_RECORD_VEC4_STRIDE: usize = 6;
/// ProbeUpdateParams uniform 字节(WGSL struct 对齐舍入;与 TS
/// `SDF_GI_PROBE_UPDATE_PARAMS_BYTES` 互钉)。
pub const SDF_GI_PROBE_UPDATE_PARAMS_BYTES: usize = 64;
/// workgroup 尺寸(每 lane = 更新窗口内的一个探针)。
pub const SDF_GI_PROBE_UPDATE_WORKGROUP_SIZE: u32 = 64;
/// SH 系数数(l0 + L1 三轴)。
pub const SKY_VISIBILITY_SH_COEFFICIENTS: usize = 4;

/// 单探针天光可见度 L1 SH:(c0, d_y, d_z, d_x)(与 TS `SkyVisibilitySh` 同构)。
pub type SkyVisibilitySh = [f64; 4];

/// α 解析(fail-closed):非法/缺省回 0.1(TS `resolveDeepGiTemporalAlpha` 镜像)。
pub fn resolve_deep_gi_temporal_alpha(value: Option<f64>) -> f64 {
    match value {
        None => DEEP_GI_PROBE_TEMPORAL_ALPHA,
        Some(value) => {
            if !value.is_finite() || !(DEEP_GI_PROBE_TEMPORAL_ALPHA_MIN..=1.0).contains(&value) {
                DEEP_GI_PROBE_TEMPORAL_ALPHA
            } else {
                value
            }
        }
    }
}

/// 可见度向量 → L1 SH(TS `projectSkyVisibilitySh` 逐式镜像):c0 顺序累加,
/// dipoles = (3/N)·Σ(v−c0)·dir;均匀场精确零 dipole(白炉逐位负控的构造性保证)。
/// 值域越界([0,1] 外)/非有限 fail-fast(上游合同破坏必须在此暴露)。
pub fn project_sky_visibility_sh(visibilities: &[f64], directions: &[[f64; 3]]) -> SkyVisibilitySh {
    assert_eq!(
        visibilities.len(),
        directions.len(),
        "Sky visibility SH projection needs one direction per visibility sample."
    );
    assert!(
        !directions.is_empty(),
        "Sky visibility SH needs at least one direction."
    );
    let mut c0 = 0.0f64;
    for value in visibilities {
        assert!(
            value.is_finite() && (0.0..=1.0).contains(value),
            "Sky visibility samples must be finite in [0, 1]."
        );
        c0 += value;
    }
    c0 /= directions.len() as f64;
    let mut sum_y = 0.0f64;
    let mut sum_z = 0.0f64;
    let mut sum_x = 0.0f64;
    for (direction, value) in directions.iter().zip(visibilities) {
        let centered = value - c0;
        sum_y += centered * direction[1];
        sum_z += centered * direction[2];
        sum_x += centered * direction[0];
    }
    let count = directions.len() as f64;
    [
        c0,
        3.0 * sum_y / count,
        3.0 * sum_z / count,
        3.0 * sum_x / count,
    ]
}

/// SH 重建(TS `evaluateSkyVisibilitySh` 同族核 (1, y, z, x);负值截断 0)。
pub fn evaluate_sky_visibility_sh(sh: &SkyVisibilitySh, direction: [f64; 3]) -> f64 {
    (sh[0] + sh[1] * direction[1] + sh[2] * direction[2] + sh[3] * direction[0]).max(0.0)
}

/// 上一帧探针记录切片(与 TS IrradianceProbeRecord 的数值面同构;f64 承载)。
/// F5 words[12..23] 不在切片里:native 链的 SH 缺失合同恒全零(生产者从不写,
/// 透传语义平凡成立;见 `probe_gi_abi` validate 的全零校验)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProbeShPreviousRecord {
    pub irradiance: [f64; 3],
    pub validity: f64,
    pub mean_distance: f64,
    pub distance_variance: f64,
    pub occlusion_floor: f64,
    pub position_offset: [f64; 3],
}

/// 探针 SH 更新输入(TS `ProbeShUpdateInput` 同构;f64 承载,可见度切片为
/// f32 精确值)。
pub struct ProbeShUpdateInput<'a> {
    /// 上一帧探针记录(同序;None = 新探针首帧)。
    pub previous: &'a [Option<ProbeShPreviousRecord>],
    /// 天光方向集(Fibonacci CPU 权威;与可见度/天空辐射逐下标对齐)。
    pub directions: &'a [[f64; 3]],
    /// 每探针逐方向天光可见度(trace 输出,f32 精确;长度 = N×directions)。
    pub visibilities: &'a [f32],
    /// 每方向天空辐射(线性 RGB)。
    pub direction_sky_radiance: &'a [[f64; 3]],
    /// SSGDI 输入(可选;None 探针跳过该项)。
    pub ssgdi: &'a [Option<[f64; 3]>],
    /// 静态 1 bounce 均匀反照率(可选,线性 RGB ∈[0,1]);None = 关。
    pub bounce_albedo: Option<[f64; 3]>,
    /// 时域滤波 α;None/非法经 [`resolve_deep_gi_temporal_alpha`] 回 0.1。
    pub alpha: Option<f64>,
    /// 逐探针几何统计 [meanDistance, distanceVariance];None 沿用 previous 或有界缺省。
    pub geometry_stats: Option<&'a [(f64, f64)]>,
}

/// 探针 SH 更新结果(TS `ProbeShUpdateResult` 同构)。
pub struct ProbeShUpdateResult {
    /// 更新后的探针记录(f32 落盘;既有 96B ABI 类型,F5 words[12..23] 全零透传)。
    pub records: Vec<IrradianceProbeRecord>,
    /// f64 链式语义面(TS 对拍面):TS CPU 链以 f64 记录对象跨帧传递,
    /// 时域多帧级联必须喂本面而非 f32 落盘面(否则逐帧引入 f32 量化)。
    pub records_f64: Vec<ProbeShPreviousRecord>,
    /// 每探针天光可见度 L1 SH(投影产物,时域滤波后;埋入探针为 None)。
    pub sky_visibility_sh: Vec<Option<SkyVisibilitySh>>,
    pub alpha: f64,
    /// 静态 bounce 哨兵触发数(fail-closed 回基线的探针数;0 = 正常)。
    pub bounce_sentinel_trips: usize,
    /// 目标场能量之和(bounce 后;哨兵证据链;fround 落点)。
    pub target_energy: f64,
}

/// f64 记录面 → f32 ABI 落盘(与 TS `packIrradianceProbeRecord` 的逐字段 f32
/// 转换同构:irradiance/validity/meanDistance/variance/floor/relocation)。
pub fn record_to_abi(record: &ProbeShPreviousRecord) -> IrradianceProbeRecord {
    IrradianceProbeRecord {
        irradiance: [
            record.irradiance[0] as f32,
            record.irradiance[1] as f32,
            record.irradiance[2] as f32,
        ],
        validity: record.validity as f32,
        mean_distance: record.mean_distance as f32,
        distance_variance: record.distance_variance as f32,
        occlusion_floor: record.occlusion_floor as f32,
        padding: 0.0,
        position_offset: [
            record.position_offset[0] as f32,
            record.position_offset[1] as f32,
            record.position_offset[2] as f32,
        ],
        position_padding: 0.0,
        reserved: [0.0; 12],
    }
}

/// 探针 SH 更新(天光遮蔽 + SSGDI 输入 + 时域滤波;TS `updateProbeShWithSdfGi`
/// 逐式镜像)。确定性:无 RNG,同输入逐位同输出;输入不变异。
pub fn update_probe_sh_with_sdf_gi(input: &ProbeShUpdateInput<'_>) -> ProbeShUpdateResult {
    assert_eq!(
        input.previous.len(),
        input.positions_len(),
        "Probe SH update requires one previous record per probe position."
    );
    let direction_count = input.directions.len();
    assert!(
        direction_count > 0
            && input.direction_sky_radiance.len() == direction_count
            && input.visibilities.len() == input.positions_len() * direction_count,
        "Probe SH update direction/visibility arrays are misaligned."
    );
    assert!(
        input
            .direction_sky_radiance
            .iter()
            .all(|radiance| { radiance.iter().all(|value| value.is_finite()) }),
        "Probe SH update sky radiance must be finite RGB."
    );
    let alpha = resolve_deep_gi_temporal_alpha(input.alpha);
    let mut sky_visibility_sh = Vec::with_capacity(input.positions_len());
    let mut records = Vec::with_capacity(input.positions_len());
    let mut records_f64 = Vec::with_capacity(input.positions_len());
    let (mut bounce_sentinel_trips, mut target_energy) = (0usize, 0.0f64);
    for probe in 0..input.positions_len() {
        let previous = &input.previous[probe];
        // 埋入探针(validity 0):不更新,原样透传(泄露哨兵;occlusionFloor/
        // positionOffset 随记录保留,与 TS push(previous) 逐字段一致)。
        if let Some(previous) = previous.filter(|record| record.validity == 0.0) {
            records_f64.push(previous);
            records.push(record_to_abi(&previous));
            sky_visibility_sh.push(None);
            continue;
        }
        let slice = probe_visibility_slice(input.visibilities, probe, direction_count);
        let sh = project_sky_visibility_sh(&slice, input.directions);
        let target = target_irradiance(
            &slice,
            input.direction_sky_radiance,
            input.ssgdi.get(probe).and_then(|value| *value),
        );
        let guarded = apply_static_bounce(target, input.bounce_albedo);
        if guarded.tripped {
            bounce_sentinel_trips += 1;
        }
        let final_target = guarded.radiance;
        target_energy += hypot3(final_target[0], final_target[1], final_target[2]);
        let blended: [f64; 3] = match previous {
            None => final_target,
            Some(previous) => [
                previous.irradiance[0] + (final_target[0] - previous.irradiance[0]) * alpha,
                previous.irradiance[1] + (final_target[1] - previous.irradiance[1]) * alpha,
                previous.irradiance[2] + (final_target[2] - previous.irradiance[2]) * alpha,
            ],
        };
        let stats = input.geometry_stats.and_then(|stats| stats.get(probe));
        let default_mean = previous.map_or(1_000.0, |record| record.mean_distance);
        let default_variance = previous.map_or(0.0, |record| record.distance_variance);
        // TS 更新结果是"新鲜对象":positionOffset 不在其中(打包零);
        // occlusionFloor = c0;F5 words 不在结果对象(全零)。
        let updated = ProbeShPreviousRecord {
            irradiance: blended,
            validity: previous.map_or(1.0, |record| record.validity),
            mean_distance: stats.map_or(default_mean, |stat| stat.0),
            distance_variance: stats.map_or(default_variance, |stat| stat.1),
            occlusion_floor: sh[0],
            position_offset: [0.0; 3],
        };
        records_f64.push(updated);
        records.push(record_to_abi(&updated));
        sky_visibility_sh.push(Some(sh));
    }
    ProbeShUpdateResult {
        records,
        records_f64,
        sky_visibility_sh,
        alpha,
        bounce_sentinel_trips,
        target_energy: fround(target_energy),
    }
}

impl<'a> ProbeShUpdateInput<'a> {
    /// TS 侧 previous 与 positions 逐位对齐(单参合同;native 输入面同构)。
    fn positions_len(&self) -> usize {
        self.previous.len()
    }
}

/// 单探针切片的可见度子数组视图(TS `probeVisibilitySlice` 同构;f32 → f64 提升)。
pub fn probe_visibility_slice(
    visibilities: &[f32],
    probe_index: usize,
    direction_count: usize,
) -> Vec<f64> {
    visibilities[probe_index * direction_count..(probe_index + 1) * direction_count]
        .iter()
        .map(|value| f64::from(*value))
        .collect()
}

/// 目标场:天光可见度加权的方向均值 + SSGDI 叠加(TS `targetIrradiance` 同式同序)。
fn target_irradiance(
    slice: &[f64],
    sky_radiance: &[[f64; 3]],
    ssgdi: Option<[f64; 3]>,
) -> [f64; 3] {
    let mut rgb = [0.0f64; 3];
    for (index, value) in slice.iter().enumerate() {
        let radiance = sky_radiance[index];
        for axis in 0..3 {
            rgb[axis] += value * radiance[axis];
        }
    }
    let count = slice.len() as f64;
    let mut base = [rgb[0] / count, rgb[1] / count, rgb[2] / count];
    let Some(ssgdi) = ssgdi else {
        return base;
    };
    assert!(
        ssgdi.iter().all(|value| value.is_finite()),
        "Probe SH update SSGDI input must be finite RGB."
    );
    for axis in 0..3 {
        base[axis] += ssgdi[axis];
    }
    base
}

/// 静态 1 bounce(均匀反照率近似)+ 能量哨兵(TS `applyStaticBounce` 镜像;
/// ρ≤1 物理上界 ×2.01,超限 fail-closed 回基线)。
fn apply_static_bounce(target: [f64; 3], bounce_albedo: Option<[f64; 3]>) -> BounceGuard {
    let Some(bounce_albedo) = bounce_albedo else {
        return BounceGuard {
            radiance: target,
            tripped: false,
        };
    };
    assert!(
        bounce_albedo
            .iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(value)),
        "Probe SH update bounceAlbedo must be RGB in [0, 1]."
    );
    let bounced = [
        target[0] * (1.0 + bounce_albedo[0]),
        target[1] * (1.0 + bounce_albedo[1]),
        target[2] * (1.0 + bounce_albedo[2]),
    ];
    let baseline = hypot3(target[0], target[1], target[2]);
    let energy = hypot3(bounced[0], bounced[1], bounced[2]);
    // 防线纵深:反照率合同已保证 bounced ≤ 2× 基线,哨兵兜底非有限值/口径漂移。
    if !energy.is_finite() || energy > baseline * BOUNCE_ENERGY_LIMIT {
        return BounceGuard {
            radiance: target,
            tripped: true,
        };
    }
    BounceGuard {
        radiance: bounced,
        tripped: false,
    }
}

struct BounceGuard {
    radiance: [f64; 3],
    tripped: bool,
}

/// 命中距离统计归约(TS `sdfGiProbeGeometryStats` 镜像):命中数 ≥1 →
/// mean/var(总体方差);全 miss → (maxDistance, 0)(开放空间语义)。
pub fn sdf_gi_probe_geometry_stats(
    hit_distances: &[f32],
    direction_count: usize,
    max_distance: f64,
) -> Vec<(f64, f64)> {
    assert!(
        direction_count > 0 && hit_distances.len().is_multiple_of(direction_count),
        "SDF GI geometry stats require hit distances aligned to the direction count."
    );
    let probe_count = hit_distances.len() / direction_count;
    let mut stats = Vec::with_capacity(probe_count);
    for probe in 0..probe_count {
        let first = probe * direction_count;
        let mut sum = 0.0f64;
        let mut count = 0usize;
        for hit in &hit_distances[first..first + direction_count] {
            let hit = f64::from(*hit);
            if hit >= 0.0 {
                sum += hit;
                count += 1;
            }
        }
        if count == 0 {
            stats.push((max_distance, 0.0));
            continue;
        }
        let mean = sum / count as f64;
        if count == 1 {
            stats.push((mean, 0.0));
            continue;
        }
        let mut squared = 0.0f64;
        for hit in &hit_distances[first..first + direction_count] {
            let hit = f64::from(*hit);
            if hit >= 0.0 {
                let delta = hit - mean;
                squared += delta * delta;
            }
        }
        stats.push((mean, squared / count as f64));
    }
    stats
}

/// 帧内更新窗口计划(TS `planSdfGiProbeWindow` 镜像):count = clamp(budget,0,N);
/// offset = (已派发窗口 × count) mod N,触底钳制 —— 每探针每周期恰更新一次。
pub fn plan_sdf_gi_probe_window(
    probe_count: usize,
    budget: f64,
    dispatched_windows: usize,
) -> (usize, usize) {
    if probe_count == 0 {
        return (0, 0);
    }
    let stride = if budget < 0.0 {
        0usize
    } else {
        (budget.floor() as usize).min(probe_count)
    };
    if stride == 0 {
        return (0, 0);
    }
    let offset = (dispatched_windows * stride) % probe_count;
    (offset, stride.min(probe_count - offset))
}

/// 烘焙期记录初值(TS `packInitialSdfGiRecords` 镜像):validity 1、irradiance 0、
/// meanDistance/variance 取有界 Chebyshev 可见先验(maxDistance/2 与
/// (maxDistance/4)²);F5 words[12..23] 全零 = SH 缺失语义。
pub fn pack_initial_sdf_gi_records(
    probe_count: usize,
    max_distance: f64,
) -> Vec<IrradianceProbeRecord> {
    let mean_distance = max_distance * 0.5;
    let variance = (max_distance * 0.25 * (max_distance * 0.25)).max(1e-4);
    let mut records = Vec::with_capacity(probe_count);
    for _probe in 0..probe_count {
        records.push(IrradianceProbeRecord {
            irradiance: [0.0; 3],
            validity: 1.0,
            mean_distance: mean_distance as f32,
            distance_variance: variance as f32,
            occlusion_floor: 0.0,
            padding: 0.0,
            position_offset: [0.0; 3],
            position_padding: 0.0,
            reserved: [0.0; 12],
        });
    }
    records
}

/// ProbeUpdateParams 的 GPU uniform 打包(64B,小端;布局与
/// `wgsl/sdfGiProbeUpdate.wgsl` 的 struct 互钉,与 TS `packSdfGiProbeUpdateParams`
/// 同构)。
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SdfGiProbeUpdateParams {
    pub probe_count: u32,
    pub direction_count: u32,
    pub window_offset: u32,
    pub window_count: u32,
    pub alpha: f32,
    pub bounce_enabled: u32,
    pub record_vec4_stride: u32,
    pub bounce_energy_limit: f32,
    pub bounce_albedo: [f32; 4],
    pub max_distance: f32,
    pub padding: [f32; 3],
}

impl SdfGiProbeUpdateParams {
    pub fn pack(
        input: &ProbeShUpdateInput<'_>,
        window_offset: usize,
        window_count: usize,
        max_distance: f64,
    ) -> Self {
        assert_eq!(
            size_of::<Self>(),
            SDF_GI_PROBE_UPDATE_PARAMS_BYTES,
            "ProbeUpdateParams 布局漂移(WGSL struct 互钉)"
        );
        let albedo = input.bounce_albedo.unwrap_or([0.0; 3]);
        Self {
            probe_count: input.positions_len() as u32,
            direction_count: input.directions.len() as u32,
            window_offset: window_offset as u32,
            window_count: window_count as u32,
            alpha: resolve_deep_gi_temporal_alpha(input.alpha) as f32,
            bounce_enabled: u32::from(input.bounce_albedo.is_some()),
            record_vec4_stride: SDF_GI_PROBE_RECORD_VEC4_STRIDE as u32,
            bounce_energy_limit: BOUNCE_ENERGY_LIMIT as f32,
            bounce_albedo: [albedo[0] as f32, albedo[1] as f32, albedo[2] as f32, 0.0],
            max_distance: max_distance as f32,
            padding: [0.0; 3],
        }
    }
}

#[cfg(test)]
#[path = "sdf_gi_probe_update_tests.rs"]
mod sdf_gi_probe_update_tests;
