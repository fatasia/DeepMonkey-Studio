//! T18 A3 并行切片:布料 GPU compute 核的跨端对拍(Native 侧)。
//!
//! 对拍链(与既有 `cloth_softbody_solver_parity.rs` 的 J3 Gate C 互补,不改动它):
//! 1. **WGSL 单源三方门**:真源 `wgsl/clothSolver.wgsl` 的 SHA-256/字节数与 sidecar
//!    夹具(`clothSolver.wgsl.sha256`)一致;TS 半字节门在
//!    `src/physics/clothSolverWgslChecksum.test.ts`(node:crypto 重算)。
//!    本文件自带纯 Rust SHA-256(FIPS 180-4),不新增依赖。
//! 2. **着色逐位**:纯 Rust 贪心边着色(按约束索引序最小可用色,u32 端点占用掩码)
//!    重放共享 fixture(`fixtures/cloth-parallel-compute-v1.json`,由 TS
//!    `clothParallelFixtureGen.mts` 生成)中的网格与非对称小拓扑,colors/order/ranges
//!    全等,并独立断言同色约束不共享端点。
//! 3. **f32 色序求解器逐位**:与 TS 模拟镜像(`clothParallelSolver.ts`)逐运算同构
//!    (Rust f32 为 IEEE-754 正确舍入且从不合浮点;fround(f64 单运算) == f32 单运算,
//!    由双舍入免疫定理保证,Figueroa:宽格式精度 p₂ ≥ 2p+2 时四则与 sqrt 均成立,
//!    53 ≥ 2·24+2)。重放 240 ticks,per-24-tick 指纹全表、末子步动能、拉伸统计
//!    与 fixture 逐位对拍;同输入双跑逐位。
//! 4. **f64 黄金容差**:自实现 noWind f64 黄金镜像(与 `clothSolver.ts` 同构;
//!    其 240-tick 指纹已由既有 parity 测试逐位钉在 J3 fixture 上),与 f32 色序
//!    镜像做逐步(每 24 tick)位置误差对照表,断言 max ≤ 0.05 m、拉伸 ≤ 5%。
//!    受控偏差来源 = f32 量化 + 色桶序投影(构建序 → 色序),非缺陷。

use serde_json::Value;

#[path = "support/cloth_parallel_support.rs"]
mod cloth_parallel_support;

use cloth_parallel_support::*;

const WGSL: &str = include_str!("../../deep-engine/wgsl/clothSolver.wgsl");
const WGSL_SIDECAR: &str = include_str!("../../deep-engine/wgsl/clothSolver.wgsl.sha256");

// ─── f32 色序求解器(与 TS clothParallelSolver.ts 逐运算同构) ──────────────────

struct ParallelSolverF32 {
    columns: usize,
    particle_count: usize,
    state: Vec<f32>,
    /// 桶序约束:(a, b, rest)。
    constraints: Vec<(u32, u32, f32)>,
    ranges: Vec<(usize, usize)>,
    dt: f32,
    substeps: u32,
    compliance: f32,
    damping: f32,
    gravity: [f32; 3],
    kinetics_last_substep: Vec<f32>,
}

