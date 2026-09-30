/**
 * A2 WGSL SDF 碰撞 profile(opt-in):体素 SDF 碰撞查询合同 —— 本模块为
 * opt-in 开关 + CPU f32 模拟镜像 + 确定性采样点流;对照合同在
 * sdfCollisionContract.ts,内存预算与 GPU 宿主在 sdfCollisionGpuDispatch.ts。
 *
 * 分工与边界(不重建,见现状核查):
 * - `sdfGrid.ts`:有界体素 SDF 生成(确定性,内存有界)+ CPU trilinear 采样 —— 本模块的输入;
 * - `sdfCollisionBridge.ts`(F6):SDF → 等值面网格 → Rapier trimesh 的 CPU 路径 —— 保持不变,
 *   本模块不触碰 Rapier collider;
 * - 本家族:trilinear + 中心差分梯度的碰撞查询核(WGSL 单源 `wgsl/sdfCollisionQuery.wgsl`,
 *   生成镜像 `sdfCollisionQueryWgsl.ts`)+ TS f32 模拟镜像(逐运算同构)+ 碰撞 profile
 *   合同(opt-in、误差边界、内存预算、逐字段 fail-closed 对照)。
 *
 * Rapier 真值不变:真值侧由既有 F6 路径(apps/web golden + native
 * `native_physics_sdf_golden_tests.rs`)与本任务的 native 对照
 * (`deep-engine-native/tests/sdf_collision_profile_truth.rs`,rapier3d 凸包点投影)
 * 提供;对照合同只定义「SDF 查询结果 vs 凸包真值」的逐字段验收。
 *
 * 确定性合同(并行归约定序):查询核每 lane 输出仅由本 lane 输入决定 —— 无跨 lane
 * 通信、无共享内存、无原子,不存在需要定序的归约;同输入同 dispatch 逐位回放。
 * CPU 镜像与 Rust 镜像(f32 双舍入免疫,Figueroa p₂ ≥ 2p+2)逐位同构;
 * 真机 GPU 若做 FMA 融合,差异由误差预算覆盖(与 T18 A3 布料先例同口径)。
 *
 * fail-closed 语义:域外查询 ≠ 「无碰撞」。域外 lane 返回 NaN 距离 + OUT_OF_DOMAIN
 * 状态,`classify` 抛 RangeError;GPU 批次内任何非 0 状态 ⇒ 整批拒绝。
 */
import { SDF_QUERY_MAX_POINTS } from "./sdfCollisionQueryWgsl.js";
import { estimateSdfCollisionMemory, MAX_SDF_PROFILE_GRID_CELLS,
  type SdfCollisionMemoryEstimate } from "./sdfCollisionGpuDispatch.js";
import { fingerprintFloat32 } from "./clothParallelSolver.js";
import type { SdfGrid } from "./sdfGrid.js";

export {
  DEEP_SDF_COLLISION_QUERY_WGSL, SDF_QUERY_ENTRY, SDF_QUERY_MAX_POINTS, SDF_QUERY_NAN_BITS,
  SDF_QUERY_PARAMS_BYTES, SDF_QUERY_STATUS_IN_DOMAIN, SDF_QUERY_STATUS_OUT_OF_DOMAIN,
  SDF_QUERY_WORKGROUP_SIZE,
} from "./sdfCollisionQueryWgsl.js";
export { MAX_SDF_PROFILE_GRID_CELLS } from "./sdfCollisionGpuDispatch.js";
export {
  estimateSdfCollisionMemory, packSdfQueryParams, querySdfCollisionsGpu, isSdfQueryNanBitPattern,
  type SdfCollisionMemoryEstimate, type SdfCollisionGpuBatch,
} from "./sdfCollisionGpuDispatch.js";
export {
  collectSdfProfileComparison, validateSdfProfileAgainstRapierHull, deriveSdfProfileDistanceBound,
  type SdfProfileTruthRow, type SdfProfileBudget, type SdfProfileRegion,
  type SdfProfileComparisonRow, type SdfProfileViolation, type SdfProfileComparisonTable,
} from "./sdfCollisionContract.js";

const fround = Math.fround;

/** opt-in 默认值:显式关闭。任何 SDF 碰撞 profile 必须显式 enabled 才能创建。 */
export const SDF_COLLISION_PROFILE_DEFAULT_ENABLED = false as const;

/** 每批查询点上限(与 WGSL 侧 SDF_QUERY_MAX_POINTS 同源)。 */
export const SDF_COLLISION_MAX_QUERY_POINTS = SDF_QUERY_MAX_POINTS;

