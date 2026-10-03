/**
 * 阴影光线 GPU 探针·案例与 CPU 参考单一来源（Node 仲裁腿与浏览器腿共用本模块，防口径分叉）。
 * 场景：确定性地面网格 + 6 遮挡体（SAH BLAS ×3 + IncrementalTlas 实例层）；
 * 方向光阴影参考：
 * - 掩码仲裁：traceTlasClosest（既有 CPU 两级参考，遮挡查询语义同 GPU）；
 * - 光栅 shadow map：沿光线方向的正交 z-buffer 软件光栅化（本文件实现，仅作 RMSE 对比参考，
 *   复用 RT 阴影语义：阴影=0/受光=1），RMSE 门 ≤0.05（同分辨率）。
 */

import { buildSahBvh } from "../src/rayTracing/blasBuilder.js";
import { IncrementalTlasScene } from "../src/rayTracing/incrementalTlas.js";
import { packDirectionalShadowRays, shadowMaskFromTlas } from "../src/rayTracing/shadowRayPass.js";
import { buildTlas, type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import type { TraceQuery } from "../src/rayTracing/rayTrace.js";
import type { RayBlasDescriptor } from "../src/rayTracing/rayBackendTypes.js";

export const SHADOW_LIGHT_DIR: readonly [number, number, number] = normalize([0.35, 1, 0.2]);
export const SHADOW_T_MAX = 60;
export const SHADOW_RASTER_RESOLUTION = 512;

/** 确定性地面网格 BLAS（meshlet 级三角形集；20×20 单元 = 800 三角）。 */
export function floorBlas(): RayBlasDescriptor {
  const stride = 21, vertices: number[] = [], indices: number[] = [];
  for (let z = 0; z < stride; z++) for (let x = 0; x < stride; x++) vertices.push(x - 10, 0, z - 10);
  for (let z = 0; z < stride - 1; z++) for (let x = 0; x < stride - 1; x++) {
    const a = z * stride + x;
    indices.push(a, a + stride, a + 1, a + 1, a + stride, a + stride + 1);
  }
  return { id: "shadow-floor", vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** 确定性轴对齐盒 BLAS（12 三角）。 */
export function boxBlas(id: string, cx: number, cz: number, half: number, y0: number, y1: number): RayBlasDescriptor {
  const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const vertices: number[] = [], indices: number[] = [];
  quads.forEach((quad, qi) => {
    const base = qi * 4;
    quad.forEach(cI => vertices.push(...c[cI]!));
    // 外向绕序（法线朝外；阴影光栅的背面剔除依赖它，绕序反=整盒被剔光）。
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  });
  return { id, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

export interface ShadowScene {
  readonly blasList: readonly RayBlasDescriptor[];
  readonly instances: readonly TlasInstanceDescriptor[];
  readonly tlas: IncrementalTlasScene;
}

/** 构建探针场景（SAH BLAS 缓存 + 增量 TLAS 实例层——compute BVH 骨架全链路）。 */
export function buildShadowScene(): ShadowScene {
  const blasList = [
    floorBlas(),
    boxBlas("block-a", -3, -1, 1.5, 0, 3.5),
    boxBlas("block-b", 3.5, 2.5, 1.2, 0, 2.5),
    boxBlas("pillar", 0.5, 5, 0.6, 0, 6),
  ];
  const instances = blasList.map((blas, index) => ({
    id: blas.id, blas, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 << index,
  }));
  const tlas = new IncrementalTlasScene(blasList, { sah: { binCount: 8 } });
  tlas.updateInstances(instances);
  return { blasList, instances, tlas };
}

/** 地面受光点网格（count = grid×grid，y=0.02 脱自相交）。 */
export function buildReceiverPoints(grid: number): Float32Array {
  const receivers = new Float32Array(grid * grid * 3);
  for (let z = 0; z < grid; z++) for (let x = 0; x < grid; x++) {
    receivers[(z * grid + x) * 3] = -8 + 16 * x / (grid - 1);
    receivers[(z * grid + x) * 3 + 1] = 0.02;
    receivers[(z * grid + x) * 3 + 2] = -8 + 16 * z / (grid - 1);
  }
  return receivers;
}

export function buildShadowBatch(receivers: Float32Array) {
  return packDirectionalShadowRays(receivers, ...SHADOW_LIGHT_DIR, SHADOW_T_MAX, 0xff);
}

/** CPU 掩码仲裁（遮挡查询语义与 GPU 一致：traceTlasClosest 命中=0 遮挡、miss=1 可见）。 */
export function referenceShadowMask(scene: ShadowScene, receivers: Float32Array):
  { mask: Uint32Array; queries: TraceQuery[] } {
  const tlas = buildTlas(scene.instances);
  const batch = buildShadowBatch(receivers);
  const queries: TraceQuery[] = [];
  for (let i = 0; i < batch.tMax.length; i++) {
    queries.push({ ox: batch.origins[i * 3]!, oy: batch.origins[i * 3 + 1]!, oz: batch.origins[i * 3 + 2]!,
      dx: batch.directions[i * 3]!, dy: batch.directions[i * 3 + 1]!, dz: batch.directions[i * 3 + 2]!, tMax: batch.tMax[i]! });
  }
  return { mask: shadowMaskFromTlas(tlas, queries, 0xff), queries };
}

function normalize(v: readonly number[]): readonly [number, number, number] {
  const length = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / length, v[1]! / length, v[2]! / length];
}

export interface RasterShadowMap {
  readonly resolution: number;
  readonly depth: Float32Array;
  readonly origin: readonly [number, number, number];
  readonly right: readonly [number, number, number];
  readonly up: readonly [number, number, number];
  /** 光空间中心（光栅/采样同一中心化映射：texel = (dot-center+extent)/(2extent)×res）。 */
  readonly centerX: number;
  readonly centerY: number;
  readonly extent: number;
  readonly lightDepth: readonly [number, number, number];
}

/**
 * 软件光栅 shadow map：沿 -toLight 的正交投影 z-buffer（逐三角形重心坐标填充）。
 * depth[texel] = 沿 toLight 的深度（最近遮挡面）；1e9 = 空。
 */
export function rasterizeShadowMap(scene: ShadowScene, resolution: number = SHADOW_RASTER_RESOLUTION): RasterShadowMap {
  const light = SHADOW_LIGHT_DIR;
  const right = normalize([light[1]!, -light[0]!, 0]);
  const up = normalize([
    right[1]! * light[2]! - right[2]! * light[1]!,
    right[2]! * light[0]! - right[0]! * light[2]!,
    right[0]! * light[1]! - right[1]! * light[0]!]);
  const depth = new Float32Array(resolution * resolution).fill(1e9);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minD = Infinity;
  for (const blas of scene.blasList) {
    for (let v = 0; v < blas.vertices.length; v += 3) {
      const p = [blas.vertices[v]!, blas.vertices[v + 1]!, blas.vertices[v + 2]!];
      const px = dot(right, p), py = dot(up, p), pd = dot(light, p);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      minD = Math.min(minD, pd);
    }
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2];
  const extent = Math.max(maxX - minX, maxY - minY) * 0.5 + 1;
  const origin: [number, number, number] = [
    right[0]! * center[0]! + up[0]! * center[1]! + light[0]! * (minD - 5),
    right[1]! * center[0]! + up[1]! * center[1]! + light[1]! * (minD - 5),
    right[2]! * center[0]! + up[2]! * center[1]! + light[2]! * (minD - 5)];
  for (const blas of scene.blasList) {
    for (let t = 0; t < blas.indices.length; t += 3) {
      const p: Array<[number, number, number]> = [0, 1, 2].map(c => {
        const vi = blas.indices[t + c]! * 3;
        return [blas.vertices[vi]!, blas.vertices[vi + 1]!, blas.vertices[vi + 2]!] as [number, number, number];
      });
      // 背面剔除（dot(faceNormal, toLight) ≤ 0 跳过）：闭合体的掠射侧面在光空间投影成
      // 细长 sliver，其深度比同 texel 的地面更近，会把真实受光区误判成阴影（RMSE 杀手）。
      const e1 = [p[1]![0]! - p[0]![0]!, p[1]![1]! - p[0]![1]!, p[1]![2]! - p[0]![2]!];
      const e2 = [p[2]![0]! - p[0]![0]!, p[2]![1]! - p[0]![1]!, p[2]![2]! - p[0]![2]!];
      const normal = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!,
        e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      if (normal[0]! * light[0]! + normal[1]! * light[1]! + normal[2]! * light[2]! <= 0) continue;
      const sx = p.map(q => (dot(right, q) - center[0]! + extent) / (extent * 2) * resolution);
      const sy = p.map(q => (dot(up, q) - center[1]! + extent) / (extent * 2) * resolution);
      // 深度 = -(沿光方向投影)：离光越近（dot 越大）数值越小，z-test 保留最近遮挡面。
      const sd = p.map(q => -dot(light, q));
      const x0 = Math.max(0, Math.floor(Math.min(...sx))), x1 = Math.min(resolution - 1, Math.ceil(Math.max(...sx)));
      const y0 = Math.max(0, Math.floor(Math.min(...sy))), y1 = Math.min(resolution - 1, Math.ceil(Math.max(...sy)));
      const area = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sx[2]! - sx[0]!) * (sy[1]! - sy[0]!);
      if (Math.abs(area) < 1e-9) continue;
      (globalThis as { __triKept?: number }).__triKept = ((globalThis as { __triKept?: number }).__triKept ?? 0) + 1;
      if ((globalThis as { __triKept?: number }).__triKept !== undefined && (globalThis as { __triKept?: number }).__triKept! <= 12) console.log();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((sx[1]! - px) * (sy[2]! - py) - (sx[2]! - px) * (sy[1]! - py)) / area;
        const w1 = ((sx[2]! - px) * (sy[0]! - py) - (sx[0]! - px) * (sy[2]! - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * sd[0]! + w1 * sd[1]! + w2 * sd[2]!;
        const index = y * resolution + x;
        if (d < depth[index]!) depth[index] = d;
      }
    }
  }
  return { resolution, depth, origin, right, up, centerX: center[0]!, centerY: center[1]!, extent, lightDepth: light };
}

/**
 * 光栅 shadow map 采样：受光点投影到光空间，深度比较（容差含地面深度坡度）判阴影。
 * 语义与 RT 阴影一致（阴影=0/受光=1）；图外点记受光（保守可见）。
 */
export function sampleRasterShadow(map: RasterShadowMap, point: readonly [number, number, number]): 0 | 1 {
  const rel = [point[0]! - map.origin[0]!, point[1]! - map.origin[1]!, point[2]! - map.origin[2]!];
  const px = dot(map.right, rel), py = dot(map.up, rel), pd = -dot(map.lightDepth, point);
  if (px < -map.extent || py < -map.extent || px >= map.extent || py >= map.extent) return 1;
  const x = Math.min(map.resolution - 1, Math.floor((px + map.extent) / (map.extent * 2) * map.resolution));
  const y = Math.min(map.resolution - 1, Math.floor((py + map.centerY === undefined ? 0 : map.centerY) * 0 + (py + map.extent) / (map.extent * 2) * map.resolution));
  const stored = map.depth[y * map.resolution + x]!;
  // 0.08 世界单位深度容差：512² texel ~0.04 世界单位 × 地面深度坡度 ~0.4 → 斜率误差 ~0.016。
  return pd > stored + 0.08 ? 0 : 1;
}

/** RMSE 门（同分辨率掩码对：GPU BVH mask vs 光栅 shadow map 掩码）。 */
export function shadowMaskRmse(gpuMask: Uint32Array, rasterMask: Uint32Array): number {
  if (gpuMask.length !== rasterMask.length) throw new Error("RMSE masks must have equal length.");
  let sum = 0;
  for (let i = 0; i < gpuMask.length; i++) {
    const delta = gpuMask[i]! - rasterMask[i]!;
    sum += delta * delta;
  }
  return Math.sqrt(sum / gpuMask.length);
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

/** 探针案例（perf = 10k 阴影光线；rmse = 同点集 vs 光栅 map）。 */
export function buildShadowCases() {
  return {
    perfRays: 10_000,
    receiverGrid: 100,
    scene: buildShadowScene(),
  };
}

/** traceTlasClosest 的 CPU 仲裁（供 Node 侧全量预算）。 */
export function cpuShadowMask(scene: ShadowScene, receivers: Float32Array):
  { mask: Uint32Array; queries: TraceQuery[] } {
  return referenceShadowMask(scene, receivers);
}

// 保持 traceTlasClosest 引用（类型面），防止未来裁剪误删 CPU 仲裁路径。
void buildTlas;
