/**
 * A2 真值提供方(测试支持,非 .test):F6 共享距离场夹具 + 解析凸包真值。
 * 凸包 = 五边形 (0,0)(3,0)(3,1)(1,3)(0,3) × z∈[0,1],与 rapierSdfConcaveGolden
 * 的 rapier.ColliderDesc.convexHull 同一角点集;native 对照侧
 * (deep-engine-native/tests/sdf_collision_profile_truth.rs)用真实 rapier3d
 * 凸包点投影互验,两侧对照表逐项一致。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sdfColliderPayloadToGrid } from "./sdfCollisionBridge.js";
import { createSdfQueryPointStream, SDF_QUERY_LCG_SEED } from "./sdfCollisionProfile.js";
import type { SdfGrid } from "./sdfGrid.js";
import type { SdfProfileTruthRow } from "./sdfCollisionContract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** F6 共享夹具(TS 生成、native include_str! 同源):凹 L 棱柱 16×16×8 距离场。 */
const FIXTURE_PATH = resolve(HERE, "../../../deep-engine-native/src/physics_sdf_l_fixture.json");

export const GRID_ORIGIN = [-0.125, -0.125, -0.125] as const;
export const GRID_CELL_SIZE = 0.25;
export const GRID_DIMENSIONS = [16, 16, 8] as const;

export function loadFixtureGrid(): SdfGrid {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { distances: number[] };
  return {
    ...sdfColliderPayloadToGrid({
      origin: GRID_ORIGIN, cellSize: GRID_CELL_SIZE, dimensions: GRID_DIMENSIONS,
      distances: fixture.distances,
    }),
    maxSamplingError: Math.sqrt(3) * GRID_CELL_SIZE * 0.5,
  };
}

const HULL_2D: readonly (readonly [number, number])[] =
  [[0, 0], [3, 0], [3, 1], [1, 3], [0, 3]];

/**
 * 凸包真值(解析):凸包体 = 凸多边形 × 区间的乘积集,最近点 = 2D 最近点 + z 钳制。
 * 幽灵面判定:最近凸包面点的 2D 位置落在楔形(多边形 ∖ L,x>1 且 y>1)内 ⇒
 * 该面为凸包独有面(对角切面及其上下的端面楔形区),不与源几何共享。
 */
export function hullTruth(point: readonly [number, number, number]): SdfProfileTruthRow {
  const [px, py, pz] = point;
  let maxSide = -Infinity;
  let bestEdge = -1;
  let bestDist = Infinity;
  let bestT = -1;
  for (let i = 0; i < HULL_2D.length; i++) {
    const [ax, ay] = HULL_2D[i]!;
    const [bx, by] = HULL_2D[(i + 1) % HULL_2D.length]!;
    const ex = bx - ax, ey = by - ay;
    const length = Math.hypot(ex, ey);
    // 有向侧距:CCW 多边形,side > 0 表示在该边外侧;全部 ≤ 0 即在多边形内。
    const side = ((px - ax) * ey - (py - ay) * ex) / length;
    maxSide = Math.max(maxSide, side);
    const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (length * length)));
    const dx = px - (ax + t * ex), dy = py - (ay + t * ey);
    const segment = Math.hypot(dx, dy);
    if (segment < bestDist) { bestDist = segment; bestEdge = i; bestT = t; }
  }
  const inside2 = maxSide <= 0;
  const depth2 = -maxSide;
  const qz = Math.max(0, Math.min(1, pz));
  const dz = pz < 0 ? -pz : pz > 1 ? pz - 1 : 0;
  if (inside2 && dz > 0) {
    // 2D 内部、z 在端面之外:最近点 = 端面直投影;法线指向查询点一侧。
    const wedge = px > 1 + 1e-9 && py > 1 + 1e-9;
    return {
      point, hullDistance: dz,
      hullNormal: [0, 0, pz > 0.5 ? 1 : -1], hullFeatureIsGhostFace: wedge,
    };
  }
  const outside = !inside2;
  const [ax, ay] = HULL_2D[bestEdge]!;
  const [bx, by] = HULL_2D[(bestEdge + 1) % HULL_2D.length]!;
  const qx2 = ax + bestT * (bx - ax), qy2 = ay + bestT * (by - ay);
  const ddx = px - qx2, ddy = py - qy2, ddz = pz - qz;
  const dist = Math.hypot(ddx, ddy, ddz);
  const ghostFace = qx2 > 1 + 1e-9 && qy2 > 1 + 1e-9;
  const hullDistance = outside ? dist : -Math.min(depth2, Math.min(pz, 1 - pz));
  let normal: [number, number, number];
  if (outside) {
    normal = dist > 0 ? [ddx / dist, ddy / dist, ddz / dist] : [0, 0, 1];
  } else if (Math.min(pz, 1 - pz) <= depth2) {
    // 最近边界是 z 端面:法线指向该端面(距离增大方向)。
    normal = [0, 0, pz < 0.5 ? -1 : 1];
  } else {
    normal = dist > 0 ? [-ddx / dist, -ddy / dist, 0] : [0, 0, 1];
  }
  return { point, hullDistance, hullNormal: normal, hullFeatureIsGhostFace: ghostFace };
}

/** LCG 采样点 → 真值行(与 native 侧同 seed 同点集)。 */
export function lcgTruthRows(grid: SdfGrid, count: number): SdfProfileTruthRow[] {
  return createSdfQueryPointStream(grid, count, SDF_QUERY_LCG_SEED).map(hullTruth);
}