impl ParallelSolverF32 {
    fn from_fixture(config: &Value, pinned: &Value) -> Self {
        let columns = int32(&config["columns"]) as usize;
        let rows = int32(&config["rows"]) as usize;
        let spacing = num(&config["spacing"]);
        let mass = num(&config["mass"]);
        let count = columns * rows;
        let mut state = vec![0f32; count * 12];
        // 扰动流:mulberry 按 (row,col) 序,全整型逐位;布局算术在 f64 后一次舍入入 f32。
        let mut rng_state: i32 = int32(&config["seed"])
            .wrapping_add(0x9e37_79b9_u32 as i32);
        let mut next_unit = || {
            rng_state = rng_state.wrapping_add(0x6d2b_79f5);
            let t0 = rng_state as u32;
            let t1 = (t0 ^ (t0 >> 15)).wrapping_mul(t0 | 1);
            let t2 = t1 ^ t1.wrapping_add((t1 ^ (t1 >> 7)).wrapping_mul(t1 | 61));
            f64::from(t2 ^ (t2 >> 14)) / 4294967296.0
        };
        let origin = &config["origin"];
        let (ox, oy, oz) = (num(&origin[0]), num(&origin[1]), num(&origin[2]));
        let perturbation = num(&config["perturbation"]);
        let inv_mass = (1.0 / mass) as f32;
        for row in 0..rows {
            for col in 0..columns {
                let i = row * columns + col;
                let base = i * 12;
                state[base] = (ox + col as f64 * spacing) as f32;
                state[base + 1] = (oy + row as f64 * spacing) as f32;
                let delta = if perturbation > 0.0 {
                    (next_unit() - 0.5) * 2.0 * perturbation
                } else {
                    0.0
                };
                state[base + 2] = (oz + delta) as f32;
                state[base + 3] = inv_mass;
                state[base + 8] = state[base];
                state[base + 9] = state[base + 1];
                state[base + 10] = state[base + 2];
            }
        }
        // 拓扑(构建序) → 贪心着色 → 色桶排序。
        let diagonal = spacing * std::f64::consts::SQRT_2;
        let mut ca: Vec<u32> = Vec::new();
        let mut cb: Vec<u32> = Vec::new();
        let mut rest: Vec<f64> = Vec::new();
        for row in 0..rows {
            for col in 0..columns {
                let i = row * columns + col;
                if col + 1 < columns {
                    ca.push(i as u32);
                    cb.push((i + 1) as u32);
                    rest.push(spacing);
                }
                if row + 1 < rows {
                    ca.push(i as u32);
                    cb.push((i + columns) as u32);
                    rest.push(spacing);
                }
                if col + 1 < columns && row + 1 < rows {
                    ca.push(i as u32);
                    cb.push((i + columns + 1) as u32);
                    rest.push(diagonal);
                    ca.push((i + 1) as u32);
                    cb.push((i + columns) as u32);
                    rest.push(diagonal);
                }
            }
        }
        let coloring = color_constraints(&ca, &cb, count);
        let constraints = coloring
            .order
            .iter()
            .map(|&k| {
                let idx = k as usize;
                (ca[idx], cb[idx], rest[idx] as f32)
            })
            .collect();
        for pair in pinned.as_array().expect("pinned pairs") {
            let col = int32(&pair[0]) as usize;
            let row = int32(&pair[1]) as usize;
            let base = (row * columns + col) * 12;
            state[base + 3] = 0.0;
            state[base + 4] = 0.0;
            state[base + 5] = 0.0;
            state[base + 6] = 0.0;
        }
        Self {
            columns,
            particle_count: count,
            state,
            constraints,
            ranges: coloring.ranges,
            dt: num(&config["dtSeconds"]) as f32,
            substeps: u32::try_from(int32(&config["substeps"])).unwrap(),
            compliance: num(&config["compliance"]) as f32,
            damping: num(&config["damping"]) as f32,
            gravity: [
                num(&config["gravity"][0]) as f32,
                num(&config["gravity"][1]) as f32,
                num(&config["gravity"][2]) as f32,
            ],
            kinetics_last_substep: Vec::new(),
        }
    }