export interface SdfCollisionProfileConfig {
  /** 字面量 true:编译期拒收 false;运行时双重守门(默认关,显式开)。 */
  readonly enabled: true;
  readonly grid: SdfGrid;
  /** 穿透判据收缩量(米,≥0):penetrating ⇔ distance < −contactSkin。默认 0。 */
  readonly contactSkin?: number;
}

export type SdfCollisionProfileState = "penetrating" | "free";

export interface SdfCollisionSample {
  /** false = 域外:distance 为 NaN、gradient 为 0,消费方必须 fail-closed。 */
  readonly inDomain: boolean;
  /** trilinear 有符号距离(米;负 = 闭合源几何内部)。域外为 NaN。 */
  readonly distance: number;
  /** 中心差分梯度(世界单位/米),固定 stencil 序 x→y→z;域边一圈单侧差分。 */
  readonly gradient: readonly [number, number, number];
}

export interface SdfCollisionProfile {
  readonly grid: SdfGrid;
  readonly contactSkin: number;
  /** CPU f32 模拟镜像(与 WGSL 核逐运算同构)。 */
  sample(point: readonly [number, number, number]): SdfCollisionSample;
  /** 碰撞分类;域外抛 RangeError(域外碰撞未知,绝不静默「无碰撞」)。 */
  classify(point: readonly [number, number, number]): SdfCollisionProfileState;
  /** 分辨率×字节数的内存预算(上传 + 回读,全显式)。 */
  memoryEstimate(queryCount: number): SdfCollisionMemoryEstimate;
}

/**
 * 创建 SDF 碰撞 profile。默认关闭:`enabled` 必须是字面量 true(类型层面拒收
 * false),运行时再守门一次;grid 必须来自 buildSdfGrid 合同(有界、有限、逐点距离)。
 */
export function createSdfCollisionProfile(config: SdfCollisionProfileConfig): SdfCollisionProfile {
  if (config.enabled !== true) throw new TypeError("SDF 碰撞 profile 默认关闭,必须显式 enabled:true");
  const contactSkin = config.contactSkin ?? 0;
  if (!Number.isFinite(contactSkin) || contactSkin < 0) throw new RangeError("contactSkin 必须是非负有限数");
  const grid = config.grid;
  const cells = grid.dimensions[0] * grid.dimensions[1] * grid.dimensions[2];
  if (grid.distances.length !== cells || cells > MAX_SDF_PROFILE_GRID_CELLS
    || !Number.isFinite(grid.cellSize) || grid.cellSize <= 0) {
    throw new RangeError("SDF 碰撞 profile 要求有界网格(每维 ≤128、cells ≤ 262144)");
  }
  if (grid.distances.some(value => !Number.isFinite(value))) {
    throw new RangeError("SDF 碰撞 profile 拒绝非有限距离值");
  }
  return {
    grid, contactSkin,
    sample: point => sampleSdfCollision(grid, point),
    classify: point => {
      const sample = sampleSdfCollision(grid, point);
      if (!sample.inDomain) throw new RangeError("SDF 查询点超出有界网格:域外碰撞未知(fail-closed)");
      return sample.distance < -contactSkin ? "penetrating" : "free";
    },
    memoryEstimate: queryCount => estimateSdfCollisionMemory(grid.dimensions, queryCount),
  };
}

/** 与 WGSL `at()` 同构的 i32 钳制取值(域边一圈常值外推)。 */
function at(grid: SdfGrid, x: number, y: number, z: number): number {
  const [nx, ny, nz] = grid.dimensions;
  const cx = Math.min(Math.max(x, 0), nx - 1);
  const cy = Math.min(Math.max(y, 0), ny - 1);
  const cz = Math.min(Math.max(z, 0), nz - 1);
  return grid.distances[(cz * ny + cy) * nx + cx]!;
}

/**
 * CPU f32 模拟镜像:与 wgsl/sdfCollisionQuery.wgsl 的 queryCollisions 逐运算同构
 * (每步 Math.fround = f32 单运算正确舍入;双舍入免疫保证与 Rust f32 逐位一致)。
 */
