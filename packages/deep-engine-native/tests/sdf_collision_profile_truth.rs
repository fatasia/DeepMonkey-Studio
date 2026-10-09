//! A2 WGSL SDF 碰撞 profile:Rapier 真值对照 + 确定性 + 跨端逐位指纹(Native 侧)。
//!
//! 与 Web `src/physics/sdfCollisionProfile.test.ts` 同一合同,三条证据腿:
//! 1. **WGSL 单源三方门**:真源 `deep-engine/wgsl/sdfCollisionQuery.wgsl` 的
//!    SHA-256/字节数与 sidecar(`sdfCollisionQuery.wgsl.sha256`)一致;TS 半字节门在
//!    `src/physics/sdfCollisionQueryWgslChecksum.test.ts`(node:crypto 重算)。
//!    本测试经由 `tests/common/mod.rs` 的纯 Rust SHA-256(FIPS 180-4),不新增依赖。
//! 2. **Rapier 真值对照**:同一凹 L 棱柱(与 F6 golden 同角点集)的 rapier3d 凸包
//!    (`SharedShape::convex_hull` + `PointQuery` 点投影)作真值,与 f32 镜像
//!    (trilinear + 中心差分梯度,与 TS 逐运算同构;双舍入免疫保证逐位)在
//!    4096 个同 seed LCG 采样点上对照:外部一致区距离误差 ≤ (√3/2)·cellSize、
//!    近表面法线对齐 ≥ 0.15、幽灵厚度 ∈ (0, √2 + 采样上界]、leak 零容忍。
//!    命中点/法线对照表以 `--nocapture` 输出。
//! 3. **确定性**:镜像双跑 f32 位逐位一致(查询核每 lane 输出独立,无归约定序需求);
//!    跨端逐位指纹(双向 FNV,f32 LE 位流)与 TS 同字面量 `9d5c2f7210ed7244`。
//!
//! SHA-256 在 `tests/common/mod.rs`(与 cloth_parallel_compute_parity.rs 同算法)。

use rapier3d::geometry::SharedShape;
use rapier3d::parry::math::{Pose, Vector};

mod common;
use common::sha256_hex;

const FIXTURE: &str = include_str!("../src/physics_sdf_l_fixture.json");
const WGSL: &str = include_str!("../../deep-engine/wgsl/sdfCollisionQuery.wgsl");
const WGSL_SIDECAR: &str = include_str!("../../deep-engine/wgsl/sdfCollisionQuery.wgsl.sha256");

const GRID_ORIGIN: [f32; 3] = [-0.125, -0.125, -0.125];
const GRID_CELL_SIZE: f32 = 0.25;
const GRID_DIMENSIONS: [u32; 3] = [16, 16, 8];
const SAMPLE_COUNT: usize = 4096;
const LCG_SEED: u32 = 0x5df4_c6d3;
/** 近表面法线对齐预算(实测 0.19876 − 余量,与 TS 钉定值一致)。 */
const MIN_NORMAL_ALIGNMENT: f64 = 0.15;

// ─── f32 镜像(trilinear + 中心差分梯度,与 TS sampleSdfCollision 逐运算同构) ──

struct Grid {
    field: Vec<f32>,
}

impl Grid {
    fn at(&self, x: i32, y: i32, z: i32) -> f32 {
        let cx = x.clamp(0, GRID_DIMENSIONS[0] as i32 - 1);
        let cy = y.clamp(0, GRID_DIMENSIONS[1] as i32 - 1);
        let cz = z.clamp(0, GRID_DIMENSIONS[2] as i32 - 1);
        self.field
            [((cz * GRID_DIMENSIONS[1] as i32 + cy) * GRID_DIMENSIONS[0] as i32 + cx) as usize]
    }

