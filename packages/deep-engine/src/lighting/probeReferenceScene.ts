import type { ProbeAabb, ProbeVector3 } from "./probeClipmapPlan.js";

/**
 * T02 高采样 CPU 参考积分的场景侧：房间 + 薄墙 + 门洞 + 天窗的手工构造场景，与确定性
 * (seed 固定) 射线/AABB 数学。只服务 CPU 参考积分器与预算收敛推演，不进入 GPU 链。
 *
 * == 参考功能量（与积分器共同遵守的合同） ==
 * 探针存储值 = 命中方向 Lambert 直射、miss 方向环境项的球面方向均值（与
 * probeSceneRadianceProducer 的一跳口径同构：方向光无距离衰减、命中点默认不追第二次
 * 阴影射线）：
 *   L(p,ω) = hit ? albedo · max(dot(n, Ldir), 0) · I · (shadowed ? vis : 1) : ambient
 * `shadowed: true`（物理真值口径）对命中点追加朝光阴影射线，用于墙内探针亮斑证明的
 * 明暗对照；RMSE 验收用引擎口径（shadowed: false），参考与估计共用同一功能量，
 * RMSE 只隔离方向采样误差。
 */

/** 参考场景漫反射 AABB（反照率为线性 RGB，[0,1]）。 */
export interface ReferenceBox {
  readonly min: ProbeVector3;
  readonly max: ProbeVector3;
  readonly albedo: ProbeVector3;
}
/** 方向光（producer 的 primary 同义：指向光源单位方向 + 强度，无距离衰减）。 */
export interface ReferenceDirectionalLight {
  readonly surfaceToLightWorld: ProbeVector3;
  readonly intensity: number;
}
export interface ReferenceScene {
  readonly boxes: readonly ReferenceBox[];
  readonly light: ReferenceDirectionalLight;
  /** miss 方向环境项（线性 RGB）。 */
  readonly ambient: ProbeVector3;
  readonly bounds: ProbeAabb;
}
export interface ReferenceSceneHit {
  readonly t: number;
  readonly normal: ProbeVector3;
  readonly albedo: ProbeVector3;
}

/** 地板反照率（联测 RenderPacket 构建器共享同一常量，防止双源漂移）。 */
export const REFERENCE_FLOOR_ALBEDO = Object.freeze([0.7, 0.68, 0.66]) as ProbeVector3;
/** 墙体/天花反照率。 */
export const REFERENCE_WALL_ALBEDO = Object.freeze([0.5, 0.5, 0.52]) as ProbeVector3;

const ALBEDO_FLOOR = REFERENCE_FLOOR_ALBEDO;
const ALBEDO_WALL = REFERENCE_WALL_ALBEDO;

function box(min: readonly number[], max: readonly number[], albedo: ProbeVector3): ReferenceBox {
  return Object.freeze({ min: Object.freeze([...min]) as ProbeVector3,
    max: Object.freeze([...max]) as ProbeVector3, albedo });
}

/**
 * 房间 + 薄墙 + 门洞 + 天窗（确定性，冻结输出）：
 * - 内域 8×3×6（x∈[0,8], y∈[0,3], z∈[0,6]），外墙厚 0.2；
 * - 薄墙 x=4、厚 0.1，门洞 z∈[2.5,3.5] 且 y∈[0,2.2]（含门楣）；
 * - 天窗：天花板 x∈[1.5,3]、z∈[2,4] 开洞，方向光近乎垂直向下（略带 +x 倾斜），
 *   光柱落在亮侧地板 x∈[~2.2,3.8]，其余室内为阴影真值（shadowed 口径）；
 * - 引擎口径（无阴影射线）下墙内探针的射线刺穿 0.1 薄墙取到亮面 → 亮斑伪源的来源。
 */
export function buildReferenceRoomScene(): ReferenceScene {
  const shell = 0.2;
  const boxes: ReferenceBox[] = [
    box([-shell, -shell, -shell], [8 + shell, 0, 6 + shell], ALBEDO_FLOOR), // 地板
    box([-shell, 3, -shell], [8 + shell, 3 + shell, 2], ALBEDO_WALL), // 天花（天窗 -z 侧）
    box([-shell, 3, 4], [8 + shell, 3 + shell, 6 + shell], ALBEDO_WALL), // 天花（天窗 +z 侧）
    box([-shell, 3, 2], [1.5, 3 + shell, 4], ALBEDO_WALL), // 天花（天窗 -x 侧）
    box([3, 3, 2], [8 + shell, 3 + shell, 4], ALBEDO_WALL), // 天花（天窗 +x 侧）
    box([-shell, 0, -shell], [8 + shell, 3, 0], ALBEDO_WALL), // -z 墙
    box([-shell, 0, 6], [8 + shell, 3, 6 + shell], ALBEDO_WALL), // +z 墙
    box([-shell, 0, -shell], [0, 3, 6 + shell], ALBEDO_WALL), // -x 墙
    box([8, 0, -shell], [8 + shell, 3, 6 + shell], ALBEDO_WALL), // +x 墙
    box([3.95, 0, 0], [4.05, 3, 2.5], ALBEDO_WALL), // 薄墙（门洞 -z 侧）
    box([3.95, 0, 3.5], [4.05, 3, 6], ALBEDO_WALL), // 薄墙（门洞 +z 侧）
    box([3.95, 2.2, 2.5], [4.05, 3, 3.5], ALBEDO_WALL), // 门楣
  ];
  return Object.freeze({
    boxes: Object.freeze(boxes),
    light: Object.freeze({ surfaceToLightWorld: Object.freeze([0.25, 1, 0.12]) as ProbeVector3,
      intensity: 1 }),
    ambient: Object.freeze([0.02, 0.02, 0.025]) as ProbeVector3,
    bounds: Object.freeze({ min: Object.freeze([-shell, -shell, -shell]) as ProbeVector3,
      max: Object.freeze([8 + shell, 3 + shell, 6 + shell]) as ProbeVector3 }),
  });
}

