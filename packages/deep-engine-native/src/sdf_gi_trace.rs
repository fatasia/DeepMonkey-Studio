//! Brief-GI native 天光圆锥追踪(CPU 权威镜像)。
//!
//! 唯一语义源 = Web `deep-engine/src/gi/sdfSkyVisibility.ts`(它本身是
//! `wgsl/sdfSkyVisibilityTrace.wgsl` 的 fround 生成镜像)。每 (探针 × 方向) 输出
//! 可见度 ∈[0,1] 与首个「圆锥被几何侵入」步的步心距离(miss = −1),与 WGSL 核的
//! `visibilities`/`hitDistances` 输出同构;可见度向量由
//! [`crate::sdf_gi_probe_update`] 投影 L1 SH 并进探针记录(96B ABI)。
//!
//! == 域外语义(与碰撞查询刻意不同,与 TS/WGSL 同款)==
//! 天光可见性是光照量不是安全量:探针/采样点在场景 SDF 域外视作「直达天空」
//! (vis=1 / 采样值 1e6),烘焙域之外的世界本就是开放天空,fail-closed 会造假影。
//!
//! == 浮点镜像纪律 ==
//! TS 在每个中间表达式上显式 `Math.fround`;本镜像逐式同构(f64 中间量 + 同落点
//! fround;数组存取 f32)。方向集 = Fibonacci(CPU 权威 `probeOcclusionDirection`
//! 的 f64 镜像;跨 libm sin/acos 1 ulp 风险由黄金 fixture 对拍实证)。

// 天光追踪核:GPU dispatch 在后继切片接入,合同与对拍先行落库(同 probe_gi 惯例)。
#![allow(dead_code)]

use crate::sdf_gi_scene::{SdfSceneGrid, fround, hypot3};

/// 圆锥步数下限/上限(Brief-GI 口径;与 TS/WGSL 常量同源)。
pub const SDF_SKY_VISIBILITY_MIN_STEPS: u32 = 8;
pub const SDF_SKY_VISIBILITY_MAX_STEPS: u32 = 16;
/// 圆锥 limit 的除法下限(max(coneTan·t, 该值)),防 t≈0 除零。
pub const SDF_SKY_VISIBILITY_LIMIT_EPSILON: f64 = 0.000_001;
/// workgroup 尺寸(GPU 派发合同;每 lane 一条 (探针 × 方向))。
pub const SDF_SKY_VISIBILITY_WORKGROUP_SIZE: u32 = 64;
/// SkyTraceParams uniform 字节(WGSL struct 互钉:origin 12 + cellSize 4 +
/// dimensions 12 + steps 4 + coneTan 4 + maxDistance 4 + directionCount 4 +
/// probeCount 4)。
pub const SDF_SKY_VISIBILITY_PARAMS_BYTES: usize = 48;

/// Fibonacci 球面黄金角(TS `GOLDEN_SPHERE_ANGLE = Math.PI * (1 + sqrt(5))`;
/// IEEE sqrt 逐位确定,跨端同值)。
fn golden_sphere_angle() -> f64 {
    std::f64::consts::PI * (1.0 + 5.0f64.sqrt())
}

/// 天光追踪配置(TS `SdfSkyVisibilityTraceConfig` 同构)。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SdfSkyVisibilityTraceConfig {
    pub steps: u32,
    pub cone_tan: f64,
    pub max_distance: f64,
}

/// 追踪选项(TS `SdfSkyVisibilityTraceOptions` 同构;None = 用 TS 同款边界值)。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SdfSkyVisibilityTraceOptions {
    pub steps: Option<u32>,
    pub cone_tan: Option<f64>,
    pub max_distance: Option<f64>,
}

/// TS `DEFAULT_CONE_TAN = Math.tan(Math.PI / 12)`(探针尺度软遮蔽)。
pub fn default_cone_tan() -> f64 {
    (std::f64::consts::PI / 12.0).tan()
}

#[inline]
fn clamp_bound(value: Option<f64>, fallback: f64, max: f64, out_of_range: f64) -> f64 {
    match value {
        None => fallback,
        Some(value) => {
            if !value.is_finite() || value <= 0.0 || value > max {
                out_of_range
            } else {
                value
            }
        }
    }
}

/// 配置解析(fail-closed 回边界值,不报错 —— 渲染循环不因脏配置中断;
/// TS `resolveSdfSkyVisibilityTraceConfig` 镜像)。
pub fn resolve_sdf_sky_visibility_trace_config(
    grid: &SdfSceneGrid,
    options: SdfSkyVisibilityTraceOptions,
) -> SdfSkyVisibilityTraceConfig {
    let steps = options.steps.unwrap_or(SDF_SKY_VISIBILITY_MIN_STEPS);
    let steps = if !(SDF_SKY_VISIBILITY_MIN_STEPS..=SDF_SKY_VISIBILITY_MAX_STEPS).contains(&steps) {
        SDF_SKY_VISIBILITY_MIN_STEPS
    } else {
        steps
    };
    let default_cone_tan = default_cone_tan();
    let cone_tan = clamp_bound(options.cone_tan, default_cone_tan, 1.0, default_cone_tan);
    let diagonal = hypot3(
        (grid.dimensions[0] as f64 - 1.0) * grid.cell_size,
        (grid.dimensions[1] as f64 - 1.0) * grid.cell_size,
        (grid.dimensions[2] as f64 - 1.0) * grid.cell_size,
    );
    let max_distance = clamp_bound(options.max_distance, diagonal, diagonal * 16.0, diagonal);
    SdfSkyVisibilityTraceConfig {
        steps,
        cone_tan,
        max_distance,
    }
}

