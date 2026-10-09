//! J3 Gate C 扩族:布料/软体 CPU 参考求解器的跨端指纹对拍(Native 侧)。
//!
//! TS 权威实现 = F6 已提交基线(d03d8c60):
//! `packages/deep-engine/src/physics/clothSolver.ts` / `softBodySolver.ts`。
//! 本文件是同一确定性合同的 Rust 镜像:同 seed、同输入、同步数(240/120 tick)、
//! 全 f64、同一运算顺序。逐位一致的达成条件与镜像纪律:
//! - JS 数值即 f64;Rust 侧不使用 `mul_add`/`hypot`,禁止任何自动 FMA(Rust 从不合浮点);
//! - `Math.imul`/`| 0`/`>>>` 全部按 u32 wrapping 语义镜像(低位 32 位乘法 = wrapping_mul);
//! - `Math.sqrt`/四则运算两侧同为 IEEE-754 正确舍入,运算顺序逐表达式对齐;
//! - `Math.hypot` 是唯一无跨引擎合同的运算:TS 软体静止边长用它计算。本 fixture 的
//!   立方体全部为轴对齐/主对角棱,rest 长度恰为 0.5(2 的幂可精确缩放,V8 缩放式
//!   hypot 与朴素 sqrt(x²+y²+z²) 逐位相等);下方测试显式断言这一点,
//!   换非 2 的幂几何时必须先重审该前提。
//!
//! 指纹 = `fingerprintFloat64` 同式:FNV-1a 双车道(正/反字节序)滚动哈希
//! [px,py,pz,vx,vy,vz] 的 f64 位模式(小端),输出 16 位十六进制。
//! 场景与 TS 指纹 golden:`fixtures/cloth-softbody-solver-parity-v1.json`
//! (由真实 TS 求解器生成;TS 侧 `clothSoftBodyCrossLanguageParity.test.ts` 持续重放校验,
//! golden 与 TS 漂移会在 TS 侧先红)。

use std::collections::HashSet;

use deep_engine_native::runtime_package::parse_and_validate_dynamic_scene_runtime;
use serde_json::Value;

#[path = "support/cloth_softbody_support.rs"]
mod cloth_softbody_support;

use cloth_softbody_support::*;

const FIXTURE: &str = include_str!("fixtures/cloth-softbody-solver-parity-v1.json");

// ─── 软体镜像(四面体质点体,XPBD 体积守恒 + 边距离约束;softBodySolver.ts 镜像) ──

struct SoftBodySolver {
    count: usize,
    px: Vec<f64>,
    py: Vec<f64>,
    pz: Vec<f64>,
    vx: Vec<f64>,
    vy: Vec<f64>,
    vz: Vec<f64>,
    inv_mass: Vec<f64>,
    qx: Vec<f64>,
    qy: Vec<f64>,
    qz: Vec<f64>,
    tets: Vec<i32>,
    rest_volume: Vec<f64>,
    edges: Vec<i32>,
    edge_rest: Vec<f64>,
    lambda_volume: Vec<f64>,
    lambda_edge: Vec<f64>,
    gravity: [f64; 3],
    dt_seconds: f64,
    substeps: u32,
    compliance_distance: f64,
    compliance_volume: f64,
    damping: f64,
    tick: u64,
}

