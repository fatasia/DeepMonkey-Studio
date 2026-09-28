/**
 * T13 地形底座:块缓存、确定性版本号与增量失效。
 *
 * 失效语义(T13 验收"局部修改不重建全域"):
 * - getChunk 惰性构建并缓存;缓存命中返回同一对象引用(引用不变即未重建的证据);
 * - updateParameters:全局参数(seed/振幅/频率等)在数学上影响全域,清空缓存并
 *   重建"此前已缓存"的块;未缓存块在下次 getChunk 时按新参数惰性构建;
 * - updateRegions:只重建被旧/新平整区影响盒覆盖的块(影响盒 = 圆盘 + 过渡带
 *   + 一格法线差分外延),范围外块缓存原样保留,几何逐位不变;
 * - generationVersion 由 algorithmVersion + 全部参数 + regions 顺序派生,
 *   同输入必同版本,任何影响输出的修改都会改变版本。
 */

import {
  buildTerrainChunkGeometry,
  chunkOrigin,
  createTerrainHeightSampler,
  TERRAIN_ALGORITHM_VERSION,
  validateFlattenRegions,
  validateTerrainParameters,
  type TerrainChunkGeometry,
  type TerrainFieldParameters,
  type TerrainFlattenRegion,
} from "./terrainHeightfield.js";

export interface TerrainFieldStats {
  cachedChunkCount: number;
  rebuildCount: number;
  /** 最近一次失效操作实际重建的块键(稳定格式 "cx,cz",按字典序)。 */
  lastRebuiltKeys: readonly string[];
}

const GLOBAL_FIELDS: readonly (keyof TerrainFieldParameters)[] = [
  "seed", "chunkSize", "cellSize", "amplitude", "frequency", "octaves",
];

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

/** 平整区的影响盒(世界坐标,含过渡带与一格法线外延)。 */
function regionInfluenceBox(region: TerrainFlattenRegion, normalExtension: number) {
  const reach = region.radiusM + region.transitionM + normalExtension;
  return {
    minX: region.centerX - reach,
    maxX: region.centerX + reach,
    minZ: region.centerZ - reach,
    maxZ: region.centerZ + reach,
  };
}

