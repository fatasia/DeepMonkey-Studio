/**
 * Brief-GI M1 场景级 SDF 烘焙的内层:变换/逐资产域烘焙/min 合成(自 sdfSceneBake.ts
 * 按职责拆分,源大小门 ≤300 行)。合同见 sdfSceneBake.ts 头注。
 */
import { buildSdfGrid, type SdfGrid, type SdfMesh } from "../physics/sdfGrid.js";
import type { SdfSceneBakeInstance, SdfSceneTransform } from "./sdfSceneBake.js";

/** 场景网格每轴上限(与 buildSdfGrid 逐轴 ≤128 同源)。 */
export const MAX_SDF_SCENE_BAKE_AXIS = 128;
/** 与 buildSdfGrid 的逐 mesh 三角形预算同源(超出即规模墙,跳过并记录)。 */
export const MAX_SDF_SCENE_BAKE_TRIANGLES = 16_384;
/** buildSdfGrid 的 cells×triangles 采样预算(原值,防调用期抛错前置拦截)。 */
export const MAX_SDF_SCENE_BAKE_TRIANGLE_SAMPLES = 16_777_216;

export const IDENTITY_BASIS: SdfSceneTransform["basis"] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function transformPoint(transform: SdfSceneTransform | undefined,
  x: number, y: number, z: number): [number, number, number] {
  if (!transform) return [x, y, z];
  const b = transform.basis, t = transform.translation;
  return [
    Math.fround(b[0]! * x + b[1]! * y + b[2]! * z + t[0]!),
    Math.fround(b[3]! * x + b[4]! * y + b[5]! * z + t[1]!),
    Math.fround(b[6]! * x + b[7]! * y + b[8]! * z + t[2]!),
  ];
}

/** 逐资产烘焙条目(主烘焙循环的 statics 元组)。 */
export interface InstanceBakeEntry {
  readonly instance: SdfSceneBakeInstance;
  readonly bounds: { min: [number, number, number]; max: [number, number, number] };
  readonly triangles: number;
}

export function transformedTriangleBounds(mesh: SdfMesh,
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

export function deriveDimensions(bounds: { min: [number, number, number]; max: [number, number, number] },
  cellSize: number): readonly [number, number, number] {
  const dims = [0, 1, 2].map(axis =>
    Math.min(MAX_SDF_SCENE_BAKE_AXIS, Math.max(2, Math.ceil((bounds.max[axis]! - bounds.min[axis]!) / cellSize) + 1)));
  return [dims[0]!, dims[1]!, dims[2]!];
}

/** 逐资产有界 SDF(世界系,与场景同 cellSize)。失败返回跳过原因。 */
export function bakeInstanceGrid(entry: InstanceBakeEntry,
  cellSize: number, sceneDimensions: readonly [number, number, number],
  sceneBounds: { min: [number, number, number]; max: [number, number, number] },
  instanceDomain: "aabb" | "scene"):
  Pick<SdfGrid, "origin" | "cellSize" | "dimensions" | "distances"> | string {
  const pad = instanceDomain === "scene" ? 0 : cellSize;
  const origin: [number, number, number] = instanceDomain === "scene"
    ? [sceneBounds.min[0]!, sceneBounds.min[1]!, sceneBounds.min[2]!]
    : [Math.fround(entry.bounds.min[0]! - pad), Math.fround(entry.bounds.min[1]! - pad),
      Math.fround(entry.bounds.min[2]! - pad)];
  const dimensions: [number, number, number] = instanceDomain === "scene"
    ? [sceneDimensions[0]!, sceneDimensions[1]!, sceneDimensions[2]!]
    : [Math.ceil((entry.bounds.max[0]! + pad - origin[0]!) / cellSize) + 1,
      Math.ceil((entry.bounds.max[1]! + pad - origin[1]!) / cellSize) + 1,
      Math.ceil((entry.bounds.max[2]! + pad - origin[2]!) / cellSize) + 1];
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

/**
 * min 合成(闭体并集):最近格点查找(round——f32 origin 的 1 ulp 偏移不得放大成整格
 * 错位),域外 cell 不贡献("scene" 域与场景格恒同格,逐 cell 全覆盖)。
 */
export function composeInstance(field: Float32Array, local: Pick<SdfGrid, "origin" | "cellSize"
  | "dimensions" | "distances">, sceneOrigin: { min: [number, number, number] }, cellSize: number,
  sceneDimensions: readonly [number, number, number], exteriorDistance: number): void {
  const [nx, ny, nz] = sceneDimensions, [lx, ly, lz] = local.dimensions;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const wx = sceneOrigin.min[0] + x * cellSize, wy = sceneOrigin.min[1] + y * cellSize,
      wz = sceneOrigin.min[2] + z * cellSize;
    const gx = Math.round((wx - local.origin[0]) / cellSize);
    const gy = Math.round((wy - local.origin[1]) / cellSize);
    const gz = Math.round((wz - local.origin[2]) / cellSize);
    if (gx < 0 || gy < 0 || gz < 0 || gx > lx - 1 || gy > ly - 1 || gz > lz - 1) continue;
    const value = local.distances[(gz * ly + gy) * lx + gx]!;
    const index = (z * ny + y) * nx + x;
    field[index] = Math.min(field[index]!, Math.max(value, -exteriorDistance));
  }
}