impl SoftBodySolver {
    fn from_config(config: &Value) -> Self {
        let positions = config["positions"].as_array().expect("position list");
        let tets_in = config["tets"].as_array().expect("tet list");
        let mass = num(&config["mass"]);
        let count = positions.len();
        let mut solver = Self {
            count,
            px: vec![0.0; count],
            py: vec![0.0; count],
            pz: vec![0.0; count],
            vx: vec![0.0; count],
            vy: vec![0.0; count],
            vz: vec![0.0; count],
            inv_mass: vec![1.0 / mass; count],
            qx: vec![0.0; count],
            qy: vec![0.0; count],
            qz: vec![0.0; count],
            tets: Vec::with_capacity(tets_in.len() * 4),
            rest_volume: Vec::with_capacity(tets_in.len()),
            edges: Vec::new(),
            edge_rest: Vec::new(),
            lambda_volume: vec![0.0; tets_in.len()],
            lambda_edge: Vec::new(),
            gravity: [
                num(&config["gravity"][0]),
                num(&config["gravity"][1]),
                num(&config["gravity"][2]),
            ],
            dt_seconds: num(&config["dtSeconds"]),
            substeps: u32::try_from(int32(&config["substeps"])).unwrap(),
            compliance_distance: num(&config["complianceDistance"]),
            compliance_volume: num(&config["complianceVolume"]),
            damping: num(&config["damping"]),
            tick: 0,
        };
        for (i, position) in positions.iter().enumerate() {
            solver.px[i] = num(&position[0]);
            solver.py[i] = num(&position[1]);
            solver.pz[i] = num(&position[2]);
        }
        for pinned in config["pinned"].as_array().expect("pinned list") {
            solver.inv_mass[usize::try_from(int32(pinned)).unwrap()] = 0.0;
        }
        // 环绕规整:负体积交换中间两个索引,统一为正环绕(确定性,不改变几何)。
        for tet in tets_in {
            let indices = [
                usize::try_from(int32(&tet[0])).unwrap(),
                usize::try_from(int32(&tet[1])).unwrap(),
                usize::try_from(int32(&tet[2])).unwrap(),
                usize::try_from(int32(&tet[3])).unwrap(),
            ];
            let volume = solver.signed_volume(indices[0], indices[1], indices[2], indices[3]);
            if volume > 0.0 {
                solver.tets.extend_from_slice(&(indices.map(|i| i as i32)));
                solver.rest_volume.push(volume);
            } else {
                solver.tets.extend_from_slice(&[
                    indices[0] as i32,
                    indices[2] as i32,
                    indices[1] as i32,
                    indices[3] as i32,
                ]);
                solver.rest_volume.push(-volume);
            }
        }
        // 唯一边集合(键 = a·n + b,首次出现保留;遍历序固定)。
        let mut seen: HashSet<u64> = HashSet::new();
        for t in 0..solver.rest_volume.len() {
            let ids = [
                solver.tets[4 * t],
                solver.tets[4 * t + 1],
                solver.tets[4 * t + 2],
                solver.tets[4 * t + 3],
            ];
            for a in 0..4 {
                for b in a + 1..4 {
                    let (lo, hi) = (ids[a].min(ids[b]), ids[a].max(ids[b]));
                    if seen.insert(lo as u64 * count as u64 + hi as u64) {
                        solver.edges.push(lo);
                        solver.edges.push(hi);
                    }
                }
            }
        }
        solver.lambda_edge = vec![0.0; solver.edges.len() / 2];
        solver.edge_rest = vec![0.0; solver.edges.len() / 2];
        for e in 0..solver.edge_rest.len() {
            let (a, b) = (
                solver.edges[2 * e] as usize,
                solver.edges[2 * e + 1] as usize,
            );
            let dx = solver.px[a] - solver.px[b];
            let dy = solver.py[a] - solver.py[b];
            let dz = solver.pz[a] - solver.pz[b];
            solver.edge_rest[e] = (dx * dx + dy * dy + dz * dz).sqrt();
            // 见文件头:V8 缩放式 Math.hypot 与朴素 sqrt 只对 2 的幂几何保证逐位一致;
            // 本 fixture 的静止边长必须恰为立方体棱/面对角/主对角三族
            // (0.5·√k,k=1..3,均为 2 的幂缩放),否则该前提失效。
            let allowed = [0.5, 0.5 * std::f64::consts::SQRT_2, 0.5 * 3.0f64.sqrt()];
            assert!(
                allowed.contains(&solver.edge_rest[e]),
                "edge {e} rest length {} is not a dyadic cube edge (0.5·√k)",
                solver.edge_rest[e]
            );
        }
        solver
    }

    fn signed_volume(&self, i0: usize, i1: usize, i2: usize, i3: usize) -> f64 {
        let ax = self.px[i0] - self.px[i3];
        let ay = self.py[i0] - self.py[i3];
        let az = self.pz[i0] - self.pz[i3];
        let bx = self.px[i1] - self.px[i3];
        let by = self.py[i1] - self.py[i3];
        let bz = self.pz[i1] - self.pz[i3];
        let cx = self.px[i2] - self.px[i3];
        let cy = self.py[i2] - self.py[i3];
        let cz = self.pz[i2] - self.pz[i3];
        let cross_x = by * cz - bz * cy;
        let cross_y = bz * cx - bx * cz;
        let cross_z = bx * cy - by * cx;
        (ax * cross_x + ay * cross_y + az * cross_z) / 6.0
    }