    fn step(&mut self) {
        let h = self.dt / self.substeps as f32;
        let alpha_tilde = self.compliance / (h * h);
        let damping_scale = 1.0 - self.damping * h;
        let inv_h = 1.0 / h;
        let [gx, gy, gz] = self.gravity;
        self.kinetics_last_substep.clear();
        for _sub in 0..self.substeps {
            // pass A:积分。
            for i in 0..self.particle_count {
                let base = i * 12;
                self.state[base + 8] = self.state[base];
                self.state[base + 9] = self.state[base + 1];
                self.state[base + 10] = self.state[base + 2];
                if self.state[base + 3] == 0.0 {
                    self.state[base + 4] = 0.0;
                    self.state[base + 5] = 0.0;
                    self.state[base + 6] = 0.0;
                    continue;
                }
                self.state[base + 4] = (self.state[base + 4] + gx * h) * damping_scale;
                self.state[base + 5] = (self.state[base + 5] + gy * h) * damping_scale;
                self.state[base + 6] = (self.state[base + 6] + gz * h) * damping_scale;
                self.state[base] += self.state[base + 4] * h;
                self.state[base + 1] += self.state[base + 5] * h;
                self.state[base + 2] += self.state[base + 6] * h;
            }
            // pass B:色序投影。
            for (start, end) in self.ranges.clone() {
                for bucket in start..end {
                    self.project_bucket(bucket, alpha_tilde);
                }
            }
            // pass C:速度回算 + 三级树归约动能。
            let workgroups = self.particle_count.div_ceil(64);
            let mut partials = vec![0f32; workgroups];
            for w in 0..workgroups {
                let mut lanes = vec![0f32; 64];
                for (lane, slot) in lanes.iter_mut().enumerate() {
                    let i = w * 64 + lane;
                    if i >= self.particle_count {
                        break;
                    }
                    let base = i * 12;
                    if self.state[base + 3] == 0.0 {
                        self.state[base + 4] = 0.0;
                        self.state[base + 5] = 0.0;
                        self.state[base + 6] = 0.0;
                        continue;
                    }
                    self.state[base + 4] = (self.state[base] - self.state[base + 8]) * inv_h;
                    self.state[base + 5] = (self.state[base + 1] - self.state[base + 9]) * inv_h;
                    self.state[base + 6] = (self.state[base + 2] - self.state[base + 10]) * inv_h;
                    let vx = self.state[base + 4];
                    let vy = self.state[base + 5];
                    let vz = self.state[base + 6];
                    *slot = tree_sum4(vx * vx, vy * vy, vz * vz, 0.0);
                }
                partials[w] = workgroup_tree_sum(&lanes);
            }
            self.kinetics_last_substep.push(host_merge_tree_sum(&partials));
        }
        assert!(
            self.state.iter().all(|value| value.is_finite()),
            "f32 parallel solver diverged"
        );
    }

    fn project_bucket(&mut self, bucket: usize, alpha_tilde: f32) {
        let (a, b, rest_length) = self.constraints[bucket];
        let (a_base, b_base) = (a as usize * 12, b as usize * 12);
        let weight_a = self.state[a_base + 3];
        let weight_b = self.state[b_base + 3];
        let denom = weight_a + weight_b;
        if denom == 0.0 {
            return;
        }
        let dx = self.state[a_base] - self.state[b_base];
        let dy = self.state[a_base + 1] - self.state[b_base + 1];
        let dz = self.state[a_base + 2] - self.state[b_base + 2];
        let len_sq = (dx * dx + dy * dy) + dz * dz;
        let len = len_sq.sqrt();
        if len == 0.0 {
            return;
        }
        let numerator = rest_length - len;
        let denominator = denom + alpha_tilde;
        let correction = numerator / denominator;
        if correction == 0.0 {
            return;
        }
        let inv_len = 1.0 / len;
        let nx = dx * inv_len;
        let ny = dy * inv_len;
        let nz = dz * inv_len;
        let scale_a = correction * weight_a;
        let scale_b = correction * weight_b;
        self.state[a_base] += nx * scale_a;
        self.state[a_base + 1] += ny * scale_a;
        self.state[a_base + 2] += nz * scale_a;
        self.state[b_base] -= nx * scale_b;
        self.state[b_base + 1] -= ny * scale_b;
        self.state[b_base + 2] -= nz * scale_b;
    }

    fn state_fingerprint32(&self) -> String {
        let n = self.particle_count;
        let mut all = Vec::with_capacity(n * 6);
        for i in 0..n {
            all.push(self.state[i * 12]);
        }
        for i in 0..n {
            all.push(self.state[i * 12 + 1]);
        }
        for i in 0..n {
            all.push(self.state[i * 12 + 2]);
        }
        for i in 0..n {
            all.push(self.state[i * 12 + 4]);
        }
        for i in 0..n {
            all.push(self.state[i * 12 + 5]);
        }
        for i in 0..n {
            all.push(self.state[i * 12 + 6]);
        }
        fingerprint_float32(&all)
    }

