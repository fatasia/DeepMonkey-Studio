/// <reference types="@webgpu/types" />
/**
 * 反射 closest-hit GPU 探针·案例与 CPU 参考单一来源(Node 仲裁腿与浏览器腿共用本模块,
 * 防口径分叉;同 shadowRayGpuCases 惯例)。
 *
 * == 场景 ==
 * 确定性三实例(SAH BLAS ×3 + IncrementalTlas 实例层,变换全恒等——TLAS 仿射语义已由
 * rayTraceTlasExecutor 门覆盖,本探针专注帧通道语义):
 * - wall:z=0 竖直墙(反射接收面;深度差分法线 ≈ (0,0,1));
 * - mirror-box:墙前悬浮轴对齐盒(部分反射命中区;其余像素 miss);
 * - lean-panel:斜靠墙面的旋转四边形(非零深度梯度 + 边缘掠射 → 走 grazing-miss 分支)。
 *
 * == CPU 参考语义(与 rayTraceClosestFrameKernel 逐分支同序) ==
 * 深度差分法线(右/下单邻域,越界/背景/退化 miss)→ 朝向相机定向 → 掠射门(-1e-4)→
 * 镜面反射 → bias 偏移 origin → traceTlasClosest 仲裁(t 与命中恒等);
 * 命中法线参考 = 命中三角几何法线(局部,朝向射线定向)经 M⁻ᵀ(M=worldToLocal 3×3)
 * 变换到世界后归一化、朝向射线定向。深度输入取自 GPU 深度纹理读回(与内核消费同一
 * f32 值,消除光栅精度差),CPU 侧 f64 精算,t 相对容差 2e-3 / 法线点积 ≥ 1-1e-3
 * 吸收 f32/f64 舍入差。
 */

import { IncrementalTlasScene } from "../src/rayTracing/incrementalTlas.js";
import { buildTlas, invertAffine3x4, traceTlasClosest,
  type TlasInstanceDescriptor } from "../src/rayTracing/tlas.js";
import type { RayBlasDescriptor } from "../src/rayTracing/rayBackendTypes.js";

export const REFLECTION_T_MAX = 40;
export const REFLECTION_BIAS = 0.01;
export const REFLECTION_RESOLUTION = 128;
/** 相机(与内核 uniform 同源;probe 浏览器腿据此渲染深度)。 */
export const REFLECTION_EYE: readonly [number, number, number] = [0, 2.2, 5.5];
export const REFLECTION_TARGET: readonly [number, number, number] = [0, 1.4, 0];