    fn step(&mut self) {
        let h = self.dt_seconds / f64::from(self.substeps);
        let damping_scale = 1.0 - self.damping * h;
        let alpha_edge = self.compliance_distance / (h * h);
        let alpha_volume = self.compliance_volume / (h * h);
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
            for value in self.lambda_edge.iter_mut() {
                *value = 0.0;
            }
            for value in self.lambda_volume.iter_mut() {
                *value = 0.0;
            }
            for e in 0..self.edge_rest.len() {
                self.project_edge(e, alpha_edge);
            }
            for t in 0..self.rest_volume.len() {
                self.project_volume(t, alpha_volume);
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
        self.tick += 1;
        assert!(
            self.px
                .iter()
                .chain(&self.py)
                .chain(&self.pz)
                .all(|value| value.is_finite()),
            "soft body solver diverged"
        );
    }

    fn project_edge(&mut self, e: usize, alpha_tilde: f64) {
        let (a, b) = (self.edges[2 * e] as usize, self.edges[2 * e + 1] as usize);
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
        let lambda =
            (self.edge_rest[e] - len - alpha_tilde * self.lambda_edge[e]) / (denom + alpha_tilde);
        self.lambda_edge[e] += lambda;
        let (nx, ny, nz) = (dx / len, dy / len, dz / len);
        self.px[a] += wa * lambda * nx;
        self.py[a] += wa * lambda * ny;
        self.pz[a] += wa * lambda * nz;
        self.px[b] -= wb * lambda * nx;
        self.py[b] -= wb * lambda * ny;
        self.pz[b] -= wb * lambda * nz;
    }

    fn project_volume(&mut self, t: usize, alpha_tilde: f64) {
        let indices = [
            self.tets[4 * t] as usize,
            self.tets[4 * t + 1] as usize,
            self.tets[4 * t + 2] as usize,
            self.tets[4 * t + 3] as usize,
        ];
        let (i0, i1, i2, i3) = (indices[0], indices[1], indices[2], indices[3]);
        // ∇_{p0} = (p1−p3)×(p2−p3)/6;∇_{p1} = (p2−p3)×(p0−p3)/6;∇_{p2} = (p0−p3)×(p1−p3)/6;
        // ∇_{p3} = −Σ∇。逐分量顺序与 TS #projectVolume 一致。
        let e1 = (
            self.px[i1] - self.px[i3],
            self.py[i1] - self.py[i3],
            self.pz[i1] - self.pz[i3],
        );
        let e2 = (
            self.px[i2] - self.px[i3],
            self.py[i2] - self.py[i3],
            self.pz[i2] - self.pz[i3],
        );
        let mut gx = [0.0; 4];
        let mut gy = [0.0; 4];
        let mut gz = [0.0; 4];
        gx[0] = (e1.1 * e2.2 - e1.2 * e2.1) / 6.0;
        gy[0] = (e1.2 * e2.0 - e1.0 * e2.2) / 6.0;
        gz[0] = (e1.0 * e2.1 - e1.1 * e2.0) / 6.0;
        let f1 = (
            self.px[i2] - self.px[i3],
            self.py[i2] - self.py[i3],
            self.pz[i2] - self.pz[i3],
        );
        let f2 = (
            self.px[i0] - self.px[i3],
            self.py[i0] - self.py[i3],
            self.pz[i0] - self.pz[i3],
        );
        gx[1] = (f1.1 * f2.2 - f1.2 * f2.1) / 6.0;
        gy[1] = (f1.2 * f2.0 - f1.0 * f2.2) / 6.0;
        gz[1] = (f1.0 * f2.1 - f1.1 * f2.0) / 6.0;
        let h1 = (
            self.px[i0] - self.px[i3],
            self.py[i0] - self.py[i3],
            self.pz[i0] - self.pz[i3],
        );
        let h2 = (
            self.px[i1] - self.px[i3],
            self.py[i1] - self.py[i3],
            self.pz[i1] - self.pz[i3],
        );
        gx[2] = (h1.1 * h2.2 - h1.2 * h2.1) / 6.0;
        gy[2] = (h1.2 * h2.0 - h1.0 * h2.2) / 6.0;
        gz[2] = (h1.0 * h2.1 - h1.1 * h2.0) / 6.0;
        gx[3] = -(gx[0] + gx[1] + gx[2]);
        gy[3] = -(gy[0] + gy[1] + gy[2]);
        gz[3] = -(gz[0] + gz[1] + gz[2]);
        let ws = [
            self.inv_mass[i0],
            self.inv_mass[i1],
            self.inv_mass[i2],
            self.inv_mass[i3],
        ];
        let mut denom_w = 0.0;
        for i in 0..4 {
            denom_w += ws[i] * (gx[i] * gx[i] + gy[i] * gy[i] + gz[i] * gz[i]);
        }
        if denom_w == 0.0 {
            return;
        }
        let volume = self.signed_volume(i0, i1, i2, i3);
        let lambda = (self.rest_volume[t] - volume - alpha_tilde * self.lambda_volume[t])
            / (denom_w + alpha_tilde);
        self.lambda_volume[t] += lambda;
        for i in 0..4 {
            let target = indices[i];
            let scale = ws[i] * lambda;
            self.px[target] += scale * gx[i];
            self.py[target] += scale * gy[i];
            self.pz[target] += scale * gz[i];
        }
    }
}

// ─── 场景驱动与断言 ───────────────────────────────────────────────────────────

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("parity fixture parses")
}

