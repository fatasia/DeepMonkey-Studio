/**
 * Brief-GI M1 第一步:场景级聚合 SDF 烘焙(A2 核查缺口,2026-10-04)。
 *
 * A2 现状:既有 SDF 全部按刚体局部网格(buildSdfGrid 每 mesh ≤128³/cells ≤262 144),
 * 没有覆盖整个静态场景的合成距离场;天光遮蔽(GI 的圆锥追踪)需要一张场景级 3D SDF。
 * 本模块把多个静态资产的世界空间 SDF **min 合成**(闭体并集的标准 CSG 组合)成一张
 * 场景级网格,产出直接是 physics `SdfGrid`(sampleSdfGrid / sampleSdfCollision 的
 * trilinear 与梯度查询零适配直用;GPU 侧即 rgba/r32 3D 纹理上传)。
 *
 * == 复用(不重建) ==
 * - `physics/sdfGrid.buildSdfGrid`:mesh→SDF 提取(确定性,逐 cell 射线奇偶定号);
 * - `physics/sdfCollisionProfile` 家族的内存档:`MAX_SDF_PROFILE_GRID_CELLS` 场景网格
 *   上限 + `estimateSdfCollisionMemory` 字节账(本模块不另立预算公式);
 * - `physics/clothParallelSolver.fingerprintFloat32`:资产哈希(FNV-1a 双车道)。
 *
 * == 增量与排除 ==
 * - 静态资产哈希缓存:hash(顶点字节 + 索引 + 变换 + 网格参数)命中即复用上一烘焙的
 *   逐资产 SDF,只重烘变更资产(分块=逐资产域,天然增量);
 * - 动态资产:`dynamic: true` 的实例一律不入场(报告逐条 `dynamic-excluded`),
 *   场景 SDF 只描述静态世界;动态遮挡走动态直接层(SSGDI,后续切片);
 * - 规模墙 fail-visible:三角形/网格超出 buildSdfGrid 预算的资产**跳过并逐条记录
 *   原因**(proxy/子集降级路径,不静默截断——诚实条款)。
 *
 * == 确定性 ==
 * 实例按输入序处理;同一输入(含缓存状态)逐位同输出。域外合成初值 = 有界的
 * `exteriorDistance`,场永不含 NaN/Infinity。
 */
import { buildSdfGrid, type SdfGrid, type SdfMesh } from "../physics/sdfGrid.js";
import { estimateSdfCollisionMemory, MAX_SDF_PROFILE_GRID_CELLS,
  type SdfCollisionMemoryEstimate } from "../physics/sdfCollisionProfile.js";
import { fingerprintFloat32 } from "../physics/clothParallelSolver.js";

/** 场景网格每轴上限(与 buildSdfGrid 逐轴 ≤128 同源)。 */
export const MAX_SDF_SCENE_BAKE_AXIS = 128;
/** 与 buildSdfGrid 的逐 mesh 三角形预算同源(超出即规模墙,跳过并记录)。 */
export const MAX_SDF_SCENE_BAKE_TRIANGLES = 16_384;
/** buildSdfGrid 的 cells×triangles 采样预算(原值,防调用期抛错前置拦截)。 */
export const MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES = 16_777_216;

/** 3×4 仿射(行主:先乘 basis 再加平移)。缺省 = 恒等。 */
export interface SdfSceneTransform {
  readonly basis: readonly [number, number, number, number, number, number, number, number, number];
  readonly translation: readonly [number, number, number];
}

export interface SdfSceneBakeInstance {
  readonly id: string;
  readonly mesh: SdfMesh;
  /** true = 动态资产:排除出场,报告逐条记录。 */
  readonly dynamic?: boolean;
  readonly transform?: SdfSceneTransform;
}

export interface SdfSceneBakeOptions {
  /** 显式场景网格;缺省由静态实例 AABB 并集 + 1 cell 外推圈推导。 */
  readonly bounds?: { readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number] };
  /** 显式分辨率;缺省按 bounds/cellSize 推导。每轴 ≤128、cells ≤ 场景上限。 */
  readonly dimensions?: readonly [number, number, number];
  /** 体素边长(米,>0);缺省 = bounds 最长边 / 64。 */
  readonly cellSize?: number;
  /** 增量缓存(跨烘焙携带;命中资产不重烘)。 */
  readonly cache?: SdfSceneBakeCache;
}