/** 竖直反射墙(z=0,面向 +z)。 */
function wallBlas(): RayBlasDescriptor {
  return { id: "reflection-wall",
    vertices: Float32Array.from([-5, 0, 0, 5, 0, 0, 5, 4, 0, -5, 4, 0]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

/** 轴对齐悬浮盒(12 三角;外向绕序,同 shadowRayGpuCases.boxBlas)。 */
function boxBlas(id: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): RayBlasDescriptor {
  const c = [[cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz + hz],
    [cx - hx, cy - hy, cz + hz], [cx - hx, cy + hy, cz - hz], [cx + hx, cy + hy, cz - hz],
    [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const vertices: number[] = [], indices: number[] = [];
  quads.forEach((quad, qi) => {
    const base = qi * 4;
    quad.forEach(cI => vertices.push(...c[cI]!));
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  });
  return { id, vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices) };
}

/** 斜靠墙面板(顶点已烘焙绕 z 轴 18° 旋转;平移至墙左前方,提供非零深度梯度)。 */
function leanPanelBlas(): RayBlasDescriptor {
  const angle = 18 * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const corners: Array<[number, number]> = [[-1.6, 0], [1.6, 0], [1.6, 2.6], [-1.6, 2.6]];
  const vertices: number[] = [];
  for (const [x, y] of corners) {
    vertices.push(x * cos - y * sin - 2.6, x * sin + y * cos + 0.05, 0.06);
  }
  return { id: "reflection-lean-panel", vertices: Float32Array.from(vertices),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

export interface ReflectionScene {
  readonly blasList: readonly RayBlasDescriptor[];
  readonly instances: readonly TlasInstanceDescriptor[];
  readonly tlas: IncrementalTlasScene;
}

/** 构建探针场景(SAH BLAS + 增量 TLAS;f16 档独立构建同一实例集,语义等价)。 */
export function buildReflectionScene(f16 = false): ReflectionScene {
  const blasList = [wallBlas(), boxBlas("reflection-mirror-box", -1.5, 1.6, 2.0, 0.7, 0.7, 0.35), leanPanelBlas()];
  const instances = blasList.map((blas, index) => ({
    id: blas.id, blas, worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const, mask: 1 << index,
  }));
  const tlas = new IncrementalTlasScene(blasList, { ...(f16 ? { f16: true } : {}), sah: { binCount: 8 } });
  tlas.updateInstances(instances);
  return { blasList, instances, tlas };
}

export interface ReflectionRecordParity {
  /** CPU 参考记录([t, normal.xyz],miss=[-1,0,0,0];行主序 width×height)。 */
  readonly records: Float32Array;
  readonly hits: number;
  readonly misses: number;
}

/** CPU 侧逐像素语义镜像(与内核逐分支同序;depth 为 GPU 读回的同一 f32 行主序数组)。 */
export function referenceReflectionRecords(scene: ReflectionScene, depth: Float32Array, width: number,
  height: number, invViewProjection: readonly number[], eye: readonly [number, number, number],
  tMax = REFLECTION_T_MAX, bias = REFLECTION_BIAS): ReflectionRecordParity {
  const tlas = buildTlas(scene.instances);
  const records = new Float32Array(width * height * 4);
  let hits = 0, misses = 0;
  const worldOf = (x: number, y: number, d: number): [number, number, number] => {
    const uvX = (x + 0.5) / width, uvY = (y + 0.5) / height;
    const ndc = [uvX * 2 - 1, 1 - uvY * 2, d, 1];
    const w = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) w[row]! += invViewProjection[k * 4 + row]! * ndc[k]!;
    }
    return [w[0]! / w[3]!, w[1]! / w[3]!, w[2]! / w[3]!];
  };
  const depthAt = (x: number, y: number): number => depth[y * width + x]!;
  const miss = (base: number): void => {
    records[base] = -1; records[base + 1] = 0; records[base + 2] = 0; records[base + 3] = 0;
    misses++;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 4;
      const d = depthAt(x, y);
      if (d >= 1) { miss(base); continue; }
      if (x + 1 >= width || y + 1 >= height || depthAt(x + 1, y) >= 1 || depthAt(x, y + 1) >= 1) { miss(base); continue; }
      const world = worldOf(x, y, d);
      const worldRight = worldOf(x + 1, y, depthAt(x + 1, y)!); // 上行已守卫 <1 且在界内。
      const worldDown = worldOf(x, y + 1, depthAt(x, y + 1)!);
      const e1 = [worldRight[0] - world[0], worldRight[1] - world[1], worldRight[2] - world[2]];
      const e2 = [worldDown[0] - world[0], worldDown[1] - world[1], worldDown[2] - world[2]];
      let n: [number, number, number] = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const nLen = Math.hypot(n[0], n[1], n[2]);
      if (!(nLen > 0)) { miss(base); continue; }
      n = [n[0]! / nLen, n[1]! / nLen, n[2]! / nLen];
      // 朝向相机定向先行(与内核逐分支同序;叉积手性随视角翻转)。
      if (n[0]! * (eye[0] - world[0]) + n[1]! * (eye[1] - world[1]) + n[2]! * (eye[2] - world[2]) < 0) {
        n = [-n[0]!, -n[1]!, -n[2]!];
      }
      let incident = [world[0] - eye[0], world[1] - eye[1], world[2] - eye[2]];
      const iLen = Math.hypot(incident[0]!, incident[1]!, incident[2]!);
      if (!(iLen > 0)) { miss(base); continue; }
      incident = [incident[0]! / iLen, incident[1]! / iLen, incident[2]! / iLen];
      if (incident[0]! * n[0]! + incident[1]! * n[1]! + incident[2]! * n[2]! >= -1e-4) { miss(base); continue; }
      const dot2 = 2 * (incident[0]! * n[0]! + incident[1]! * n[1]! + incident[2]! * n[2]!);
      const r = [incident[0]! - dot2 * n[0]!, incident[1]! - dot2 * n[1]!, incident[2]! - dot2 * n[2]!];
      const origin = [world[0] + r[0]! * bias, world[1] + r[1]! * bias, world[2] + r[2]! * bias];
      const hit = traceTlasClosest(tlas, { ox: origin[0]!, oy: origin[1]!, oz: origin[2]!,
        dx: r[0]!, dy: r[1]!, dz: r[2]!, tMax }, 0xff);
      if (hit === undefined) { miss(base); continue; }
      const worldNormal = hitNormalWorld(scene, hit.instanceId, hit.primitiveIndex, [r[0]!, r[1]!, r[2]!]);
      records[base] = hit.t; records[base + 1] = worldNormal[0];
      records[base + 2] = worldNormal[1]; records[base + 3] = worldNormal[2];
      hits++;
    }
  }
  return { records, hits, misses };
}

/** 命中三角几何法线(局部 → M⁻ᵀ 到世界 → 归一化 → 朝向射线定向;BLAS 内 primIndex)。 */
export function hitNormalWorld(scene: ReflectionScene, instanceId: string, primitiveIndex: number,
  dir: readonly [number, number, number]): readonly [number, number, number] {
  const instance = scene.instances.find((candidate) => candidate.id === instanceId)!;
  const indices = instance.blas.indices, vertices = instance.blas.vertices;
  const a = primitiveIndex * 3;
  const v0 = [vertices[indices[a]! * 3]!, vertices[indices[a]! * 3 + 1]!, vertices[indices[a]! * 3 + 2]!];
  const v1 = [vertices[indices[a + 1]! * 3]!, vertices[indices[a + 1]! * 3 + 1]!, vertices[indices[a + 1]! * 3 + 2]!];
  const v2 = [vertices[indices[a + 2]! * 3]!, vertices[indices[a + 2]! * 3 + 1]!, vertices[indices[a + 2]! * 3 + 2]!];
  const e1 = [v1[0]! - v0[0]!, v1[1]! - v0[1]!, v1[2]! - v0[2]!];
  const e2 = [v2[0]! - v0[0]!, v2[1]! - v0[1]!, v2[2]! - v0[2]!];
  let n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
  // 与 BVH_INTERSECT_NORMAL 同语义:dot(n, dir) > 0 翻转(局部空间定向)。
  if (n[0]! * dir[0] + n[1]! * dir[1] + n[2]! * dir[2] > 0) { n = [-n[0]!, -n[1]!, -n[2]!]; }
  // 法线世界变换 = (worldToLocal 3×3)⁻ᵀ;L=invertAffine3x4 的线性部分行主序取转置乘。
  const localToWorld = invertAffine3x4(instance.worldToLocal);
  let world: [number, number, number] = [
    localToWorld[0]! * n[0]! + localToWorld[4]! * n[1]! + localToWorld[8]! * n[2]!,
    localToWorld[1]! * n[0]! + localToWorld[5]! * n[1]! + localToWorld[9]! * n[2]!,
    localToWorld[2]! * n[0]! + localToWorld[6]! * n[1]! + localToWorld[10]! * n[2]!];
  const len = Math.hypot(world[0], world[1], world[2]);
  if (!(len > 0)) return [0, 0, 1] as const; // 退化不应发生(命中即有非零几何法线);保守给 +z。
  world = [world[0]! / len, world[1]! / len, world[2]! / len];
  if (world[0]! * dir[0] + world[1]! * dir[1] + world[2]! * dir[2] > 0) {
    world = [-world[0]!, -world[1]!, -world[2]!];
  }
  return [world[0], world[1], world[2]] as const;
}