/// 运行软体场景并返回(初始指纹, 终态指纹, (tets, edges))。
fn run_soft_body(config: &Value, ticks: u64) -> (String, String, usize, usize) {
    let mut solver = SoftBodySolver::from_config(config);
    let initial = state_fingerprint(
        &solver.px, &solver.py, &solver.pz, &solver.vx, &solver.vy, &solver.vz,
    );
    for _ in 0..ticks {
        solver.step();
    }
    let fingerprint = state_fingerprint(
        &solver.px, &solver.py, &solver.pz, &solver.vx, &solver.vy, &solver.vz,
    );
    (
        initial,
        fingerprint,
        solver.rest_volume.len(),
        solver.edge_rest.len(),
    )
}

fn assert_cloth_scenario(fixture: &Value, scenario_key: &str, config_key: &str) {
    let cloth = &fixture["cloth"];
    let scenario = &cloth[scenario_key];
    let (initial, fingerprint, constraints) = run_cloth(
        &cloth[config_key],
        &cloth["pinned"],
        scenario["ticks"].as_u64().unwrap(),
    );
    assert_eq!(
        initial, scenario["initialFingerprint"],
        "cloth {scenario_key} initial state drifted"
    );
    assert_eq!(
        fingerprint, scenario["fingerprint"],
        "cloth {scenario_key} 240-tick fingerprint drifted from the TS golden"
    );
    assert_eq!(
        constraints,
        scenario["constraints"].as_u64().unwrap() as usize
    );
}

#[test]
fn cloth_no_wind_240_ticks_matches_ts_fingerprint() {
    assert_cloth_scenario(&fixture(), "noWind", "config");
}

#[test]
fn cloth_wind_240_ticks_matches_ts_fingerprint() {
    assert_cloth_scenario(&fixture(), "wind", "windConfig");
}

#[test]
fn softbody_cube_gravity_240_ticks_matches_ts_fingerprint() {
    let fixture = fixture();
    let soft = &fixture["softBody"];
    let (initial, fingerprint, tets, edges) = run_soft_body(
        &soft["config"],
        soft["cubeGravity"]["ticks"].as_u64().unwrap(),
    );
    assert_eq!(initial, soft["cubeGravity"]["initialFingerprint"]);
    assert_eq!(
        fingerprint, soft["cubeGravity"]["fingerprint"],
        "soft body cube-gravity fingerprint drifted from the TS golden"
    );
    assert_eq!(
        (tets, edges),
        (
            soft["cubeGravity"]["tets"].as_u64().unwrap() as usize,
            soft["cubeGravity"]["edges"].as_u64().unwrap() as usize
        )
    );
}

#[test]
fn softbody_zero_gravity_state_is_frozen_and_matches_ts_fingerprint() {
    let fixture = fixture();
    let soft = &fixture["softBody"];
    let (initial, fingerprint, _, _) = run_soft_body(
        &soft["zeroGravityConfig"],
        soft["cubeZeroGravity"]["ticks"].as_u64().unwrap(),
    );
    assert_eq!(initial, fingerprint, "zero-gravity state must be frozen");
    assert_eq!(fingerprint, soft["cubeZeroGravity"]["fingerprint"]);
}