/// Fibonacci 球面方向(TS `probeOcclusionDirection` 逐式镜像):确定性均匀分布,
/// k∈(0,1) 开区间避免极点重复;单位向量。
pub fn probe_occlusion_direction(ordinal: u32, count: u32) -> [f64; 3] {
    let k = (f64::from(ordinal) + 0.5) / f64::from(count);
    let phi = (1.0 - 2.0 * k).acos();
    let theta = golden_sphere_angle() * (f64::from(ordinal) + 0.5);
    let sin = phi.sin();
    [sin * theta.cos(), phi.cos(), sin * theta.sin()]
}

/// 天光可见度 + 命中距离联合追踪(TS `traceSdfSkyVisibilityWithHits` 逐式镜像)。
///
/// - `positions`:探针世界位置(lattice);`directions`:天光方向表(宿主经
///   [`probe_occlusion_direction`] 生成;非有限向量按 TS RangeError 同义报错)。
/// - 输出长度均为 `positions.len() × directions.len()`,下标 =
///   probe_index × directions.len() + dir_index;`hit_distances` 的 miss = −1。
pub fn trace_sdf_sky_visibility_with_hits(
    grid: &SdfSceneGrid,
    positions: &[[f64; 3]],
    directions: &[[f64; 3]],
    config: &SdfSkyVisibilityTraceConfig,
) -> (Vec<f32>, Vec<f32>) {
    assert!(
        !positions.is_empty() && !directions.is_empty(),
        "SDF sky visibility trace needs at least one probe and one direction."
    );
    assert!(
        directions
            .iter()
            .all(|d| d.iter().all(|value| value.is_finite())),
        "SDF sky visibility directions must be finite vec3."
    );
    let [nx, ny, nz] = grid.dimensions;
    let (max_x, max_y, max_z) = ((nx - 1) as f64, (ny - 1) as f64, (nz - 1) as f64);
    let cs = grid.cell_size;
    let origin = grid.origin;
    let at = |x: i64, y: i64, z: i64| -> f64 {
        let cx = (x.clamp(0, nx as i64 - 1)) as usize;
        let cy = (y.clamp(0, ny as i64 - 1)) as usize;
        let cz = (z.clamp(0, nz as i64 - 1)) as usize;
        f64::from(grid.distances[(cz * ny + cy) * nx + cx])
    };
    // trilinear 采样序 x4→y2→z1,每个子表达式单次 fround(= f32 运算)。
    let sample = |px: f64, py: f64, pz: f64| -> f64 {
        let qx = fround(fround(px - origin[0]) / cs);
        let qy = fround(fround(py - origin[1]) / cs);
        let qz = fround(fround(pz - origin[2]) / cs);
        // 域外 = 开放空间(1e6;可见性贡献恒 1,绝不把边界环近零距离泄漏域外)。
        if qx < 0.0 || qy < 0.0 || qz < 0.0 || qx > max_x || qy > max_y || qz > max_z {
            return 1_000_000.0;
        }
        let cx = qx.clamp(0.0, max_x);
        let cy = qy.clamp(0.0, max_y);
        let cz = qz.clamp(0.0, max_z);
        let lx = cx.floor();
        let ly = cy.floor();
        let lz = cz.floor();
        let fx = fround(cx - lx);
        let fy = fround(cy - ly);
        let fz = fround(cz - lz);
        let (ix, iy, iz) = (lx as i64, ly as i64, lz as i64);
        let d000 = at(ix, iy, iz);
        let d100 = at(ix + 1, iy, iz);
        let d010 = at(ix, iy + 1, iz);
        let d110 = at(ix + 1, iy + 1, iz);
        let d001 = at(ix, iy, iz + 1);
        let d101 = at(ix + 1, iy, iz + 1);
        let d011 = at(ix, iy + 1, iz + 1);
        let d111 = at(ix + 1, iy + 1, iz + 1);
        let x0 = fround(d000 + fround(fround(d100 - d000) * fx));
        let x1 = fround(d010 + fround(fround(d110 - d010) * fx));
        let x2 = fround(d001 + fround(fround(d101 - d001) * fx));
        let x3 = fround(d011 + fround(fround(d111 - d011) * fx));
        let y0 = fround(x0 + fround(fround(x1 - x0) * fy));
        let y1 = fround(x2 + fround(fround(x3 - x2) * fy));
        fround(y0 + fround(fround(y1 - y0) * fz))
    };
    let total = positions.len() * directions.len();
    let mut visibilities = vec![0.0f32; total];
    let mut hit_distances = vec![0.0f32; total];
    let stride = directions.len();
    let step_length = fround(config.max_distance / f64::from(config.steps));
    let unit: Vec<[f64; 3]> = directions
        .iter()
        .map(|direction| {
            let x = fround(direction[0]);
            let y = fround(direction[1]);
            let z = fround(direction[2]);
            let length = fround((fround(x * x) + fround(fround(y * y) + fround(z * z))).sqrt());
            [fround(x / length), fround(y / length), fround(z / length)]
        })
        .collect();
    for (probe, position) in positions.iter().enumerate() {
        // 域外探针恒 1/−1(开放天空语义)。
        let in_domain = (0..3).all(|axis| {
            let q = fround(fround(position[axis] - origin[axis]) / cs);
            let max_axis = [max_x, max_y, max_z][axis];
            (0.0..=max_axis).contains(&q)
        });
        for (direction, unit) in unit.iter().enumerate() {
            let lane = probe * stride + direction;
            if !in_domain {
                visibilities[lane] = 1.0;
                hit_distances[lane] = -1.0;
                continue;
            }
            let (dx, dy, dz) = (unit[0], unit[1], unit[2]);
            let mut visibility = 1.0f64;
            // 命中距离:首个 contribution < 1 的步心(全程无侵入保持哨兵 −1)。
            let mut hit_distance = -1.0f64;
            for step in 0..config.steps {
                let t = fround(fround(f64::from(step) + 0.5) * step_length);
                let sx = sample(
                    fround(position[0] + fround(dx * t)),
                    fround(position[1] + fround(dy * t)),
                    fround(position[2] + fround(dz * t)),
                );
                let limit = fround(config.cone_tan * t).max(SDF_SKY_VISIBILITY_LIMIT_EPSILON);
                let contribution = (sx / limit).clamp(0.0, 1.0);
                if hit_distance < 0.0 && contribution < 1.0 {
                    hit_distance = t;
                }
                visibility = visibility.min(contribution);
            }
            visibilities[lane] = visibility as f32;
            hit_distances[lane] = hit_distance as f32;
        }
    }
    (visibilities, hit_distances)
}