    /// 返回 (distance, gradient, in_domain);域外 distance = NaN(fail-closed 合同)。
    fn sample(&self, p: [f32; 3]) -> (f32, [f32; 3], bool) {
        let cs = GRID_CELL_SIZE;
        let qx = (p[0] - GRID_ORIGIN[0]) / cs;
        let qy = (p[1] - GRID_ORIGIN[1]) / cs;
        let qz = (p[2] - GRID_ORIGIN[2]) / cs;
        let max_x = GRID_DIMENSIONS[0] as f32 - 1.0;
        let max_y = GRID_DIMENSIONS[1] as f32 - 1.0;
        let max_z = GRID_DIMENSIONS[2] as f32 - 1.0;
        if !(0.0..=max_x).contains(&qx)
            || !(0.0..=max_y).contains(&qy)
            || !(0.0..=max_z).contains(&qz)
        {
            return (f32::NAN, [0.0; 3], false);
        }
        let lx = qx.floor() as i32;
        let ly = qy.floor() as i32;
        let lz = qz.floor() as i32;
        let fx = qx - lx as f32;
        let fy = qy - ly as f32;
        let fz = qz - lz as f32;
        let d000 = self.at(lx, ly, lz);
        let d100 = self.at(lx + 1, ly, lz);
        let d010 = self.at(lx, ly + 1, lz);
        let d110 = self.at(lx + 1, ly + 1, lz);
        let d001 = self.at(lx, ly, lz + 1);
        let d101 = self.at(lx + 1, ly, lz + 1);
        let d011 = self.at(lx, ly + 1, lz + 1);
        let d111 = self.at(lx + 1, ly + 1, lz + 1);
        // 运算序与 WGSL/TS 一致:x 向 4 条 → y 向 2 条 → z 向 1 条。
        let x0 = d000 + (d100 - d000) * fx;
        let x1 = d010 + (d110 - d010) * fx;
        let x2 = d001 + (d101 - d001) * fx;
        let x3 = d011 + (d111 - d011) * fx;
        let y0 = x0 + (x1 - x0) * fy;
        let y1 = x2 + (x3 - x2) * fy;
        let distance = y0 + (y1 - y0) * fz;
        // 中心差分梯度,固定 stencil 序 x→y→z。
        let hh = 2.0f32 * cs;
        let gx = (self.at(lx + 1, ly, lz) - self.at(lx - 1, ly, lz)) / hh;
        let gy = (self.at(lx, ly + 1, lz) - self.at(lx, ly - 1, lz)) / hh;
        let gz = (self.at(lx, ly, lz + 1) - self.at(lx, ly, lz - 1)) / hh;
        (distance, [gx, gy, gz], true)
    }
}

/// 与 TS `createSdfQueryPointStream` 逐位同构的 LCG 点流(u32 wrap + f32 乘加)。
fn sample_points() -> Vec<[f32; 3]> {
    let cs = GRID_CELL_SIZE;
    let spans = [
        (GRID_DIMENSIONS[0] as f32 - 1.0) * cs,
        (GRID_DIMENSIONS[1] as f32 - 1.0) * cs,
        (GRID_DIMENSIONS[2] as f32 - 1.0) * cs,
    ];
    let mut state = LCG_SEED;
    let mut next = || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        state
    };
    let mut points = Vec::with_capacity(SAMPLE_COUNT);
    for _ in 0..SAMPLE_COUNT {
        let unit = |draw: u32, axis: usize| {
            let u = ((draw >> 8) as f32) * (1.0f32 / 16777216.0f32);
            GRID_ORIGIN[axis] + u * spans[axis]
        };
        points.push([unit(next(), 0), unit(next(), 1), unit(next(), 2)]);
    }
    points
}

// ─── 跨端逐位指纹(与 clothParallelSolver.fingerprintFloat32 同算法) ───────────

fn fingerprint_float32(values: &[f32]) -> String {
    let bytes: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut forward: u32 = 0x811c_9dc5;
    let mut backward: u32 = 0x811c_9dc5;
    for &byte in &bytes {
        forward = (forward ^ byte as u32).wrapping_mul(0x0100_0193);
    }
    for &byte in bytes.iter().rev() {
        backward = (backward ^ byte as u32).wrapping_mul(0x0100_0193);
    }
    format!("{forward:08x}{backward:08x}")
}

// ─── 测试 ───────────────────────────────────────────────────────────────────────

fn load_grid() -> Grid {
    #[derive(serde::Deserialize)]
    struct Fixture {
        distances: Vec<f64>,
    }
    let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cells = (GRID_DIMENSIONS[0] * GRID_DIMENSIONS[1] * GRID_DIMENSIONS[2]) as usize;
    assert_eq!(fixture.distances.len(), cells, "fixture cells 与网格不一致");
    Grid {
        field: fixture.distances.iter().map(|&d| d as f32).collect(),
    }
}

