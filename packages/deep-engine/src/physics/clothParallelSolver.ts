/**
 * T18 A3 并行切片:布料 GPU compute 核的 CPU f32 模拟镜像(色序 Gauss-Seidel)。
 *
 * 与 `clothSolver.ts`(f64 黄金,构建序投影,本切片不改)的关系:
 * - 本镜像是并行 WGSL 核 `wgsl/clothSolver.wgsl` 的逐运算模拟口径:f32 IEEE-754
 *   正确舍入(每步 Math.fround),执行序 = 着色色序(色间串行、色内无共享端点);
 * - 黄金 f64 与本镜像的差异来源只有两个:f32 量化 + 约束投影顺序(构建序 → 色桶序),
 *   两者都是受控偏差,量化对照表见 clothParallelSolver.test.ts;
 * - 同 seed 同输入双跑逐位(纯函数 + 固定树归约);无 Math.random/Date/全局态。
 *
 * 归约定序(任务验收"固定归约树")分两层:
 * - 投影路径:着色保证同色约束不共享端点 → 每粒子在单色内至多一个写者,
 *   投影无跨线程求和,无归约歧义;
 * - 统计路径:每子步动能 Σspeed² 走三级固定树 —— lane 内 pairwise(vec4 分量树)、
 *   workgroup 内 64 lane 共享内存 pairwise 树(零填充到 2 的幂)、宿主合并树,
 *   三级与 WGSL/Rust 镜像逐运算同构,是并行归约定序的实现与证据。
 */
import { colorClothConstraints, type ClothColoring } from "./clothConstraintColoring.js";

const f = Math.fround;

/** WGSL workgroup 尺寸(与核内 @workgroup_size 一致,镜像按同宽切块)。 */
export const CLOTH_PARALLEL_WORKGROUP_SIZE = 64;

export interface ClothParallelConfig {
  readonly columns: number;
  readonly rows: number;
  readonly spacing: number;
  readonly mass: number;
  readonly gravity: readonly [number, number, number];
  readonly dtSeconds: number;
  readonly substeps: number;
  readonly compliance: number;
  readonly damping: number;
  readonly perturbation: number;
  readonly seed: number;
  readonly origin?: readonly [number, number, number];
  /** 锚点 (col,row) 列表(构建期定,与黄金 setPinned 语义一致:invMass=0 且速度清零)。 */
  readonly pinned?: ReadonlyArray<readonly [number, number]>;
  /** F6/T18:确定性风(可选);镜像与 GPU 并行核同构 f32。 */
  readonly wind?: import("./clothSolver.js").ClothWind;
}

export interface ClothParallelBuild {
  readonly particleCount: number;
  readonly constraintCount: number;
  /** 12 floats/粒子:[position+invMass, velocity, previous],同 GPU 存储布局。 */
  readonly state: Float32Array;
  /** 桶排序(色序)后的约束:[a, b, restLength, pad] ×4,约束索引即桶内序。 */
  readonly constraintBuffer: ArrayBuffer;
  readonly coloring: ClothColoring;
  readonly config: ClothParallelConfig;
}

export interface StretchStatsF32 {
  readonly maxRatio: number;
  readonly meanRatio: number;
  readonly constraintCount: number;
}

// ─── 构建(f64 布局流镜像黄金构造,入 f32 缓冲时 fround) ─────────────────────────