#[test]
fn native_mirror_runs_are_bit_exact_across_repetitions() {
    let fixture = fixture();
    let cloth = &fixture["cloth"];
    let first = run_cloth(
        &cloth["windConfig"],
        &cloth["pinned"],
        cloth["wind"]["ticks"].as_u64().unwrap(),
    );
    let repeat = run_cloth(
        &cloth["windConfig"],
        &cloth["pinned"],
        cloth["wind"]["ticks"].as_u64().unwrap(),
    );
    assert_eq!(first, repeat, "cloth mirror must be bit-exact across runs");
    let soft = &fixture["softBody"];
    let soft_first = run_soft_body(
        &soft["config"],
        soft["cubeGravity"]["ticks"].as_u64().unwrap(),
    );
    let soft_repeat = run_soft_body(
        &soft["config"],
        soft["cubeGravity"]["ticks"].as_u64().unwrap(),
    );
    assert_eq!(
        soft_first, soft_repeat,
        "soft body mirror must be bit-exact across runs"
    );
}

/// 场景同输入必须过生产动态场景合同(F6 布料/软体通道 + 预算护栏),fail-closed。
#[test]
fn parity_scenarios_pass_the_dynamic_scene_production_contract() {
    let fixture = fixture();
    let cloth = &fixture["cloth"]["config"];
    let pinned: Vec<u32> = fixture["cloth"]["pinned"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            let row = int32(&pair[1]);
            let col = int32(&pair[0]);
            let columns = int32(&cloth["columns"]);
            (row * columns + col) as u32
        })
        .collect();
    let soft = &fixture["softBody"]["config"];
    let runtime = serde_json::json!({
        "schema": "deep-engine.dynamic-runtime", "schemaVersion": 3,
        "id": "cloth-softbody-parity", "revision": 1,
        "physics": {
            "schema": "deep-engine.physics-runtime", "schemaVersion": 1,
            "enabled": true, "playing": true, "gravity": [0.0, -9.81, 0.0],
            "bodies": [{
                "id": "body-parity-anchor", "type": "fixed",
                "initialPose": {"translation": [0.0, 0.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0]},
                "mass": 1.0, "friction": 0.6, "restitution": 0.0,
                "collider": {"kind": "render-bounds", "instanceIds": ["parity-anchor"]}
            }],
            "joints": [],
            "softBodies": [
                {
                    "kind": "cloth", "id": "cloth.parity",
                    "mass": cloth["mass"], "damping": cloth["damping"], "substeps": cloth["substeps"],
                    "pinned": pinned, "columns": cloth["columns"], "rows": cloth["rows"],
                    "spacing": cloth["spacing"], "compliance": cloth["compliance"],
                    "perturbation": cloth["perturbation"], "seed": cloth["seed"],
                    "origin": cloth["origin"],
                    "wind": {
                        "direction": fixture["cloth"]["windConfig"]["wind"]["direction"],
                        "baseSpeed": fixture["cloth"]["windConfig"]["wind"]["baseSpeed"],
                        "gustFrequency": fixture["cloth"]["windConfig"]["wind"]["gustFrequency"],
                        "spatialScale": fixture["cloth"]["windConfig"]["wind"]["spatialScale"],
                        "seed": fixture["cloth"]["windConfig"]["wind"]["seed"],
                    },
                },
                {
                    "kind": "soft-body", "id": "softbody.parity",
                    "mass": soft["mass"], "damping": soft["damping"], "substeps": soft["substeps"],
                    "pinned": soft["pinned"], "positions": soft["positions"], "tets": soft["tets"],
                    "complianceDistance": soft["complianceDistance"],
                    "complianceVolume": soft["complianceVolume"],
                },
            ],
        },
    });
    let parsed = parse_and_validate_dynamic_scene_runtime(&runtime)
        .expect("parity scenarios must pass the production dynamic scene contract");
    let physics = parsed.physics.as_ref().expect("physics runtime");
    assert_eq!(
        physics.soft_bodies.len(),
        2,
        "cloth + soft-body channels must be present"
    );
    assert_eq!(physics.soft_bodies[0].kind, "cloth");
    assert_eq!(physics.soft_bodies[1].kind, "soft-body");
}