export function sampleSdfCollision(grid: SdfGrid, point: readonly [number, number, number]): SdfCollisionSample {
  if (!point.every(Number.isFinite)) throw new TypeError("SDF 查询点必须是有限数值");
  const cs = grid.cellSize;
  const qx = fround(fround(point[0]! - grid.origin[0]!) / cs);
  const qy = fround(fround(point[1]! - grid.origin[1]!) / cs);
  const qz = fround(fround(point[2]! - grid.origin[2]!) / cs);
  const maxX = grid.dimensions[0]! - 1, maxY = grid.dimensions[1]! - 1, maxZ = grid.dimensions[2]! - 1;
  if (qx < 0 || qy < 0 || qz < 0 || qx > maxX || qy > maxY || qz > maxZ) {
    return { inDomain: false, distance: NaN, gradient: [0, 0, 0] };
  }
  const lx = Math.floor(qx), ly = Math.floor(qy), lz = Math.floor(qz);
  const fx = fround(qx - lx), fy = fround(qy - ly), fz = fround(qz - lz);
  const d000 = at(grid, lx, ly, lz);
  const d100 = at(grid, lx + 1, ly, lz);
  const d010 = at(grid, lx, ly + 1, lz);
  const d110 = at(grid, lx + 1, ly + 1, lz);
  const d001 = at(grid, lx, ly, lz + 1);
  const d101 = at(grid, lx + 1, ly, lz + 1);
  const d011 = at(grid, lx, ly + 1, lz + 1);
  const d111 = at(grid, lx + 1, ly + 1, lz + 1);
  // 运算序与 WGSL trilinear 一致:x 向 4 条 → y 向 2 条 → z 向 1 条。
  const x0 = fround(d000 + fround(fround(d100 - d000) * fx));
  const x1 = fround(d010 + fround(fround(d110 - d010) * fx));
  const x2 = fround(d001 + fround(fround(d101 - d001) * fx));
  const x3 = fround(d011 + fround(fround(d111 - d011) * fx));
  const y0 = fround(x0 + fround(fround(x1 - x0) * fy));
  const y1 = fround(x2 + fround(fround(x3 - x2) * fy));
  const distance = fround(y0 + fround(fround(y1 - y0) * fz));
  // 中心差分梯度,固定 stencil 序 x→y→z;除数 (2·cellSize) 与 WGSL 同为 f32。
  const hh = fround(2 * cs);
  const gx = fround(fround(at(grid, lx + 1, ly, lz) - at(grid, lx - 1, ly, lz)) / hh);
  const gy = fround(fround(at(grid, lx, ly + 1, lz) - at(grid, lx, ly - 1, lz)) / hh);
  const gz = fround(fround(at(grid, lx, ly, lz + 1) - at(grid, lx, ly, lz - 1)) / hh);
  return { inDomain: true, distance, gradient: [gx, gy, gz] };
}

// ─── 确定性采样点流(TS/Rust 逐位同构的 LCG) ────────────────────────────────

/** 同 seed 重放的默认种子(与 native sdf_collision_profile_truth.rs 互钉)。 */
export const SDF_QUERY_LCG_SEED = 0x5df4c6d3;

/**
 * 确定性查询点流:32 位 LCG(Numerical Recipes 常数),每点依次取 x/y/z 三个
 * 随机数;(state >>> 8)·2⁻²⁴ 与 span 的乘加全 f32,两端逐位一致。
 */
export function createSdfQueryPointStream(grid: SdfGrid, count: number,
  seed: number = SDF_QUERY_LCG_SEED): readonly (readonly [number, number, number])[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > SDF_COLLISION_MAX_QUERY_POINTS) {
    throw new RangeError(`SDF 查询点数量必须是 1..${SDF_COLLISION_MAX_QUERY_POINTS}`);
  }
  const cs = grid.cellSize;
  const spans = [0, 1, 2].map(axis => fround((grid.dimensions[axis]! - 1) * cs));
  let state = seed | 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return state >>> 0;
  };
  const unit = (draw: number, axis: number): number =>
    fround(grid.origin[axis]! + fround(fround((draw >>> 8) * fround(1 / 16_777_216)) * spans[axis]!));
  const points: (readonly [number, number, number])[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push([unit(next(), 0), unit(next(), 1), unit(next(), 2)]);
  }
  return points;
}

/** 跨端逐位指纹:f32 位流 [d0,gx0,gy0,gz0,d1,…] 的双向 FNV(与 Rust 镜像互钉)。 */
export function fingerprintSdfQuerySamples(samples: readonly SdfCollisionSample[]): string {
  const stream = new Float32Array(samples.length * 4);
  samples.forEach((sample, index) => {
    stream[index * 4] = sample.distance;
    stream[index * 4 + 1] = sample.gradient[0]!;
    stream[index * 4 + 2] = sample.gradient[1]!;
    stream[index * 4 + 3] = sample.gradient[2]!;
  });
  return fingerprintFloat32(stream);
}