/** 从网格配置构建 GPU 同布局缓冲:拓扑/扰动流与 clothSolver.ts 构造逐位同源。 */
export function buildClothParallelState(config: ClothParallelConfig): ClothParallelBuild {
  const c = config;
  if (!Number.isSafeInteger(c.columns) || c.columns < 2 || !Number.isSafeInteger(c.rows) || c.rows < 2) {
    throw new Error(`cloth parallel: columns/rows must be integers >= 2, got ${c.columns}x${c.rows}.`);
  }
  if (!(c.spacing > 0) || !(c.mass > 0) || !(c.dtSeconds > 0) || !Number.isFinite(c.dtSeconds)) {
    throw new Error("cloth parallel: spacing/mass/dtSeconds must be positive finite.");
  }
  if (!Number.isSafeInteger(c.substeps) || c.substeps < 1) throw new Error("cloth parallel: substeps must be integer >= 1.");
  const count = c.columns * c.rows;
  const state = new Float32Array(count * 12);
  // 扰动流:mulberry,与黄金构造同一序列(整型运算,天然逐位)。
  let s = (c.seed | 0) + 0x9e3779b9 | 0;
  const nextUnit = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ox = c.origin?.[0] ?? 0;
  const oy = c.origin?.[1] ?? 0;
  const oz = c.origin?.[2] ?? 0;
  const invMass = f(1 / c.mass);
  for (let r = 0; r < c.rows; r += 1) {
    for (let col = 0; col < c.columns; col += 1) {
      const i = r * c.columns + col;
      const base = i * 12;
      state[base] = f(ox + col * c.spacing);
      state[base + 1] = f(oy + r * c.spacing);
      state[base + 2] = f(oz + (c.perturbation > 0 ? (nextUnit() - 0.5) * 2 * c.perturbation : 0));
      state[base + 3] = invMass;
      state[base + 8] = state[base]!;
      state[base + 9] = state[base + 1]!;
      state[base + 10] = state[base + 2]!;
    }
  }
  const ca: number[] = [];
  const cb: number[] = [];
  const rest: number[] = [];
  const diag = c.spacing * Math.SQRT2;
  for (let r = 0; r < c.rows; r += 1) {
    for (let col = 0; col < c.columns; col += 1) {
      const i = r * c.columns + col;
      if (col + 1 < c.columns) { ca.push(i); cb.push(i + 1); rest.push(c.spacing); }
      if (r + 1 < c.rows) { ca.push(i); cb.push(i + c.columns); rest.push(c.spacing); }
      if (col + 1 < c.columns && r + 1 < c.rows) {
        ca.push(i); cb.push(i + c.columns + 1); rest.push(diag);
        ca.push(i + 1); cb.push(i + c.columns); rest.push(diag);
      }
    }
  }
  const coloring = colorClothConstraints(ca, cb, count);
  const constraintBuffer = new ArrayBuffer(ca.length * 16);
  const ints = new Uint32Array(constraintBuffer);
  const floats = new Float32Array(constraintBuffer);
  for (let bucket = 0; bucket < coloring.order.length; bucket += 1) {
    const k = coloring.order[bucket]!;
    ints[bucket * 4] = ca[k]!;
    ints[bucket * 4 + 1] = cb[k]!;
    floats[bucket * 4 + 2] = f(rest[k]!);
  }
  const pinnedSet = c.pinned ?? [];
  for (const [col, row] of pinnedSet) setPinned(state, c.columns, col, row, true);
  return {
    particleCount: count,
    constraintCount: ca.length,
    state,
    constraintBuffer,
    coloring,
    config: c,
  };
}

function setPinned(state: Float32Array, columns: number, col: number, row: number, pinned: boolean): void {
  const base = (row * columns + col) * 12;
  if (pinned) {
    state[base + 3] = 0;
    state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
  }
}

// ─── 固定归约树(三级:lane pairwise → workgroup 64 树 → 宿主合并树) ────────────

/** 树和(2 lane):f32 单次加法,是所有归约树的叶操作。 */
export function treeSum2(a: number, b: number): number { return f(f(a) + f(b)); }

/** 树和(4 lane):pairwise (a+b)+(c+d);与线性序加法在 f32 下可不同(定序证据)。 */
export function treeSum4(a: number, b: number, c: number, d: number): number {
  return f(treeSum2(a, b) + treeSum2(c, d));
}

/** workgroup 共享内存 pairwise 树:lane 值按块内索引零填充到 64,自底向顶固定配对。 */
export function workgroupTreeSum(laneValues: ArrayLike<number>): number {
  const width = CLOTH_PARALLEL_WORKGROUP_SIZE;
  const shared = new Float64Array(width);
  for (let i = 0; i < width; i += 1) shared[i] = i < laneValues.length ? f(laneValues[i]!) : 0;
  let level = width;
  while (level > 1) {
    const half = level >> 1;
    for (let i = 0; i < half; i += 1) shared[i] = f(f(shared[i * 2]!) + f(shared[i * 2 + 1]!));
    level = half;
  }
  return shared[0]!;
}

/** 宿主合并树:跨 workgroup 部分和按固定 pairwise 树合并(零填充到 2 的幂)。 */
export function hostMergeTreeSum(partials: ArrayLike<number>): number {
  let level = 1;
  while (level < partials.length) level *= 2;
  const shared = new Float64Array(level);
  for (let i = 0; i < level; i += 1) shared[i] = i < partials.length ? f(partials[i]!) : 0;
  while (level > 1) {
    const half = level >> 1;
    for (let i = 0; i < half; i += 1) shared[i] = f(f(shared[i * 2]!) + f(shared[i * 2 + 1]!));
    level = half;
  }
  return shared[0]!;
}

