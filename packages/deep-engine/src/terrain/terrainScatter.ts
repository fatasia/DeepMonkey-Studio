/**
 * T13 植被/设施散布:seed 驱动的抖动网格实例散布(CPU 逻辑切片)。
 *
 * 确定性与局部失效:
 * - 每个候选点由 (全局 seed, 块坐标, 格点索引) 派生独立 PRNG 流,
 *   遍历顺序固定(块行主序 × 格点行主序),同输入逐位同输出;
 * - 随机流按块派生 ⇒ 某块参数/障碍变化只影响该块输出,其他块逐位不变;
 * - 输出复用 instanceTransform.packTransform(列主序 24 float 模型行 + 法线行),
 *   与引擎实例渲染 ABI 对齐,几何位置取自地形采样器(几何与碰撞位置一致的基础)。
 *
 * 本切片只产出 CPU 生成统计与变换数组;GPU 显存/可见数/帧时阶梯留后续联测。
 */

import { packTransform } from "../instanceTransform.js";
import { createMulberry32, hashGrid2D } from "./terrainRandom.js";
import type { TerrainField } from "./terrainField.js";

/** 散布参数;全部字段直接进入确定性合同。 */
export interface ScatterOptions {
  seed: number;
  /** 目标密度(实例/平方米);实际数量受避让与坡度过滤削减。 */
  densityPerSqm: number;
  /** 坡度上限(度,相对水平面);超过则该点被拒绝。 */
  maxSlopeDegrees: number;
  /** 坡度探针半距(米),中心差分步长。 */
  slopeProbeM: number;
  /** 障碍避让额外净距(米)。 */
  obstacleClearanceM: number;
  /** 实例最小/最大均匀缩放。 */
  scaleMin: number;
  scaleMax: number;
  /** 实例沿地形抬升量(米),例如盆栽根部埋深补偿。 */
  yOffsetM: number;
}

/** 圆柱近似障碍(设备、灯杆、建筑 footprint);散布点必须避开。 */
export interface ScatterObstacle {
  centerX: number;
  centerZ: number;
  radiusM: number;
}

export interface ScatterChunkSummary {
  chunkX: number;
  chunkZ: number;
  candidateCount: number;
  instanceCount: number;
  rejectedByObstacle: number;
  rejectedBySlope: number;
}

export interface ScatterResult {
  /** packTransform 布局:每实例 24 float(模型行 16 + 法线行 8)。 */
  transforms: Float32Array;
  instanceCount: number;
  transformsByteLength: number;
  chunkSummaries: readonly ScatterChunkSummary[];
  /** CPU 生成耗时(毫秒,performance.now 差)。GPU 阶梯另行联测。 */
  generationMs: number;
}

export const SCATTER_TRANSFORM_STRIDE = 24;

function validateScatterOptions(options: ScatterOptions): void {
  if (!Number.isFinite(options.seed)) throw new Error("Scatter seed must be finite.");
  if (!(options.densityPerSqm > 0)) throw new Error("Scatter densityPerSqm must be > 0.");
  if (!(options.maxSlopeDegrees >= 0) || options.maxSlopeDegrees >= 90) {
    throw new Error("Scatter maxSlopeDegrees must be in [0, 90).");
  }
  if (!(options.slopeProbeM > 0) || !(options.obstacleClearanceM >= 0)) {
    throw new Error("Scatter slopeProbeM must be > 0 and obstacleClearanceM >= 0.");
  }
  if (!(options.scaleMin > 0) || options.scaleMax < options.scaleMin) {
    throw new Error("Scatter requires scaleMin > 0 and scaleMax >= scaleMin.");
  }
}

interface PendingInstance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/**
 * 在地形场上按块范围散布实例。
 * 候选网格:每块独立等距网格,格距 = sqrt(1/density);格点抖动幅度为半格。
 */