/** FNV-1a 32 位哈希,用于确定性版本号派生(非加密)。 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class TerrainField {
  private readonly chunks = new Map<string, TerrainChunkGeometry>();
  private currentParameters: TerrainFieldParameters;
  private currentRegions: readonly TerrainFlattenRegion[];
  private sampler: (x: number, z: number) => number;
  private rebuildCount = 0;
  private lastRebuiltKeys: readonly string[] = [];

  constructor(parameters: TerrainFieldParameters, regions: readonly TerrainFlattenRegion[] = []) {
    validateTerrainParameters(parameters);
    validateFlattenRegions(regions);
    this.currentParameters = { ...parameters };
    this.currentRegions = regions.map((region) => ({ ...region }));
    this.sampler = createTerrainHeightSampler(this.currentParameters, this.currentRegions);
  }

  get parameters(): TerrainFieldParameters {
    return { ...this.currentParameters };
  }

  get regions(): readonly TerrainFlattenRegion[] {
    return this.currentRegions.map((region) => ({ ...region }));
  }

  get stats(): TerrainFieldStats {
    return {
      cachedChunkCount: this.chunks.size,
      rebuildCount: this.rebuildCount,
      lastRebuiltKeys: this.lastRebuiltKeys,
    };
  }

  /** 确定性代次:algorithmVersion + 参数 + regions(顺序敏感)→ 稳定哈希。 */
  get generationVersion(): string {
    const p = this.currentParameters;
    const text = [
      p.algorithmVersion, p.seed, p.chunkSize, p.cellSize, p.amplitude, p.frequency, p.octaves,
      ...this.currentRegions.flatMap((r) => [r.centerX, r.centerZ, r.radiusM, r.heightM, r.transitionM]),
    ].join("|");
    return fnv1a(text);
  }

  sampleHeight(x: number, z: number): number {
    return this.sampler(x, z);
  }

  /** 取块(惰性构建);缓存命中返回同一对象引用。 */
  getChunk(chunkX: number, chunkZ: number): TerrainChunkGeometry {
    const key = chunkKey(chunkX, chunkZ);
    const cached = this.chunks.get(key);
    if (cached) return cached;
    const built = buildTerrainChunkGeometry(this.currentParameters, this.sampler, chunkX, chunkZ);
    this.chunks.set(key, built);
    return built;
  }

  /** 确保块范围 [minX..maxX]×[minZ..maxZ](含端点)已构建,返回按行主序的块数组。 */
  ensureChunkRange(minX: number, minZ: number, maxX: number, maxZ: number): TerrainChunkGeometry[] {
    const result: TerrainChunkGeometry[] = [];
    for (let cz = minZ; cz <= maxZ; cz += 1) {
      for (let cx = minX; cx <= maxX; cx += 1) {
        result.push(this.getChunk(cx, cz));
      }
    }
    return result;
  }

  /**
   * 更新全局参数。任何字段变化都使全域失效(数学上全局参数影响所有采样点),
   * 仅重建此前已缓存的块;返回重建键列表。
   */
  updateParameters(next: Partial<TerrainFieldParameters>): readonly string[] {
    if (next.algorithmVersion !== undefined && next.algorithmVersion !== this.currentParameters.algorithmVersion) {
      // 算法版本变更属于新算法合同,必须通过重建 TerrainField 声明,禁止原地热改。
      throw new Error("algorithmVersion must not be patched via updateParameters.");
    }
    const merged: TerrainFieldParameters = { ...this.currentParameters, ...next };
    validateTerrainParameters(merged);
    let changed = false;
    for (const field of GLOBAL_FIELDS) {
      if (merged[field] !== this.currentParameters[field]) changed = true;
    }
    if (!changed) {
      this.lastRebuiltKeys = [];
      return this.lastRebuiltKeys;
    }
    this.currentParameters = merged;
    this.sampler = createTerrainHeightSampler(this.currentParameters, this.currentRegions);
    return this.invalidateAll();
  }

  /**
   * 全量替换平整区。仅重建被旧/新影响盒覆盖的块;未受影响块的缓存引用
   * 与几何保持逐位不变。返回重建键列表。
   */
  updateRegions(next: readonly TerrainFlattenRegion[]): readonly string[] {
    validateFlattenRegions(next);
    const affected = new Set<string>();
    for (const set of [this.currentRegions, next]) {
      for (const region of set) {
        for (const key of this.chunkKeysInInfluenceBox(region)) affected.add(key);
      }
    }
    this.currentRegions = next.map((region) => ({ ...region }));
    this.sampler = createTerrainHeightSampler(this.currentParameters, this.currentRegions);
    return this.rebuildKeys(affected);
  }

  /** 全域失效:清缓存并重建已缓存块(用于全局参数变化)。 */
  private invalidateAll(): string[] {
    return this.rebuildKeys(new Set(this.chunks.keys()));
  }

  private rebuildKeys(keys: ReadonlySet<string>): string[] {
    const rebuilt: string[] = [];
    for (const key of keys) {
      const parsed = key.split(",");
      const chunkX = Number(parsed[0]);
      const chunkZ = Number(parsed[1]);
      const built = buildTerrainChunkGeometry(this.currentParameters, this.sampler, chunkX, chunkZ);
      this.chunks.set(key, built);
      rebuilt.push(key);
    }
    rebuilt.sort();
    this.rebuildCount += rebuilt.length;
    this.lastRebuiltKeys = rebuilt;
    return rebuilt;
  }

  /** 计算平整区影响盒覆盖的"已缓存块"键;扩展一格以覆盖邻块共享边界的法线采样。 */
  private chunkKeysInInfluenceBox(region: TerrainFlattenRegion): string[] {
    const normalExtension = this.currentParameters.cellSize;
    const box = regionInfluenceBox(region, normalExtension);
    const extent = this.currentParameters.chunkSize * this.currentParameters.cellSize;
    const keys: string[] = [];
    for (const key of this.chunks.keys()) {
      const parsed = key.split(",");
      const { x, z } = chunkOrigin(this.currentParameters, Number(parsed[0]), Number(parsed[1]));
      const overlaps = x <= box.maxX && x + extent >= box.minX && z <= box.maxZ && z + extent >= box.minZ;
      if (overlaps) keys.push(key);
    }
    return keys;
  }
}

/** 导出 T13 当前算法版本,供调用方写入确定性合同。 */
export const TERRAIN_FIELD_ALGORITHM_VERSION = TERRAIN_ALGORITHM_VERSION;