/// Rapier 凸包真值行:hull 距离(solid 口径)、命中点、法线(距离增大方向)、幽灵面标记。
struct TruthRow {
    #[allow(dead_code)]
    _point: [f32; 3],
    hull_distance: f32,
    normal: [f32; 3],
    ghost_face: bool,
}

fn hull_truth(shape: &SharedShape, iso: &Pose, point: [f32; 3]) -> TruthRow {
    let pt = Vector::new(point[0], point[1], point[2]);
    let projection = shape.project_point(iso, pt, true);
    // solid=false ⇒ 带符号(内部为负);solid=true 是无符号口径(parry 合同),
    // 与 TS 解析真值(负 = 内部)不一致,故必须传 false。
    let signed = shape.distance_to_point(iso, pt, false);
    let closest = projection.point;
    let delta = pt - closest;
    let dist = delta.length();
    let normal = if dist > 0.0 {
        if signed >= 0.0 {
            delta / dist
        } else {
            -delta / dist
        }
    } else {
        Vector::new(0.0, 0.0, 1.0)
    };
    // 幽灵面 = 最近面点的 2D 位置在楔形(多边形 ∖ L,x>1 且 y>1)内。
    let ghost_face = closest.x > 1.0 + 1e-9 && closest.y > 1.0 + 1e-9;
    TruthRow {
        _point: point,
        hull_distance: signed,
        normal: normal.to_array(),
        ghost_face,
    }
}

#[test]
fn wgsl_single_source_matches_pinned_sidecar() {
    let sidecar = WGSL_SIDECAR.trim();
    let (expected, bytes) = sidecar
        .split_once(' ')
        .expect("sidecar 形如 \"<hex> <len>\"");
    assert_eq!(
        sha256_hex(WGSL.as_bytes()),
        expected,
        "WGSL 真源 SHA-256 与 sidecar 不一致"
    );
    assert_eq!(
        WGSL.len(),
        bytes.parse::<usize>().expect("sidecar 字节数"),
        "WGSL 字节数与 sidecar 不一致"
    );
}