/** 逐资产 SDF 缓存:hash → 距离场(可变 Map,调用方跨帧持有)。 */
export interface SdfSceneBakeCache {
  readonly entries: Map<string, Pick<SdfGrid, "origin" | "cellSize" | "dimensions" | "distances">>;
}

export function createSdfSceneBakeCache(): SdfSceneBakeCache {
  return { entries: new Map() };
}

export type SdfSceneBakeInstanceStatus =
  | "baked" | "cached" | "dynamic-excluded" | "skipped";

export interface SdfSceneBakeInstanceReport {
  readonly id: string;
  readonly status: SdfSceneBakeInstanceStatus;
  readonly triangles: number;
  /** skipped 时的机器可读原因(规模墙/非法几何);其它状态省略。 */
  readonly reason?: string;
  readonly gridCells?: number;
}

export interface SdfSceneBakeReport {
  readonly instances: readonly SdfSceneBakeInstanceReport[];
  readonly bakedCount: number;
  readonly cachedCount: number;
  readonly excludedDynamicCount: number;
  readonly skippedCount: number;
  readonly dimensions: readonly [number, number, number];
  readonly cellSize: number;
  /** 有界外推圈外的场值(米;有限正数,场永不含非有限值)。 */
  readonly exteriorDistance: number;
}

export interface SdfSceneBakeResult {
  /** 场景级合成 SDF(闭体并集;sampleSdfGrid/sampleSdfCollision 直接可用)。 */
  readonly grid: SdfGrid;
  readonly report: SdfSceneBakeReport;
  readonly memory: SdfCollisionMemoryEstimate;
}

const IDENTITY_BASIS: SdfSceneTransform["basis"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function transformPoint(transform: SdfSceneTransform | undefined,
  x: number, y: number, z: number): [number, number, number] {
  if (!transform) return [x, y, z];
  const b = transform.basis, t = transform.translation;
  return [
    Math.fround(b[0]! * x + b[1]! * y + b[2]! * z + t[0]!),
    Math.fround(b[3]! * x + b[4]! * y + b[5]! * z + t[1]!),
    Math.fround(b[6]! * x + b[7]! * y + b[8]! * z + t[2]!),
  ];
}

function transformedTriangleBounds(mesh: SdfMesh,
  transform: SdfSceneTransform | undefined): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.indices.length; index++) {
    const offset = mesh.indices[index]! * 3;
    const point = transformPoint(transform, mesh.positions[offset]!, mesh.positions[offset + 1]!,
      mesh.positions[offset + 2]!);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return { min, max };
}

/** 逐资产烘焙键:几何 + 变换 + 网格参数全量指纹(任何一项变化即 miss)。 */
function instanceCacheKey(instance: SdfSceneBakeInstance, bounds: { min: [number, number, number];
  max: [number, number, number] }, dimensions: readonly [number, number, number], cellSize: number): string {
  const basis = instance.transform?.basis ?? IDENTITY_BASIS;
  const translation = instance.transform?.translation ?? [0, 0, 0];
  const stream = new Float32Array(meshFloatCount(instance.mesh) + basis.length + translation.length + 13);
  let cursor = 0;
  stream.set(instance.mesh.positions, cursor); cursor += instance.mesh.positions.length;
  for (let index = 0; index < instance.mesh.indices.length; index++) {
    stream[cursor + index] = instance.mesh.indices[index]!;
  }
  cursor += instance.mesh.indices.length;
  stream.set([...basis, ...translation], cursor); cursor += 12;
  stream.set([bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0], bounds.max[1], bounds.max[2],
    dimensions[0], dimensions[1], dimensions[2], cellSize], cursor);
  return fingerprintFloat32(stream);
}

function meshFloatCount(mesh: SdfMesh): number {
  return mesh.positions.length + mesh.indices.length;
}