/** FNV-1a 双车道 f32 指纹:与 physicsTypes.fingerprintFloat64 同式,宽度 4 字节。 */
export function fingerprintFloat32(values: ArrayLike<number>): string {
  const f32 = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) f32[i] = values[i]!;
  const bytes = new Uint8Array(f32.buffer);
  let forward = 0x811c9dc5;
  let backward = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    forward = Math.imul(forward ^ bytes[i]!, 0x01000193);
    backward = Math.imul(backward ^ bytes[bytes.length - 1 - i]!, 0x01000193);
  }
  const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
  return hex(forward) + hex(backward);
}

// ─── 模拟镜像(逐运算 fround;执行序 = 色序 GS) ──────────────────────────────────

export class ClothParallelMirror {
  readonly #build: ClothParallelBuild;
  readonly #state: Float32Array;
  readonly #constraintInts: Uint32Array;
  readonly #constraintFloats: Float32Array;
  /** 每子步三级树归约后的动能 Σspeed²(最近一个 tick,子步序)。 */
  readonly #kineticPerSubstep: number[] = [];
  #tick = 0;

  constructor(build: ClothParallelBuild) {
    this.#build = build;
    this.#state = build.state;
    this.#constraintInts = new Uint32Array(build.constraintBuffer);
    this.#constraintFloats = new Float32Array(build.constraintBuffer);
  }

