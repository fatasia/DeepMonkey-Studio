//! J3 Gate C 布料 CPU 参考求解器镜像与确定性原语,
//! 自 `cloth_softbody_solver_parity.rs` 原样拆出(除可见性(`pub`)外逐字未改)。

use serde_json::Value;

// ─── 确定性原语(TS terrainRandom.ts / clothSolver.ts 内联流逐位镜像) ──────────

/// JS `| 0`(ToInt32):截断后按 2^32 取模再按有符号解释。Rust `as i32` 对超范围
/// f64 是饱和而非回绕,故显式实现 ToInt32 语义。
fn to_int32(value: f64) -> i32 {
    let truncated = value.trunc();
    (truncated as i64).rem_euclid(1 << 32) as u32 as i32
}

/// `hashGrid2D`:splitmix 风格格点哈希,仅 32 位整型运算。
fn hash_grid_2d(x: i32, z: i32, seed: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x27d4eb2d)
        ^ (z as u32).wrapping_mul(0x165667b1)
        ^ (seed as u32).wrapping_mul(0x9e3779b9);
    h = (h ^ (h >> 15)).wrapping_mul(0x2c1b3c6d);
    h = (h ^ (h >> 12)).wrapping_mul(0x297a2d39);
    h ^= h >> 15;
    h
}

const INV_UINT32: f64 = 1.0 / 4294967296.0;

/// `createValueNoise2D`:格点哈希 + 双线性插值 + quintic 平滑,输出 [0,1)。
fn value_noise_2d(seed: i32, x: f64, z: f64) -> f64 {
    let xi = x.floor();
    let zi = z.floor();
    let tx = x - xi;
    let tz = z - zi;
    // smoothQuintic:t*t*t*(t*(t*6-15)+10)
    let sx = tx * tx * tx * (tx * (tx * 6.0 - 15.0) + 10.0);
    let sz = tz * tz * tz * (tz * (tz * 6.0 - 15.0) + 10.0);
    let v00 = f64::from(hash_grid_2d(to_int32(xi), to_int32(zi), seed)) * INV_UINT32;
    let v10 = f64::from(hash_grid_2d(to_int32(xi) + 1, to_int32(zi), seed)) * INV_UINT32;
    let v01 = f64::from(hash_grid_2d(to_int32(xi), to_int32(zi) + 1, seed)) * INV_UINT32;
    let v11 = f64::from(hash_grid_2d(to_int32(xi) + 1, to_int32(zi) + 1, seed)) * INV_UINT32;
    let a = v00 + (v10 - v00) * sx;
    let b = v01 + (v11 - v01) * sx;
    a + (b - a) * sz
}

/// `fingerprintFloat64`:FNV-1a 双车道(正/反字节)滚动哈希 f64 位模式(小端)。
fn fingerprint_float64(values: &[f64]) -> String {
    let bytes: Vec<u8> = values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let mut forward: u32 = 0x811c9dc5;
    let mut backward: u32 = 0x811c9dc5;
    for (index, byte) in bytes.iter().enumerate() {
        forward = (forward ^ u32::from(*byte)).wrapping_mul(0x01000193);
        backward = (backward ^ u32::from(bytes[bytes.len() - 1 - index])).wrapping_mul(0x01000193);
    }
    format!("{forward:08x}{backward:08x}")
}

/// 状态拼接顺序与 TS `stateFingerprint` 一致:[px,py,pz,vx,vy,vz]。
pub fn state_fingerprint(
    px: &[f64],
    py: &[f64],
    pz: &[f64],
    vx: &[f64],
    vy: &[f64],
    vz: &[f64],
) -> String {
    let mut all = Vec::with_capacity(px.len() * 6);
    all.extend_from_slice(px);
    all.extend_from_slice(py);
    all.extend_from_slice(pz);
    all.extend_from_slice(vx);
    all.extend_from_slice(vy);
    all.extend_from_slice(vz);
    fingerprint_float64(&all)
}

pub fn num(value: &Value) -> f64 {
    value.as_f64().expect("fixture number must be f64")
}

pub fn int32(value: &Value) -> i32 {
    to_int32(value.as_f64().expect("fixture int"))
}

// ─── 布料镜像(XPBD 距离约束;clothSolver.ts 逐位镜像) ────────────────────────

const WIND_NOISE_SALT: i32 = 0x51ed2701;

struct ClothWind {
    direction: [f64; 3],
    base_speed: f64,
    gust_frequency: f64,
    spatial_scale: f64,
}

struct ClothSolver {
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
    ca: Vec<i32>,
    cb: Vec<i32>,
    rest: Vec<f64>,
    lambda: Vec<f64>,
    noise_seed: i32,
    wind: Option<ClothWind>,
    mass: f64,
    gravity: [f64; 3],
    dt_seconds: f64,
    substeps: u32,
    compliance: f64,
    damping: f64,
    tick: u64,
}