export function scatterInstancesOnField(
  field: TerrainField,
  options: ScatterOptions,
  obstacles: readonly ScatterObstacle[],
  range: { minChunkX: number; minChunkZ: number; maxChunkX: number; maxChunkZ: number },
): ScatterResult {
  validateScatterOptions(options);
  const startedAt = performance.now();
  const parameters = field.parameters;
  const extent = parameters.chunkSize * parameters.cellSize;
  const gridCount = Math.max(1, Math.floor(extent * Math.sqrt(options.densityPerSqm)));
  const pitch = extent / gridCount;
  const slopeLimitTangent = Math.tan((options.maxSlopeDegrees * Math.PI) / 180);
  const summaries: ScatterChunkSummary[] = [];
  const pending: PendingInstance[] = [];

  for (let chunkZ = range.minChunkZ; chunkZ <= range.maxChunkZ; chunkZ += 1) {
    for (let chunkX = range.minChunkX; chunkX <= range.maxChunkX; chunkX += 1) {
      const origin = { x: chunkX * extent, z: chunkZ * extent };
      const summary: ScatterChunkSummary = {
        chunkX, chunkZ,
        candidateCount: gridCount * gridCount,
        instanceCount: 0,
        rejectedByObstacle: 0,
        rejectedBySlope: 0,
      };
      for (let j = 0; j < gridCount; j += 1) {
        for (let i = 0; i < gridCount; i += 1) {
          // 每格点独立随机流:块坐标盐派生块流,格点索引派生点流。
          const chunkSeed = hashGrid2D(chunkX, chunkZ, options.seed);
          const random = createMulberry32(hashGrid2D(i, j, chunkSeed));
          const x = origin.x + (i + 0.5) * pitch + (random() - 0.5) * pitch;
          const z = origin.z + (j + 0.5) * pitch + (random() - 0.5) * pitch;
          let rejected = false;
          for (let k = 0; k < obstacles.length; k += 1) {
            const obstacle = obstacles[k]!;
            const dx = x - obstacle.centerX;
            const dz = z - obstacle.centerZ;
            const clear = obstacle.radiusM + options.obstacleClearanceM;
            if (dx * dx + dz * dz < clear * clear) {
              summary.rejectedByObstacle += 1;
              rejected = true;
              break;
            }
          }
          if (rejected) continue;
          const probe = options.slopeProbeM;
          const dhx = (field.sampleHeight(x + probe, z) - field.sampleHeight(x - probe, z)) / (2 * probe);
          const dhz = (field.sampleHeight(x, z + probe) - field.sampleHeight(x, z - probe)) / (2 * probe);
          if (Math.sqrt(dhx * dhx + dhz * dhz) > slopeLimitTangent) {
            summary.rejectedBySlope += 1;
            continue;
          }
          const y = field.sampleHeight(x, z) + options.yOffsetM;
          const scale = options.scaleMin + (options.scaleMax - options.scaleMin) * random();
          const yaw = random() * Math.PI * 2;
          pending.push({ x, y, z, yaw, scale });
          summary.instanceCount += 1;
        }
      }
      summaries.push(summary);
    }
  }

  // 统一打包为 packTransform 布局;矩阵构造与打包全部为定点运算顺序。
  const transforms = new Float32Array(pending.length * SCATTER_TRANSFORM_STRIDE);
  const matrix = new Array<number>(16).fill(0);
  matrix[15] = 1;
  for (let index = 0; index < pending.length; index += 1) {
    const instance = pending[index]!;
    const cos = Math.cos(instance.yaw) * instance.scale;
    const sin = Math.sin(instance.yaw) * instance.scale;
    // 绕 Y 旋转(行主序 [cos,0,sin; 0,1,0; -sin,0,cos])按列主序展开。
    matrix[0] = cos; matrix[1] = 0; matrix[2] = -sin;
    matrix[4] = 0; matrix[5] = instance.scale; matrix[6] = 0;
    matrix[8] = sin; matrix[9] = 0; matrix[10] = cos;
    matrix[12] = instance.x; matrix[13] = instance.y; matrix[14] = instance.z;
    packTransform(matrix, transforms, index * SCATTER_TRANSFORM_STRIDE);
  }

  return {
    transforms,
    instanceCount: pending.length,
    transformsByteLength: transforms.byteLength,
    chunkSummaries: summaries,
    generationMs: performance.now() - startedAt,
  };
}