  get build(): ClothParallelBuild { return this.#build; }
  get tick(): number { return this.#tick; }
  get kineticPerSubstep(): readonly number[] { return this.#kineticPerSubstep; }

  /** 推进一个固定 tick(substeps 个色序子步)。 */
  step(): void {
    const build = this.#build;
    const cfg = build.config;
    const state = this.#state;
    const dt32 = f(cfg.dtSeconds);
    const h = f(dt32 / cfg.substeps);
    const hh = f(h * h);
    const alphaTilde = f(f(cfg.compliance) / hh);
    const dampingScale = f(1 - f(f(cfg.damping) * h));
    const invH = f(1 / h);
    const gx = f(cfg.gravity[0]);
    const gy = f(cfg.gravity[1]);
    const gz = f(cfg.gravity[2]);
    this.#kineticPerSubstep.length = 0;

    for (let sub = 0; sub < cfg.substeps; sub += 1) {
      // pass A:积分(每粒子独立,并行纯函数)。风时间基 = tick·dt + sub·h。
      // 推导与 dispatch packClothParallelParams 同式(f64 累加后一次 fround)——
      // 镜像此前逐步舍入,与 pack 值有 1 ULP 级差,是真机噪声对拍的输入端偏差源。
      const wind = cfg.wind;
      const tickSeconds = f(this.#tick * cfg.dtSeconds + sub * (cfg.dtSeconds / cfg.substeps));
      // 与 f64 黄金同源:clothSolver 构造期 seed^WIND_NOISE_SALT(clothSolver.ts 导出)。
      const noiseSeed = wind ? ((wind.seed ^ 0x51ed2701) >>> 0) : 0;
      const gustF = wind ? f(wind.gustFrequency) : 0;
      const spatial = wind ? f(wind.spatialScale) : 0;
      const baseSpeed = wind ? f(wind.baseSpeed) : 0;
      const wdx = wind ? f(wind.direction[0]) : 0;
      const wdy = wind ? f(wind.direction[1]) : 0;
      const wdz = wind ? f(wind.direction[2]) : 0;
      const windAt = (y: number): readonly [number, number, number] => {
        if (!wind) return [0, 0, 0];
        const n = f(mirrorWindNoise(f(f(tickSeconds) * gustF), f(y * spatial), noiseSeed));
        const speed = f(baseSpeed * f(0.5 + n));
        return [f(wdx * speed), f(wdy * speed), f(wdz * speed)];
      };
      for (let i = 0; i < build.particleCount; i += 1) {
        const base = i * 12;
        state[base + 8] = state[base]!;
        state[base + 9] = state[base + 1]!;
        state[base + 10] = state[base + 2]!;
        if (state[base + 3] === 0) {
          state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
          continue;
        }
        const [wx, wy, wz] = windAt(state[base + 1]!);
        state[base + 4] = f(f(state[base + 4]! + f(f(gx + wx) * h)) * dampingScale);
        state[base + 5] = f(f(state[base + 5]! + f(f(gy + wy) * h)) * dampingScale);
        state[base + 6] = f(f(state[base + 6]! + f(f(gz + wz) * h)) * dampingScale);
        state[base] = f(state[base]! + f(state[base + 4]! * h));
        state[base + 1] = f(state[base + 1]! + f(state[base + 5]! * h));
        state[base + 2] = f(state[base + 2]! + f(state[base + 6]! * h));
      }
      // pass B:色序约束投影(色间串行;色内端点不相交,次序无关)。
      for (let color = 0; color < build.coloring.colorCount; color += 1) {
        const [start, end] = build.coloring.colorRanges[color]!;
        for (let bucket = start; bucket < end; bucket += 1) {
          this.#projectBucket(bucket, alphaTilde);
        }
      }
      // pass C:速度回算 + 三级树归约动能统计。
      const workgroups = Math.ceil(build.particleCount / CLOTH_PARALLEL_WORKGROUP_SIZE);
      const partials = new Float64Array(workgroups);
      for (let w = 0; w < workgroups; w += 1) {
        const lanes = new Float64Array(CLOTH_PARALLEL_WORKGROUP_SIZE);
        for (let lane = 0; lane < CLOTH_PARALLEL_WORKGROUP_SIZE; lane += 1) {
          const i = w * CLOTH_PARALLEL_WORKGROUP_SIZE + lane;
          if (i >= build.particleCount) break;
          const base = i * 12;
          if (state[base + 3] === 0) {
            state[base + 4] = 0; state[base + 5] = 0; state[base + 6] = 0;
            lanes[lane] = 0;
            continue;
          }
          state[base + 4] = f(f(state[base]! - state[base + 8]!) * invH);
          state[base + 5] = f(f(state[base + 1]! - state[base + 9]!) * invH);
          state[base + 6] = f(f(state[base + 2]! - state[base + 10]!) * invH);
          lanes[lane] = treeSum4(
            f(state[base + 4]! * state[base + 4]!),
            f(state[base + 5]! * state[base + 5]!),
            f(state[base + 6]! * state[base + 6]!),
            0,
          );
        }
        partials[w] = workgroupTreeSum(lanes);
      }
      this.#kineticPerSubstep.push(hostMergeTreeSum(partials));
    }
    this.#tick += 1;
    for (let i = 0; i < state.length; i += 1) {
      if (!Number.isFinite(state[i])) throw new Error(`cloth parallel mirror diverged at float ${i}.`);
    }
  }

  /** 单约束投影(bucket 序),f32 每步舍入;与 WGSL projectColor 逐运算同构。 */
  #projectBucket(bucket: number, alphaTilde: number): void {
    const state = this.#state;
    const ints = this.#constraintInts;
    const floats = this.#constraintFloats;
    const a = ints[bucket * 4]!;
    const b = ints[bucket * 4 + 1]!;
    const restLength = floats[bucket * 4 + 2]!;
    const aBase = a * 12;
    const bBase = b * 12;
    const wa = state[aBase + 3]!;
    const wb = state[bBase + 3]!;
    const denom = f(wa + wb);
    if (denom === 0) return;
    const dx = f(state[aBase]! - state[bBase]!);
    const dy = f(state[aBase + 1]! - state[bBase + 1]!);
    const dz = f(state[aBase + 2]! - state[bBase + 2]!);
    const lenSq = f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz));
    const len = f(Math.sqrt(lenSq));
    if (len === 0) return;
    const numerator = f(restLength - len);
    const denominator = f(denom + alphaTilde);
    const correction = f(numerator / denominator);
    if (correction === 0) return;
    const invLen = f(1 / len);
    const nx = f(dx * invLen);
    const ny = f(dy * invLen);
    const nz = f(dz * invLen);
    // 端点 A:correction*wa 先结合,再乘方向分量,再加位置(与 WGSL 标量展开一致)。
    const scaleA = f(correction * wa);
    const scaleB = f(correction * wb);
    state[aBase] = f(state[aBase]! + f(nx * scaleA));
    state[aBase + 1] = f(state[aBase + 1]! + f(ny * scaleA));
    state[aBase + 2] = f(state[aBase + 2]! + f(nz * scaleA));
    state[bBase] = f(state[bBase]! - f(nx * scaleB));
    state[bBase + 1] = f(state[bBase + 1]! - f(ny * scaleB));
    state[bBase + 2] = f(state[bBase + 2]! - f(nz * scaleB));
  }

  /** f32 状态指纹:拼接序与黄金 [px,py,pz,vx,vy,vz] 一致。 */
  stateFingerprint32(): string {
    const build = this.#build;
    const n = build.particleCount;
    const all = new Float32Array(n * 6);
    const state = this.#state;
    for (let i = 0; i < n; i += 1) {
      const base = i * 12;
      all[i] = state[base]!;
      all[n + i] = state[base + 1]!;
      all[2 * n + i] = state[base + 2]!;
      all[3 * n + i] = state[base + 4]!;
      all[4 * n + i] = state[base + 5]!;
      all[5 * n + i] = state[base + 6]!;
    }
    return fingerprintFloat32(all);
  }

  /** 拉伸误差统计(f32 口径;指标同黄金 measureStretch)。 */
  measureStretch(): StretchStatsF32 {
    const build = this.#build;
    const state = this.#state;
    const floats = this.#constraintFloats;
    const ints = this.#constraintInts;
    let max = 0;
    let sum = 0;
    for (let bucket = 0; bucket < build.constraintCount; bucket += 1) {
      const a = ints[bucket * 4]!;
      const b = ints[bucket * 4 + 1]!;
      const restLength = floats[bucket * 4 + 2]!;
      const dx = f(state[a * 12]! - state[b * 12]!);
      const dy = f(state[a * 12 + 1]! - state[b * 12 + 1]!);
      const dz = f(state[a * 12 + 2]! - state[b * 12 + 2]!);
      const len = f(Math.sqrt(f(f(f(dx * dx) + f(dy * dy)) + f(dz * dz))));
      const ratio = f(Math.abs(f(len - restLength)) / restLength);
      if (ratio > max) max = ratio;
      sum = f(sum + ratio);
    }
    return { maxRatio: max, meanRatio: f(sum / build.constraintCount), constraintCount: build.constraintCount };
  }

  /** 深拷贝状态(重放对拍用)。 */
  captureState(): Float32Array { return new Float32Array(this.#state); }

  restoreState(snapshot: Float32Array): void { this.#state.set(snapshot); }
}

/** F6/T18:镜像侧风噪声(与 WGSL windValueNoise 逐运算 f32 同构;hash 整数链逐位)。
 * sx/sz 必须逐运算 fround:WGSL 里每个乘/减都是独立 f32 操作(每步正确舍入),
 * 整表达式只舍一次会引入最高 ~11 ULP 的输入差(真机对拍实测),动力学放大后超容差。
 * F6/T18 风场刀起导出:软体并行核镜像同函数消费(跨族单一真源,禁复制——
 * 账本追加二十四「重复补丁外科去除」教训)。 */
export function mirrorWindHash(xi: number, zi: number, seed: number): number {
  let h = (Math.imul(xi | 0, 0x27d4eb2d) ^ Math.imul(zi | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h;
}
/** WGSL `tx * tx * tx * (tx * (tx * 6.0 - 15.0) + 10.0)` 的逐运算 f32 镜像。 */
export function mirrorQuintic(tx: number): number {
  const b = f(f(tx * tx) * tx); // tx*tx*tx
  const g = f(f(tx * f(f(tx * 6) - 15)) + 10); // tx*(tx*6-15)+10
  return f(b * g);
}
export function mirrorWindNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const tx = f(x - xi);
  const tz = f(z - zi);
  const sx = mirrorQuintic(tx);
  const sz = mirrorQuintic(tz);
  const v00 = f(mirrorWindHash(xi, zi, seed) * 2.3283064365386963e-10);
  const v10 = f(mirrorWindHash(xi + 1, zi, seed) * 2.3283064365386963e-10);
  const v01 = f(mirrorWindHash(xi, zi + 1, seed) * 2.3283064365386963e-10);
  const v11 = f(mirrorWindHash(xi + 1, zi + 1, seed) * 2.3283064365386963e-10);
  const a = f(v00 + f(f(v10 - v00) * sx));
  const b = f(v01 + f(f(v11 - v01) * sx));
  return f(a + f(f(b - a) * sz));
}