/** 场景级 SDF 烘焙(纯 CPU,确定性;静态资产哈希增量,动态资产排除)。 */
export function bakeSdfSceneGrid(instances: readonly SdfSceneBakeInstance[],
  options: SdfSceneBakeOptions = {}): SdfSceneBakeResult {
  if (options.dimensions !== undefined && (options.dimensions.length !== 3
    || options.dimensions.some(value => !Number.isSafeInteger(value)
      || value < 2 || value > MAX_SDF_SCENE_BAKE_AXIS))) {
    throw new RangeError(`SDF 场景网格分辨率必须每轴 2..${MAX_SDF_SCENE_BAKE_AXIS}`);
  }
  const cellSize = options.cellSize ?? 0;
  if (!Number.isFinite(cellSize) || cellSize <= 0) throw new RangeError("SDF 场景烘焙 cellSize 必须是有限正数");
  const reports: SdfSceneBakeInstanceReport[] = [];
  const statics: { instance: SdfSceneBakeInstance; bounds: { min: [number, number, number];
    max: [number, number, number] }; triangles: number }[] = [];
  let excluded = 0, skipped = 0;
  for (const instance of instances) {
    const triangles = instance.mesh.indices.length / 3;
    if (instance.dynamic === true) {
      excluded += 1;
      reports.push({ id: instance.id, status: "dynamic-excluded", triangles });
      continue;
    }
    if (!Number.isSafeInteger(triangles) || triangles < 1
      || instance.mesh.positions.length % 3 !== 0
      || !instance.mesh.positions.every(Number.isFinite)
      || instance.mesh.indices.some(index => index >= instance.mesh.positions.length / 3)) {
      skipped += 1;
      reports.push({ id: instance.id, status: "skipped", triangles, reason: "invalid-geometry" });
      continue;
    }
    if (triangles > MAX_SDF_SCENE_BAKE_TRIANGLES) {
      skipped += 1;
      reports.push({ id: instance.id, status: "skipped", triangles,
        reason: `triangle-budget:${MAX_SDF_SCENE_BAKE_TRIANGLES}` });
      continue;
    }
    statics.push({ instance, bounds: transformedTriangleBounds(instance.mesh, instance.transform), triangles });
  }
  if (!statics.length) throw new RangeError("SDF 场景烘焙需要至少一个可烘焙的静态实例(动态/跳过不计)");
  const sceneBounds = resolveSceneBounds(statics, options.bounds);
  const dimensions = options.dimensions ?? deriveDimensions(sceneBounds, cellSize);
  const cells = dimensions[0] * dimensions[1] * dimensions[2];
  if (cells > MAX_SDF_PROFILE_GRID_CELLS) {
    throw new RangeError(`SDF 场景网格 cells 超预算 ${MAX_SDF_PROFILE_GRID_CELLS},实测 ${cells}(降低分辨率或分区烘焙)`);
  }
  const cache = options.cache;
  const exteriorDistance = Math.fround(Math.hypot(
    (sceneBounds.max[0] - sceneBounds.min[0]), (sceneBounds.max[1] - sceneBounds.min[1]),
    (sceneBounds.max[2] - sceneBounds.min[2])));
  const field = new Float32Array(cells).fill(exteriorDistance);
  let baked = 0, cached = 0;
  const pushStatus = (id: string, status: SdfSceneBakeInstanceStatus, triangles: number,
    gridCells: number, reason?: string): void => {
    reports.push({ id, status, triangles, gridCells, ...(reason ? { reason } : {}) });
  };
  for (const entry of statics) {
    const key = instanceCacheKey(entry.instance, entry.bounds, dimensions, cellSize);
    const hit = cache?.entries.get(key);
    if (hit) {
      cached += 1;
      composeInstance(field, hit, sceneBounds, cellSize, dimensions, exteriorDistance);
      pushStatus(entry.instance.id, "cached", entry.triangles,
        hit.dimensions[0] * hit.dimensions[1] * hit.dimensions[2]);
      continue;
    }
    const local = bakeInstanceGrid(entry, cellSize, dimensions);
    if (typeof local === "string") {
      skipped += 1;
      pushStatus(entry.instance.id, "skipped", entry.triangles, 0, local);
      continue;
    }
    baked += 1;
    cache?.entries.set(key, local);
    composeInstance(field, local, sceneBounds, cellSize, dimensions, exteriorDistance);
    pushStatus(entry.instance.id, "baked", entry.triangles,
      local.dimensions[0] * local.dimensions[1] * local.dimensions[2]);
  }
  for (let index = 0; index < field.length; index++) field[index] = Math.fround(field[index]!);
  const grid: SdfGrid = { origin: sceneBounds.min, cellSize, dimensions, distances: field,
    maxSamplingError: Math.sqrt(3) * cellSize * 0.5 };
  reports.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { grid, report: {
    instances: Object.freeze(reports), bakedCount: baked, cachedCount: cached,
    excludedDynamicCount: excluded, skippedCount: skipped, dimensions, cellSize, exteriorDistance },
    memory: estimateSdfCollisionMemory(dimensions, 1) };
}