/** 薄墙三块（含门楣）的遮挡体下标段：relocation 与埋入判定用。 */
export function referenceThinWallBoxes(scene: ReferenceScene): readonly ProbeAabb[] {
  return Object.freeze(scene.boxes.slice(9, 12).map(box => ({ min: box.min, max: box.max })));
}

/** 场景对角线长度（射线 tMax 语义：对角线之外的 miss 视为无穷远）。 */
export function referenceSceneDiagonal(scene: ReferenceScene): number {
  const extent = scene.bounds.max.map((value, axis) => value - scene.bounds.min[axis]!);
  return Math.hypot(...extent);
}

const EPS = 1e-9;

/**
 * 射线 vs AABB 场景最近命中（slab 法）。原点在 box 内时返回穿出面（t=tFar），
 * 命中法线统一取命中轴上 -sign(dir[axis])（双面着色，朝向来波方向）。
 * 无命中返回 undefined；tMax 必须有限正值。
 */
export function intersectReferenceScene(scene: ReferenceScene, origin: ProbeVector3,
  direction: ProbeVector3, tMax: number): ReferenceSceneHit | undefined {
  if (!Number.isFinite(tMax) || tMax <= 0) throw new RangeError("Reference ray tMax must be finite and positive.");
  let best: ReferenceSceneHit | undefined;
  for (const candidate of scene.boxes) {
    const hit = intersectReferenceBox(candidate, origin, direction, best ? best.t : tMax);
    if (hit) best = hit;
  }
  return best;
}

function intersectReferenceBox(box: ReferenceBox, origin: ProbeVector3, direction: ProbeVector3,
  limit: number): ReferenceSceneHit | undefined {
  let tNear = -Infinity, tFar = Infinity, nearAxis = 0, farAxis = 0;
  for (let axis = 0; axis < 3; axis++) {
    const d = direction[axis]!, o = origin[axis]!, lo = box.min[axis]!, hi = box.max[axis]!;
    if (Math.abs(d) <= EPS) {
      if (o < lo || o > hi) return undefined; // 平行且在 slab 外
      continue;
    }
    const inverse = 1 / d;
    let t1 = (lo - o) * inverse, t2 = (hi - o) * inverse;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tNear) { tNear = t1; nearAxis = axis; }
    if (t2 < tFar) { tFar = t2; farAxis = axis; }
  }
  if (tNear > tFar || tFar <= EPS) return undefined;
  const inside = tNear <= EPS;
  const t = inside ? tFar : tNear;
  if (t >= limit || t <= EPS) return undefined;
  // 双面语义：命中法线恒取命中轴上 -sign(dir[axis])（朝向来波方向）；原点在 box 内时
  // 命中的是穿出面，命中轴为 tFar 所在轴。
  const hitAxis = inside ? farAxis : nearAxis;
  const sign = direction[hitAxis]! >= 0 ? -1 : 1;
  const normalComponents: number[] = [0, 0, 0];
  normalComponents[hitAxis] = sign;
  const normal: ProbeVector3 = [normalComponents[0]!, normalComponents[1]!, normalComponents[2]!];
  return Object.freeze({ t, normal: Object.freeze(normal), albedo: box.albedo });
}

/**
 * 命中点直射（参考合同）：albedo·max(N·L,0)·I；shadowed 时先沿法线抬升 1e-3 再向光追
 * 阴影射线（任何命中 → 遮挡 → 0；逃出天窗即受光）。背光面返回全零。
 */
export function sampleReferenceDirect(scene: ReferenceScene, position: ProbeVector3,
  normal: ProbeVector3, albedo: ProbeVector3, shadowed: boolean): ProbeVector3 {
  const light = scene.light.surfaceToLightWorld;
  const cosine = normal.reduce((sum, value, axis) => sum + value * light[axis]!, 0);
  if (!(cosine > 0)) return [0, 0, 0];
  if (shadowed) {
    const lifted: ProbeVector3 = [position[0]! + normal[0]! * 1e-3,
      position[1]! + normal[1]! * 1e-3, position[2]! + normal[2]! * 1e-3];
    if (intersectReferenceScene(scene, lifted, light, referenceSceneDiagonal(scene)) !== undefined) {
      return [0, 0, 0];
    }
  }
  const scale = scene.light.intensity * cosine;
  return [albedo[0]! * scale, albedo[1]! * scale, albedo[2]! * scale];
}

/**
 * mulberry32 确定性 PRNG（seed 固定 → 序列固定）；参考积分的全部随机性来源。
 */
export function createReferenceRng(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError("Reference RNG seed must be a nonnegative safe integer.");
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 均匀球面方向（z 均匀、方位角均匀），输入 u/v ∈ [0,1)。 */
export function uniformSphereDirection(u: number, v: number): ProbeVector3 {
  const z = 1 - 2 * u;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = 2 * Math.PI * v;
  const direction: ProbeVector3 = [radius * Math.cos(phi), z, radius * Math.sin(phi)];
  return Object.freeze(direction);
}