impl ClothSolver {
    /// 构造期镜像:初始布局 + seed 驱动的 z 向扰动(mulberry 按 (row,col) 序)+ 拓扑。
    fn from_config(config: &Value) -> Self {
        let columns = usize::try_from(int32(&config["columns"])).unwrap();
        let rows = usize::try_from(int32(&config["rows"])).unwrap();
        let mass = num(&config["mass"]);
        let seed = int32(&config["seed"]);
        let perturbation = num(&config["perturbation"]);
        let origin = config["origin"].as_array().expect("origin triple");
        let (origin_x, origin_y, origin_z) = (num(&origin[0]), num(&origin[1]), num(&origin[2]));
        let wind = config
            .get("wind")
            .filter(|value| !value.is_null())
            .map(|wind| ClothWind {
                direction: [
                    num(&wind["direction"][0]),
                    num(&wind["direction"][1]),
                    num(&wind["direction"][2]),
                ],
                base_speed: num(&wind["baseSpeed"]),
                gust_frequency: num(&wind["gustFrequency"]),
                spatial_scale: num(&wind["spatialScale"]),
            });
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
            noise_seed: seed ^ WIND_NOISE_SALT,
            wind,
            mass,
            gravity: [
                num(&config["gravity"][0]),
                num(&config["gravity"][1]),
                num(&config["gravity"][2]),
            ],
            dt_seconds: num(&config["dtSeconds"]),
            substeps: u32::try_from(int32(&config["substeps"])).unwrap(),
            compliance: num(&config["compliance"]),
            damping: num(&config["damping"]),
            tick: 0,
        };
        // 初始布局:扰动由 mulberry 流按 (row,col) 固定序注入 z。
        let mut state: i32 = seed.wrapping_add(0x9e3779b9_u32 as i32);
        let mut next_unit = || {
            state = state.wrapping_add(0x6d2b79f5);
            let t0 = state as u32;
            let t1 = (t0 ^ (t0 >> 15)).wrapping_mul(t0 | 1);
            // TS:t ^= t + Math.imul(t ^ (t >>> 7), t | 61)——第二个乘数是当前的 t|61。
            let t2 = t1 ^ t1.wrapping_add((t1 ^ (t1 >> 7)).wrapping_mul(t1 | 61));
            let t3 = t2 ^ (t2 >> 14);
            f64::from(t3) / 4294967296.0
        };
        let spacing = num(&config["spacing"]);
        for row in 0..rows {
            for col in 0..columns {
                let i = row * columns + col;
                solver.px[i] = origin_x + col as f64 * spacing;
                solver.py[i] = origin_y + row as f64 * spacing;
                // TS:originZ + (perturbation > 0 ? (nextUnit()-0.5)*2*perturbation : 0)。
                let delta = if perturbation > 0.0 {
                    (next_unit() - 0.5) * 2.0 * perturbation
                } else {
                    0.0
                };
                solver.pz[i] = origin_z + delta;
            }
        }
        // 拓扑:结构(右/下)+ 剪切(两对角);rest 由间距解析给出。
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
        self.ca.push(a as i32);
        self.cb.push(b as i32);
        self.rest.push(rest);
        self.lambda.push(0.0);
    }

    fn set_pinned(&mut self, col: usize, row: usize, pinned: bool) {
        let i = row * self.columns + col;
        self.inv_mass[i] = if pinned { 0.0 } else { 1.0 / self.mass };
        if pinned {
            self.vx[i] = 0.0;
            self.vy[i] = 0.0;
            self.vz[i] = 0.0;
        }
    }

    fn wind_acceleration(&self, t: f64, y: f64) -> [f64; 3] {
        let Some(wind) = &self.wind else {
            return [0.0, 0.0, 0.0];
        };
        let speed = wind.base_speed
            * (0.5
                + value_noise_2d(
                    self.noise_seed,
                    t * wind.gust_frequency,
                    y * wind.spatial_scale,
                ));
        [
            wind.direction[0] * speed,
            wind.direction[1] * speed,
            wind.direction[2] * speed,
        ]
    }

    fn step(&mut self) {
        let h = self.dt_seconds / f64::from(self.substeps);
        let t0 = self.tick as f64 * self.dt_seconds;
        let damping_scale = 1.0 - self.damping * h;
        let alpha_tilde = self.compliance / (h * h);
        for sub in 0..self.substeps {
            self.qx.copy_from_slice(&self.px);
            self.qy.copy_from_slice(&self.py);
            self.qz.copy_from_slice(&self.pz);
            let t = t0 + f64::from(sub) * h;
            for i in 0..self.count {
                if self.inv_mass[i] == 0.0 {
                    continue;
                }
                let w = self.wind_acceleration(t, self.py[i]);
                self.vx[i] = (self.vx[i] + (self.gravity[0] + w[0]) * h) * damping_scale;
                self.vy[i] = (self.vy[i] + (self.gravity[1] + w[1]) * h) * damping_scale;
                self.vz[i] = (self.vz[i] + (self.gravity[2] + w[2]) * h) * damping_scale;
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
        self.tick += 1;
        assert!(
            self.px
                .iter()
                .chain(&self.py)
                .chain(&self.pz)
                .all(|value| value.is_finite()),
            "cloth solver diverged"
        );
    }

    fn project(&mut self, k: usize, alpha_tilde: f64) {
        let (a, b) = (self.ca[k] as usize, self.cb[k] as usize);
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
}

/// 运行布料场景并返回(初始指纹, 终态指纹)。
pub fn run_cloth(config: &Value, pinned: &Value, ticks: u64) -> (String, String, usize) {
    let mut solver = ClothSolver::from_config(config);
    for pair in pinned.as_array().expect("pinned pairs") {
        let col = usize::try_from(int32(&pair[0])).unwrap();
        let row = usize::try_from(int32(&pair[1])).unwrap();
        solver.set_pinned(col, row, true);
    }
    let initial = state_fingerprint(
        &solver.px, &solver.py, &solver.pz, &solver.vx, &solver.vy, &solver.vz,
    );
    for _ in 0..ticks {
        solver.step();
    }
    let fingerprint = state_fingerprint(
        &solver.px, &solver.py, &solver.pz, &solver.vx, &solver.vy, &solver.vz,
    );
    (initial, fingerprint, solver.rest.len())
}