#[test]
fn rapier_hull_truth_matches_sdf_profile_budget_with_error_table() {
    let grid = load_grid();
    let corners: Vec<Vector> = [
        [0.0f32, 0.0],
        [3.0, 0.0],
        [3.0, 1.0],
        [1.0, 3.0],
        [0.0, 3.0],
    ]
    .iter()
    .flat_map(|[x, y]| [Vector::new(*x, *y, 0.0), Vector::new(*x, *y, 1.0)])
    .collect();
    let shape = SharedShape::convex_hull(&corners).expect("L 棱柱凸包有效");
    let iso = Pose::identity();
    let points = sample_points();

    let sampling_bound = 3.0f64.sqrt() * (GRID_CELL_SIZE as f64) * 0.5;
    let ghost_bound = std::f64::consts::SQRT_2 + sampling_bound;

    let mut regions = [0usize; 5]; // agreement / ghost-adjacent / ghost / inside / leak
    let mut worst_outside_error = (0.0f64, [0.0f32; 3]);
    let mut worst_alignment = (1.0f64, [0.0f32; 3]);
    let mut max_ghost_thickness = 0.0f64;
    let mut _agreement_rows = 0usize;
    let mut band_rows = 0usize;

    for point in &points {
        let (distance, gradient, in_domain) = grid.sample(*point);
        assert!(in_domain, "LCG 采样点 {point:?} 越界:采样流合同破坏");
        let truth = hull_truth(&shape, &iso, *point);
        // leak 判据用严格 > 0:hull == 0 的边界退化行(f32 真值吸附到共享面)若
        // sdf < 0 属「点在形状内部、恰在凸包面上」,距离误差 ≤ 采样上界,由
        // outside-agreement 分支正常验收,不是构建回归。
        if truth.hull_distance > 0.0 && distance < 0.0 {
            panic!(
                "leak:SDF 判内部({distance})而凸包判外部({}):SDF 比凸包更实,构建回归",
                truth.hull_distance
            );
        }
        if truth.hull_distance >= 0.0 && !truth.ghost_face {
            regions[0] += 1;
            _agreement_rows += 1;
            let error = (distance - truth.hull_distance).abs() as f64;
            assert!(
                error <= sampling_bound,
                "外部一致区距离误差 {error} 超采样上界 {sampling_bound} @ {point:?}"
            );
            if error > worst_outside_error.0 {
                worst_outside_error = (error, *point);
            }
            let length =
                (gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2])
                    .sqrt();
            if length > 0.0 && distance.abs() <= 2.0 * GRID_CELL_SIZE {
                band_rows += 1;
                let alignment = ((gradient[0] * truth.normal[0]
                    + gradient[1] * truth.normal[1]
                    + gradient[2] * truth.normal[2])
                    / length) as f64;
                if alignment < worst_alignment.0 {
                    worst_alignment = (alignment, *point);
                }
                assert!(
                    alignment >= MIN_NORMAL_ALIGNMENT,
                    "近表面法线对齐 {alignment} 低于预算 {MIN_NORMAL_ALIGNMENT} @ {point:?} sdf={distance} hull={}",
                    truth.hull_distance
                );
            }
        } else if truth.hull_distance >= 0.0 {
            regions[1] += 1;
            assert!(
                distance >= truth.hull_distance - sampling_bound as f32,
                "幽灵面邻接区 SDF({distance})低于凸包({}):疑似泄漏 @ {point:?}",
                truth.hull_distance
            );
        } else if distance >= 0.0 {
            regions[2] += 1;
            let thickness = (distance - truth.hull_distance) as f64;
            assert!(
                thickness > 0.0,
                "凹域幽灵厚度必须为正,实测 {thickness} @ {point:?}"
            );
            assert!(
                thickness <= ghost_bound,
                "幽灵厚度 {thickness} 超几何上界 {ghost_bound} @ {point:?}"
            );
            max_ghost_thickness = max_ghost_thickness.max(thickness);
        } else {
            regions[3] += 1;
        }
    }

    println!("── A2 SDF profile × Rapier 凸包真值对照表(4096 LCG 点) ──");
    println!(
        "区域分布: outside-agreement={} outside-ghost-adjacent={} ghost={} inside-agreement={} leak=0(零容忍)",
        regions[0], regions[1], regions[2], regions[3]
    );
    println!(
        "距离误差: max={:.6} ≤ 上界(√3/2·cellSize)={:.6} @ {:?}",
        worst_outside_error.0, sampling_bound, worst_outside_error.1
    );
    println!(
        "法线对齐: 带内行={} min={:.6} ≥ 预算 {MIN_NORMAL_ALIGNMENT} @ {:?}",
        band_rows, worst_alignment.0, worst_alignment.1
    );
    println!(
        "幽灵厚度: max={:.6} ≤ 几何上界(√2+采样上界)={:.6}(F6 解析凹槽深 √2≈1.414 一族)",
        max_ghost_thickness, ghost_bound
    );
    assert!(
        regions[0] > 400 && regions[2] > 50,
        "区域覆盖不足:{regions:?}"
    );
    assert!(worst_alignment.0 >= MIN_NORMAL_ALIGNMENT);
}

#[test]
fn mirror_double_run_is_bitwise_and_cross_language_fingerprint_is_pinned() {
    let grid = load_grid();
    let points = sample_points();
    let mut stream_first = Vec::with_capacity(SAMPLE_COUNT * 4);
    let mut stream_second = Vec::with_capacity(SAMPLE_COUNT * 4);
    for point in &points {
        let (distance, gradient, _) = grid.sample(*point);
        stream_first.extend_from_slice(&[distance, gradient[0], gradient[1], gradient[2]]);
        let (distance2, gradient2, _) = grid.sample(*point);
        stream_second.extend_from_slice(&[distance2, gradient2[0], gradient2[1], gradient2[2]]);
    }
    // 同 seed 重放逐位(f32 位模式):
    for (a, b) in stream_first.iter().zip(stream_second.iter()) {
        assert_eq!(a.to_bits(), b.to_bits(), "镜像双跑逐位破坏 @ index");
    }
    // 跨端指纹:与 TS sdfCollisionProfile.test.ts 的 PINNED_CROSS_LANGUAGE_FINGERPRINT 同字面量。
    assert_eq!(fingerprint_float32(&stream_first), "9d5c2f7210ed7244");
}