function resolveSceneBounds(statics: readonly { bounds: { min: [number, number, number];
  max: [number, number, number] } }[], explicit: SdfSceneBakeOptions["bounds"]): { min: [number, number, number];
  max: [number, number, number] } {
  if (explicit) {
    if (explicit.min.length !== 3 || explicit.max.length !== 3
      || [...explicit.min, ...explicit.max].some(value => !Number.isFinite(value))
      || explicit.min.some((value, axis) => value >= explicit.max[axis]!)) {
      throw new RangeError("SDF 场景烘焙显式 bounds 非法(min < max 且全有限)");
    }
    return { min: [...explicit.min], max: [...explicit.max] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const entry of statics) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, entry.bounds.min[axis]!);
      max[axis] = Math.max(max[axis]!, entry.bounds.max[axis]!);
    }
  }
  return { min, max };
}

function deriveDimensions(bounds: { min: [number, number, number]; max: [number, number, number] },
  cellSize: number): readonly [number, number, number] {
  const dims = [0, 1, 2].map(axis =>
    Math.min(MAX_SDF_SCENE_BAKE_AXIS, Math.max(2, Math.ceil((bounds.max[axis]! - bounds.min[axis]!) / cellSize) + 1)));
  return [dims[0]!, dims[1]!, dims[2]!];
}

/** 逐资产有界 SDF(世界系,与场景同 cellSize;±1 cell 外推圈)。失败返回跳过原因。 */
function bakeInstanceGrid(entry: { instance: SdfSceneBakeInstance;
  bounds: { min: [number, number, number]; max: [number, number, number] }; triangles: number },
  cellSize: number, sceneDimensions: readonly [number, number, number]):
  Pick<SdfGrid, "origin" | "cellSize" | "dimensions" | "distances"> | string {
  const pad = cellSize;
  const origin: [number, number, number] = [
    Math.fround(entry.bounds.min[0] - pad), Math.fround(entry.bounds.min[1] - pad),
    Math.fround(entry.bounds.min[2] - pad)];
  const dimensions = [0, 1, 2].map(axis => Math.ceil(
    (entry.bounds.max[axis]! + pad - origin[axis]!) / cellSize) + 1) as [number, number, number];
  if (dimensions.some(value => value > MAX_SDF_SCENE_BAKE_AXIS)) return "grid-extent";
  const cells = dimensions[0] * dimensions[1] * dimensions[2];
  if (cells * entry.triangles > MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES) {
    return `sample-budget:${MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES}`;
  }
  const positions = entry.instance.mesh.positions, indices = entry.instance.mesh.indices;
  const world = new Float32Array(positions.length);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const point = transformPoint(entry.instance.transform, positions[vertex * 3]!,
      positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!);
    world[vertex * 3] = point[0]; world[vertex * 3 + 1] = point[1]; world[vertex * 3 + 2] = point[2];
  }
  const grid = buildSdfGrid({ positions: world, indices: entry.instance.mesh.indices },
    origin, dimensions, cellSize);
  return { origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions,
    distances: grid.distances };
}

/** min 合成(闭体并集):域外实例不贡献;钳制到有界外推值。 */
function composeInstance(field: Float32Array, local: Pick<SdfGrid, "origin" | "cellSize"
  | "dimensions" | "distances">, sceneOrigin: { min: [number, number, number] }, cellSize: number,
  sceneDimensions: readonly [number, number, number], exteriorDistance: number): void {
  const [nx, ny, nz] = sceneDimensions, [lx, ly, lz] = local.dimensions;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const wx = sceneOrigin.min[0] + x * cellSize, wy = sceneOrigin.min[1] + y * cellSize,
      wz = sceneOrigin.min[2] + z * cellSize;
    const gx = Math.floor((wx - local.origin[0]) / cellSize);
    const gy = Math.floor((wy - local.origin[1]) / cellSize);
    const gz = Math.floor((wz - local.origin[2]) / cellSize);
    if (gx < 0 || gy < 0 || gz < 0 || gx > lx - 1 || gy > ly - 1 || gz > lz - 1) continue;
    const value = local.distances[(gz * ly + gy) * lx + gx]!;
    const index = (z * ny + y) * nx + x;
    field[index] = Math.min(field[index]!, Math.max(value, -exteriorDistance));
  }
}