    fn measure_stretch(&self) -> (f32, f32) {
        let mut max = 0f32;
        let mut sum = 0f32;
        for &(a, b, rest) in &self.constraints {
            let (a_base, b_base) = (a as usize * 12, b as usize * 12);
            let dx = self.state[a_base] - self.state[b_base];
            let dy = self.state[a_base + 1] - self.state[b_base + 1];
            let dz = self.state[a_base + 2] - self.state[b_base + 2];
            let len = ((dx * dx + dy * dy) + dz * dz).sqrt();
            let ratio = (len - rest).abs() / rest;
            if ratio > max {
                max = ratio;
            }
            sum += ratio;
        }
        (max, sum / self.constraints.len() as f32)
    }
}

// ─── f64 黄金精简镜像(noWind;与 clothSolver.ts 同构,指纹由既有 parity 钉死) ──

struct GoldenSolverF64 {
    columns: usize,
    count: usize,
    px: Vec<f64>,
    py: Vec<f64>,
    pz: Vec<f64>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    vz: Vec<f64>,
    qx: Vec<f64>,
    qy: Vec<f64>,
    qz: Vec<f64>,
    inv_mass: Vec<f64>,
    ca: Vec<usize>,
    cb: Vec<usize>,
    rest: Vec<f64>,
    lambda: Vec<f64>,
    gravity: [f64; 3],
    dt_seconds: f64,
    substeps: u32,
    compliance: f64,
    damping: f64,
}

impl GoldenSolverF64 {
    fn from_fixture(config: &Value) -> Self {
        let columns = int32(&config["columns"]) as usize;
        let rows = int32(&config["rows"]) as usize;
        let mass = num(&config["mass"]);
        let count = columns * rows;
        let mut solver = Self {
            columns,
            count,
            px: vec![0.0; count],
            py: vec![0.0; count],
            pz: vec![0.0; count],
            vx: vec![0.0; count],
            vy: vec![0.0; count],
            vz: vec![0.0; count],
            qx: vec![0.0; count],
            qy: vec![0.0; count],
            qz: vec![0.0; count],
            inv_mass: vec![1.0 / mass; count],
            ca: Vec::new(),
            cb: Vec::new(),
            rest: Vec::new(),
            lambda: Vec::new(),
            gravity: [
                num(&config["gravity"][0]),
                num(&config["gravity"][1]),
                num(&config["gravity"][2]),
            ],
            dt_seconds: num(&config["dtSeconds"]),
            substeps: u32::try_from(int32(&config["substeps"])).unwrap(),
            compliance: num(&config["compliance"]),
            damping: num(&config["damping"]),
        };
        let mut rng_state: i32 = int32(&config["seed"]).wrapping_add(0x9e37_79b9_u32 as i32);
        let mut next_unit = || {
            rng_state = rng_state.wrapping_add(0x6d2b_79f5);
            let t0 = rng_state as u32;
            let t1 = (t0 ^ (t0 >> 15)).wrapping_mul(t0 | 1);
            let t2 = t1 ^ t1.wrapping_add((t1 ^ (t1 >> 7)).wrapping_mul(t1 | 61));
            f64::from(t2 ^ (t2 >> 14)) / 4294967296.0
        };
        let origin = &config["origin"];
        let (ox, oy, oz) = (num(&origin[0]), num(&origin[1]), num(&origin[2]));
        let perturbation = num(&config["perturbation"]);
        let spacing = num(&config["spacing"]);
        for row in 0..rows {
            for col in 0..columns {
                let i = row * columns + col;
                solver.px[i] = ox + col as f64 * spacing;
                solver.py[i] = oy + row as f64 * spacing;
                let delta = if perturbation > 0.0 {
                    (next_unit() - 0.5) * 2.0 * perturbation
                } else {
                    0.0
                };
                solver.pz[i] = oz + delta;
            }
        }
        let diagonal = spacing * std::f64::consts::SQRT_2;
        for row in 0..rows {
            for col in 0..columns {
                let i = row * columns + col;
                if col + 1 < columns {
                    solver.push_constraint(i, i + 1, spacing);
                }
                if row + 1 < rows {
                    solver.push_constraint(i, i + columns, spacing);
                }
                if col + 1 < columns && row + 1 < rows {
                    solver.push_constraint(i, i + columns + 1, diagonal);
                    solver.push_constraint(i + 1, i + columns, diagonal);
                }
            }
        }
        solver
    }