/// 仅可见度的薄封装(TS `traceSdfSkyVisibility` 同构)。
pub fn trace_sdf_sky_visibility(
    grid: &SdfSceneGrid,
    positions: &[[f64; 3]],
    directions: &[[f64; 3]],
    config: &SdfSkyVisibilityTraceConfig,
) -> Vec<f32> {
    trace_sdf_sky_visibility_with_hits(grid, positions, directions, config).0
}

/// SkyTraceParams 的 GPU uniform 打包(48B,小端;布局与
/// `wgsl/sdfSkyVisibilityTrace.wgsl` 的 struct 互钉,与 TS `packSdfGiSkyTraceParams`
/// 同构)。dimensions 走 u32,origin/cellSize/coneTan/maxDistance 走 f32 落盘。
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SdfSkyTraceParams {
    pub origin: [f32; 3],
    pub cell_size: f32,
    pub dimensions: [u32; 3],
    pub steps: u32,
    pub cone_tan: f32,
    pub max_distance: f32,
    pub direction_count: u32,
    pub probe_count: u32,
}

impl SdfSkyTraceParams {
    pub fn from_config(
        grid: &SdfSceneGrid,
        config: &SdfSkyVisibilityTraceConfig,
        direction_count: u32,
        probe_count: u32,
    ) -> Self {
        assert_eq!(
            size_of::<Self>(),
            SDF_SKY_VISIBILITY_PARAMS_BYTES,
            "SkyTraceParams 布局漂移(WGSL struct 互钉)"
        );
        Self {
            origin: [
                grid.origin[0] as f32,
                grid.origin[1] as f32,
                grid.origin[2] as f32,
            ],
            cell_size: grid.cell_size as f32,
            dimensions: [
                grid.dimensions[0] as u32,
                grid.dimensions[1] as u32,
                grid.dimensions[2] as u32,
            ],
            steps: config.steps,
            cone_tan: config.cone_tan as f32,
            max_distance: config.max_distance as f32,
            direction_count,
            probe_count,
        }
    }
}

/// Fibonacci 方向表打包(f32 落盘;与 TS `packSdfGiDirectionTable` 同构,
/// vec4 步长 w=0)。
pub fn pack_direction_table(directions: &[[f64; 3]]) -> Vec<f32> {
    let mut table = Vec::with_capacity(directions.len() * 4);
    for direction in directions {
        table.push(direction[0] as f32);
        table.push(direction[1] as f32);
        table.push(direction[2] as f32);
        table.push(0.0);
    }
    table
}

/// 探针位置表打包(f32 落盘;与 TS `packSdfGiProbePositions` 同构)。
pub fn pack_probe_positions(positions: &[[f64; 3]]) -> Vec<f32> {
    let mut table = Vec::with_capacity(positions.len() * 4);
    for position in positions {
        table.push(position[0] as f32);
        table.push(position[1] as f32);
        table.push(position[2] as f32);
        table.push(0.0);
    }
    table
}

#[cfg(test)]
#[path = "sdf_gi_trace_tests.rs"]
mod sdf_gi_trace_tests;
