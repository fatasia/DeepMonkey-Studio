/**
 * T13 地形底座:高度场参数、全局高度采样器与分块几何。
 *
 * 接缝无裂缝的几何级机制:
 * - 高度与法线都是"世界坐标的纯函数采样",块只决定采样窗口;
 * - 相邻块共享边界顶点使用相同 (x, z),对同一纯函数采样 → 高度与法线逐位一致;
 * - 法线采用中心差分直接对全局高度函数在 (x±e, z±e) 采样,不读邻块数据,
 *   因此块局部重建不需要触碰任何邻块几何。
 */

import { createFbm2D, smoothstep01 } from "./terrainRandom.js";

/** 高度场全局参数;algorithmVersion 进入确定性合同(改算法必须升版本)。 */
export interface TerrainFieldParameters {
  /** 确定性随机种子。 */
  seed: number;
  /** 每块格距数;块顶点数为 (chunkSize+1)^2,相邻块共享一条边界顶点行。 */
  chunkSize: number;
  /** 格距(米)。 */
  cellSize: number;
  /** fBm 高度振幅(米),输出高度范围为 [-amplitude, +amplitude]。 */
  amplitude: number;
  /** fBm 基频(1/米)。 */
  frequency: number;
  /** fBm 层数。 */
  octaves: number;
  /** 算法版本号;同版本 + 同输入保证逐位一致。 */
  algorithmVersion: string;
}

/** 厂区平整区:圆盘区域向目标高度混合,边缘带 transitionM 内平滑过渡。 */
export interface TerrainFlattenRegion {
  centerX: number;
  centerZ: number;
  radiusM: number;
  heightM: number;
  /** 边缘过渡带宽度(米);0 表示硬边(圆盘内完全取目标高度)。 */
  transitionM: number;
}

/** 单个地形块的 CPU 几何(行主序网格,索引为两三角/格)。 */
export interface TerrainChunkGeometry {
  chunkX: number;
  chunkZ: number;
  /** 本块原点世界坐标(格点 [0,0])。 */
  originX: number;
  originZ: number;
  /** xyz 交错,长度 = 3 * (chunkSize+1)^2。 */
  positions: Float32Array;
  /** xyz 单位法线,长度同 positions。 */
  normals: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export const TERRAIN_ALGORITHM_VERSION = "t13-heightfield-v1";

export function validateTerrainParameters(parameters: TerrainFieldParameters): void {
  if (!Number.isInteger(parameters.chunkSize) || parameters.chunkSize < 1 || parameters.chunkSize > 256) {
    throw new Error("Terrain chunkSize must be an integer in [1, 256].");
  }
  if (!(parameters.cellSize > 0) || !(parameters.amplitude >= 0) || !(parameters.frequency > 0)) {
    throw new Error("Terrain cellSize must be > 0, amplitude >= 0, frequency > 0.");
  }
  if (!Number.isInteger(parameters.octaves) || parameters.octaves < 1 || parameters.octaves > 16) {
    throw new Error("Terrain octaves must be an integer in [1, 16].");
  }
  if (!Number.isFinite(parameters.seed) || parameters.algorithmVersion.length === 0) {
    throw new Error("Terrain seed must be finite and algorithmVersion non-empty.");
  }
}

export function validateFlattenRegions(regions: readonly TerrainFlattenRegion[]): void {
  for (const region of regions) {
    if (!(region.radiusM > 0) || !(region.transitionM >= 0)) {
      throw new Error("Flatten region requires radiusM > 0 and transitionM >= 0.");
    }
    if (!Number.isFinite(region.centerX) || !Number.isFinite(region.centerZ) || !Number.isFinite(region.heightM)) {
      throw new Error("Flatten region coordinates must be finite.");
    }
  }
}

/**
 * 构建全局高度采样器:fBm 基面 + 平整区按数组顺序混合。
 * 返回 (x, z) => height(米);同输入逐位同输出,与分块无关。
 */
export function createTerrainHeightSampler(
  parameters: TerrainFieldParameters,
  regions: readonly TerrainFlattenRegion[],
): (x: number, z: number) => number {
  validateTerrainParameters(parameters);
  validateFlattenRegions(regions);
  const fbm = createFbm2D(parameters.seed, parameters.octaves);
  const freq = parameters.frequency;
  const amp = parameters.amplitude;
  return (x: number, z: number): number => {
    // 基面:把 fBm 的 [0,1] 映射到 [-amp, +amp],均值约为 0。
    let h = (fbm(x * freq, z * freq) - 0.5) * 2 * amp;
    for (let i = 0; i < regions.length; i += 1) {
      const region = regions[i]!;
      const dx = x - region.centerX;
      const dz = z - region.centerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= region.radiusM) continue;
      // 权重:圆盘内 1(transitionM=0 为硬边),过渡带 smoothstep 衰减。
      const weight = region.transitionM > 0
        ? 1 - smoothstep01(region.radiusM - region.transitionM, region.radiusM, dist)
        : 1;
      h = h * (1 - weight) + region.heightM * weight;
    }
    return h;
  };
}

/** 块索引 → 世界原点(格点 [0,0] 的世界坐标)。 */
export function chunkOrigin(parameters: TerrainFieldParameters, chunkX: number, chunkZ: number): { x: number; z: number } {
  const extent = parameters.chunkSize * parameters.cellSize;
  return { x: chunkX * extent, z: chunkZ * extent };
}

/**
 * 构建单个地形块的 CPU 几何。
 * 法线为中心差分(步长 = cellSize),对高度函数直接采样,不依赖邻块数据。
 */
export function buildTerrainChunkGeometry(
  parameters: TerrainFieldParameters,
  sampleHeight: (x: number, z: number) => number,
  chunkX: number,
  chunkZ: number,
): TerrainChunkGeometry {
  validateTerrainParameters(parameters);
  const size = parameters.chunkSize;
  const cell = parameters.cellSize;
  const { x: originX, z: originZ } = chunkOrigin(parameters, chunkX, chunkZ);
  const vertexCount = (size + 1) * (size + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const eps = cell;
  for (let j = 0; j <= size; j += 1) {
    for (let i = 0; i <= size; i += 1) {
      const x = originX + i * cell;
      const z = originZ + j * cell;
      const h = sampleHeight(x, z);
      const base = (j * (size + 1) + i) * 3;
      positions[base] = x;
      positions[base + 1] = h;
      positions[base + 2] = z;
      // 中心差分法线:n = normalize(h(x-e)-h(x+e), 2e, h(z-e)-h(z+e))。
      const nx = sampleHeight(x - eps, z) - sampleHeight(x + eps, z);
      const nz = sampleHeight(x, z - eps) - sampleHeight(x, z + eps);
      const ny = 2 * eps;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      normals[base] = nx / len;
      normals[base + 1] = ny / len;
      normals[base + 2] = nz / len;
    }
  }
  const indices = new Uint32Array(size * size * 6);
  let cursor = 0;
  for (let j = 0; j < size; j += 1) {
    for (let i = 0; i < size; i += 1) {
      const a = j * (size + 1) + i;
      const b = a + 1;
      const c = a + (size + 1);
      const d = c + 1;
      // 两个三角,从 +Y 往下看保持逆时针绕序(法线朝上)。
      indices[cursor] = a; indices[cursor + 1] = c; indices[cursor + 2] = b;
      indices[cursor + 3] = b; indices[cursor + 4] = c; indices[cursor + 5] = d;
      cursor += 6;
    }
  }
  return {
    chunkX,
    chunkZ,
    originX,
    originZ,
    positions,
    normals,
    indices,
    vertexCount,
    indexCount: indices.length,
  };
}