    fn push_constraint(&mut self, a: usize, b: usize, rest: f64) {
        self.ca.push(a);
        self.cb.push(b);
        self.rest.push(rest);
        self.lambda.push(0.0);
    }

    fn step(&mut self) {
        let h = self.dt_seconds / f64::from(self.substeps);
        let damping_scale = 1.0 - self.damping * h;
        let alpha_tilde = self.compliance / (h * h);
        for _sub in 0..self.substeps {
            self.qx.copy_from_slice(&self.px);
            self.qy.copy_from_slice(&self.py);
            self.qz.copy_from_slice(&self.pz);
            for i in 0..self.count {
                if self.inv_mass[i] == 0.0 {
                    continue;
                }
                self.vx[i] = (self.vx[i] + self.gravity[0] * h) * damping_scale;
                self.vy[i] = (self.vy[i] + self.gravity[1] * h) * damping_scale;
                self.vz[i] = (self.vz[i] + self.gravity[2] * h) * damping_scale;
                self.px[i] += self.vx[i] * h;
                self.py[i] += self.vy[i] * h;
                self.pz[i] += self.vz[i] * h;
            }
            for value in self.lambda.iter_mut() {
                *value = 0.0;
            }
            for k in 0..self.rest.len() {
                self.project(k, alpha_tilde);
            }
            let inv_h = 1.0 / h;
            for i in 0..self.count {
                if self.inv_mass[i] == 0.0 {
                    self.vx[i] = 0.0;
                    self.vy[i] = 0.0;
                    self.vz[i] = 0.0;
                    continue;
                }
                self.vx[i] = (self.px[i] - self.qx[i]) * inv_h;
                self.vy[i] = (self.py[i] - self.qy[i]) * inv_h;
                self.vz[i] = (self.pz[i] - self.qz[i]) * inv_h;
            }
        }
        assert!(
            self.px.iter().chain(&self.py).chain(&self.pz).all(|value| value.is_finite()),
            "golden solver diverged"
        );
    }

    fn project(&mut self, k: usize, alpha_tilde: f64) {
        let (a, b) = (self.ca[k], self.cb[k]);
        let (wa, wb) = (self.inv_mass[a], self.inv_mass[b]);
        let denom = wa + wb;
        if denom == 0.0 {
            return;
        }
        let dx = self.px[a] - self.px[b];
        let dy = self.py[a] - self.py[b];
        let dz = self.pz[a] - self.pz[b];
        let len = (dx * dx + dy * dy + dz * dz).sqrt();
        if len == 0.0 {
            return;
        }
        let lambda = (self.rest[k] - len - alpha_tilde * self.lambda[k]) / (denom + alpha_tilde);
        self.lambda[k] += lambda;
        let (nx, ny, nz) = (dx / len, dy / len, dz / len);
        self.px[a] += wa * lambda * nx;
        self.py[a] += wa * lambda * ny;
        self.pz[a] += wa * lambda * nz;
        self.px[b] -= wb * lambda * nx;
        self.py[b] -= wb * lambda * ny;
        self.pz[b] -= wb * lambda * nz;
    }

