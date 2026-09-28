/**
 * T26 代理误差度量(Hausdorff 式有向距离 + 体积口径,报告级)。
 *
 * 诚实边界:这是**有界采样**的近似度量——
 * - 实例→代理:实例盒表面固定采样点(8 角 + 6 面心)到代理盒集实体的最小距离取最大;
 *   度量"原始几何伸出代理多少"(欠覆盖)。
 * - 代理→实例:代理盒表面采样点(8 角 + 质心)到实例盒集实体的最小距离取最大;
 *   度量"代理填隙超出原始几何多少"(过覆盖)。
 * - 体积:Σ盒体积(代理盒可重叠 → 上界口径)/ Σ实例盒体积。
 * 采样按规范序 stride 选取、求值预算超限按比例收缩——同输入逐位同结果。
 * 不宣称视觉等价、不宣称严格 Hausdorff 界(未采样的表面不在度量内)。
 */

import {
  type HlodInstanceShape,
  type HlodProxyConfiguration,
  type HlodProxyErrorMetrics,
  type HlodProxyMesh,
} from "./hlodProxyTypes.js";
import { compareShape } from "./hlodProxyGeometry.js";

type Vec3 = readonly [number, number, number];

const INSTANCE_SAMPLES_PER_SHAPE = 14; // 8 角 + 6 面心
const PROXY_SAMPLES_PER_BOX = 9; // 8 角 + 质心

/**
 * 从发射网格反提代理盒(逐盒 24 顶点取 min/max):度量针对**实际输出几何**
 * (Float32 舍入后),不是构造期 f64 盒——诚实口径。
 */
export function boxesFromProxyMesh(mesh: HlodProxyMesh): readonly {
  readonly min: Vec3; readonly max: Vec3;
}[] {
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  for (let box = 0; box < mesh.boxCount; box++) {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let vertex = 0; vertex < 24; vertex++) {
      const offset = (box * 24 + vertex) * 6;
      for (let axis = 0; axis < 3; axis++) {
        const value = mesh.vertices[offset + axis]!;
        min[axis] = Math.min(min[axis]!, value);
        max[axis] = Math.max(max[axis]!, value);
      }
    }
    boxes.push({ min, max });
  }
  return boxes;
}

/** 点到盒实体的距离(盒内/盒面 = 0;闭式,逐分量钳制)。 */
export function distancePointToBox(point: Vec3, min: Vec3, max: Vec3): number {
  const dx = Math.max(min[0] - point[0], point[0] - max[0], 0);
  const dy = Math.max(min[1] - point[1], point[1] - max[1], 0);
  const dz = Math.max(min[2] - point[2], point[2] - max[2], 0);
  return Math.hypot(dx, dy, dz);
}

/**
 * 双向有向度量。`shapes` 以 instanceId 规范序参与(与输入顺序无关);
 * 实例侧采样量受 metricInstanceSampleLimit 与 metricEvalBudget 双重上限约束。
 */
export function measureHlodProxyError(shapes: readonly HlodInstanceShape[], mesh: HlodProxyMesh,
  config: HlodProxyConfiguration): HlodProxyErrorMetrics {
  const proxyBoxes = boxesFromProxyMesh(mesh);
  const ordered = [...shapes].sort(compareShape);
  const instanceSampleCount = Math.max(1, Math.min(ordered.length, config.metricInstanceSampleLimit,
    Math.floor(config.metricEvalBudget / (INSTANCE_SAMPLES_PER_SHAPE * Math.max(1, proxyBoxes.length)))));
  const proxyBoxSampleCount = Math.max(1, Math.min(proxyBoxes.length,
    Math.floor(config.metricEvalBudget / (PROXY_SAMPLES_PER_BOX * Math.max(1, ordered.length)))));
  const proxyPointCount = proxyBoxSampleCount * PROXY_SAMPLES_PER_BOX;

  let instanceToProxyMax = 0;
  for (let sample = 0; sample < instanceSampleCount; sample++) {
    const shape = ordered[strideIndex(sample, instanceSampleCount, ordered.length)]!;
    for (const point of boxSurfaceSamples(shape.min, shape.max, false)) {
      let minDistance = Infinity;
      for (const box of proxyBoxes) {
        const distance = distancePointToBox(point, box.min, box.max);
        if (distance < minDistance) minDistance = distance;
        if (minDistance === 0) break;
      }
      if (minDistance > instanceToProxyMax) instanceToProxyMax = minDistance;
    }
  }

  let proxyToInstanceMax = 0;
  for (let sample = 0; sample < proxyBoxSampleCount; sample++) {
    const box = proxyBoxes[strideIndex(sample, proxyBoxSampleCount, proxyBoxes.length)]!;
    for (const point of boxSurfaceSamples(box.min, box.max, true)) {
      let minDistance = Infinity;
      for (const shape of ordered) {
        const distance = distancePointToBox(point, shape.min, shape.max);
        if (distance < minDistance) minDistance = distance;
        if (minDistance === 0) break;
      }
      if (minDistance > proxyToInstanceMax) proxyToInstanceMax = minDistance;
    }
  }

  let proxyBoxVolume = 0;
  let instanceBoxVolume = 0;
  for (const box of proxyBoxes) {
    proxyBoxVolume += (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
  }
  for (const shape of ordered) {
    instanceBoxVolume += (shape.max[0] - shape.min[0]) * (shape.max[1] - shape.min[1]) * (shape.max[2] - shape.min[2]);
  }
  const volumeRatioUpperBound = instanceBoxVolume === 0
    ? (proxyBoxVolume === 0 ? 0 : Infinity)
    : proxyBoxVolume / instanceBoxVolume;
  return Object.freeze({
    instanceToProxyMax,
    instanceSampleCount,
    proxyToInstanceMax,
    proxySampleCount: proxyPointCount,
    proxyBoxVolume,
    instanceBoxVolume,
    volumeRatioUpperBound,
  });
}

/** stride 选取:覆盖全集(头尾必含),采样数 < 全集时均匀跨步。 */
function strideIndex(sample: number, sampleCount: number, totalCount: number): number {
  return sampleCount >= totalCount ? sample : Math.floor(sample * totalCount / sampleCount);
}

/** 盒表面采样:8 角 + 6 面心(实例侧);或 8 角 + 质心(代理侧,标度无关的语义分组)。 */
function* boxSurfaceSamples(min: Vec3, max: Vec3, centerInsteadOfFaces: boolean): Generator<Vec3> {
  for (const [dx, dy, dz] of CORNER_SIGNS) {
    yield [dx ? max[0] : min[0], dy ? max[1] : min[1], dz ? max[2] : min[2]];
  }
  const mid = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5] as const;
  if (centerInsteadOfFaces) { yield mid; return; }
  yield [mid[0], mid[1], max[2]]; yield [mid[0], mid[1], min[2]];
  yield [mid[0], max[1], mid[2]]; yield [mid[0], min[1], mid[2]];
  yield [max[0], mid[1], mid[2]]; yield [min[0], mid[1], mid[2]];
}

const CORNER_SIGNS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1],
  [1, 0, 0], [1, 0, 1], [1, 1, 0], [1, 1, 1],
]);