    fn set_pinned(&mut self, col: usize, row: usize) {
        let i = row * self.columns + col;
        self.inv_mass[i] = 0.0;
        self.vx[i] = 0.0;
        self.vy[i] = 0.0;
        self.vz[i] = 0.0;
    }
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

/// 门 1:WGSL 真源 SHA-256 与 sidecar 夹具一致(TS 半同夹具,跨宿主三方可证)。
#[test]
fn wgsl_source_matches_pinned_sidecar_checksum() {
    let sidecar = WGSL_SIDECAR.trim();
    let (expected_checksum, expected_len) = sidecar
        .split_once(' ')
        .expect("sidecar format '<hex> <byteLen>'");
    assert_eq!(expected_checksum.len(), 64, "sidecar checksum must be sha256 hex");
    assert_eq!(sha256_hex(WGSL.as_bytes()), expected_checksum, "WGSL content drifted from the pinned sidecar");
    assert_eq!(WGSL.as_bytes().len().to_string(), expected_len, "WGSL byte length drifted");
}

/// 门 2:着色逐位(网格 + 非对称小拓扑)+ 独立正确性断言。
#[test]
fn greedy_coloring_matches_fixture_bitwise_and_is_valid() {
    let fixture = fixture();
    let grid = &fixture["coloring"]["grid"];
    let columns = int32(&fixture["grid"]["columns"]) as usize;
    let rows = int32(&fixture["grid"]["rows"]) as usize;
    let spacing = num(&fixture["grid"]["spacing"]);
    let (ca, cb) = grid_topology(columns, rows);
    let coloring = color_constraints(&ca, &cb, columns * rows);
    assert_coloring_valid(&coloring, &ca, &cb);
    assert_coloring_matches(&coloring, grid);
    assert_eq!(grid["constraintCount"].as_u64().unwrap() as usize, ca.len());
    assert_eq!(grid["particleCount"].as_u64().unwrap() as usize, columns * rows);

    let small = &fixture["coloring"]["small"];
    let small_a = u32_list(&small["a"]);
    let small_b = u32_list(&small["b"]);
    let small_coloring = color_constraints(&small_a, &small_b, small["particleCount"].as_u64().unwrap() as usize);
    assert_coloring_valid(&small_coloring, &small_a, &small_b);
    assert_coloring_matches(&small_coloring, small);
    let _ = spacing;
}

/// 门 3:f32 色序求解器 240 ticks 逐位(指纹全表 + 动能 + 拉伸)。
#[test]
fn f32_colored_solver_replays_fixture_bitwise() {
    let fixture = fixture();
    let config = &fixture["grid"];
    let pinned = &fixture["grid"]["pinned"];
    let mut solver = ParallelSolverF32::from_fixture(config, pinned);
    let ticks = fixture["grid"]["ticks"].as_u64().unwrap() as usize;
    let mut per24: Vec<String> = Vec::new();
    for t in 1..=ticks {
        solver.step();
        if t % 24 == 0 {
            per24.push(solver.state_fingerprint32());
        }
    }
    assert_eq!(
        per24,
        fixture["replay"]["fingerprints"]["per24"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        "per-24-tick f32 fingerprint table drifted from the TS-generated fixture"
    );
    let kinetic = *solver.kinetics_last_substep.last().unwrap();
    let kinetic_expected = num(&fixture["replay"]["kineticLastSubstep"]) as f32;
    assert_eq!(kinetic, kinetic_expected, "final-substep kinetic (fixed reduction tree) drifted bitwise");
    let (max_ratio, mean_ratio) = solver.measure_stretch();
    let expected_max = num(&fixture["replay"]["finalStretchMaxRatio"]) as f32;
    let expected_mean = num(&fixture["replay"]["finalStretchMeanRatio"]) as f32;
    assert_eq!(max_ratio, expected_max, "stretch maxRatio drifted bitwise");
    assert_eq!(mean_ratio, expected_mean, "stretch meanRatio drifted bitwise");
}

/// 门 4:f32 色序 vs f64 黄金逐步位置误差对照表(240 ticks,容差 0.05 m)。
#[test]
fn f32_colored_solver_stays_within_tolerance_of_f64_golden_stepwise() {
    let fixture = fixture();
    let config = &fixture["grid"];
    let pinned = &fixture["grid"]["pinned"];
    let mut golden = GoldenSolverF64::from_fixture(config);
    for pair in pinned.as_array().unwrap() {
        golden.set_pinned(int32(&pair[0]) as usize, int32(&pair[1]) as usize);
    }
    let mut f32_solver = ParallelSolverF32::from_fixture(config, pinned);
    let ticks = fixture["grid"]["ticks"].as_u64().unwrap() as usize;
    let tolerance = num(&fixture["tolerances"]["maxPositionErrorMeters"]);
    let stretch_tolerance = num(&fixture["tolerances"]["maxStretchRatio"]);
    println!("tick | fp32(sim) | maxPosErr(m) | meanPosErr(m)");
    for t in 1..=ticks {
        golden.step();
        f32_solver.step();
        if t % 24 != 0 {
            continue;
        }
        let (mut max, mut sum) = (0f64, 0f64);
        for i in 0..f32_solver.particle_count {
            let base = i * 12;
            let dx = f64::from(f32_solver.state[base]) - golden.px[i];
            let dy = f64::from(f32_solver.state[base + 1]) - golden.py[i];
            let dz = f64::from(f32_solver.state[base + 2]) - golden.pz[i];
            let err = (dx * dx + dy * dy + dz * dz).sqrt();
            max = max.max(err);
            sum += err;
        }
        let mean = sum / f32_solver.particle_count as f64;
        println!("{t} | {} | {max:.3e} | {mean:.3e}", f32_solver.state_fingerprint32());
        assert!(max <= tolerance, "tick {t}: max position error {max} exceeds {tolerance}");
        assert!(mean <= tolerance / 5.0, "tick {t}: mean position error {mean} exceeds tolerance/5");
    }
    let (max_ratio, _) = f32_solver.measure_stretch();
    assert!(
        max_ratio <= stretch_tolerance as f32,
        "stretch maxRatio {max_ratio} exceeds the {stretch_tolerance} acceptance band"
    );
}

/// 门 5:同输入双跑逐位(重放确定性)。
#[test]
fn f32_colored_solver_is_bit_exact_across_repetitions() {
    let fixture = fixture();
    let config = &fixture["grid"];
    let pinned = &fixture["grid"]["pinned"];
    let run = || {
        let mut solver = ParallelSolverF32::from_fixture(config, pinned);
        for _ in 0..64 {
            solver.step();
        }
        (solver.state_fingerprint32(), solver.kinetics_last_substep.clone())
    };
    assert_eq!(run(), run(), "double run must be bitwise identical");
}

/// 门 6:固定归约树逐位(树 ≠ 线性序的定序证据 + 宿主合并树)。
#[test]
fn fixed_reduction_trees_match_fixture_bitwise() {
    let fixture = fixture();
    let tree = &fixture["treeReduction"];
    let lanes: Vec<f32> = u32_list(&tree["lanesF32Bits"])
        .iter()
        .map(|&bits| f32::from_bits(bits))
        .collect();
    assert_eq!(lanes.len(), 64);
    let tree_sum = workgroup_tree_sum(&lanes);
    assert_eq!(
        tree_sum,
        num(&tree["workgroupTreeSum"]) as f32,
        "workgroup tree sum drifted"
    );
    let mut linear = 0f32;
    for &lane in &lanes {
        linear = linear + lane;
    }
    assert_ne!(
        tree_sum, linear,
        "tree and linear sums collapsed; the ordering contract is untestable"
    );
    let partials: Vec<f32> = tree["hostPartials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| num(value) as f32)
        .collect();
    assert_eq!(
        host_merge_tree_sum(&partials),
        num(&tree["hostMergeTreeSum"]) as f32,
        "host merge tree sum drifted"
    );
}

/// 门 7:f32 指纹原语逐位(空向量锚点)。
#[test]
fn fingerprint32_matches_fixture_anchor() {
    let fixture = fixture();
    let expected = fixture["replay"]["fingerprintOfEmptyState"].as_str().unwrap();
    assert_eq!(fingerprint_float32(&[0.0f32; 6]), expected);
}

/// 12×12 网格拓扑(构建序:右/下/两对角;与黄金构造一致)。
fn grid_topology(columns: usize, rows: usize) -> (Vec<u32>, Vec<u32>) {
    let mut a = Vec::new();
    let mut b = Vec::new();
    for row in 0..rows {
        for col in 0..columns {
            let i = row * columns + col;
            if col + 1 < columns {
                a.push(i as u32);
                b.push((i + 1) as u32);
            }
            if row + 1 < rows {
                a.push(i as u32);
                b.push((i + columns) as u32);
            }
            if col + 1 < columns && row + 1 < rows {
                a.push(i as u32);
                b.push((i + columns + 1) as u32);
                a.push((i + 1) as u32);
                b.push((i + columns) as u32);
            }
        }
    }
    (a, b)
}
