/**
 * Brief-GI M3:烘焙计划辅助(自 sdfGiProductionRuntime.encodeBake 提取,守 300 行体量门)。
 * 纯 CPU、确定性 —— cellSize 规模墙重试与探针 lattice 边界(内缩半格)的单一实现点,
 * CPU 烘焙与 GPU 烘焙两条路共用(探针消费物化的格几何同源)。
 *
 * 烘焙哈希缓存(2026-10-06 后继切片,关闭登记「烘焙哈希缓存子集缺」):场景静态内容
 * SHA-256(`sdfGiBakeContentHash`)与上次烘焙一致 → 生产 runtime 跳过整次烘焙复用
 * 旧静态层;另把逐资产增量缓存(`SdfSceneBakeCache`)透传给 CPU 回退路(此前恒不传,
 * 报告 cachedCount 恒 0)。哈希域前缀隔离其它 SHA-256 消费合同。
 */
import { bakeSdfSceneGrid, createSdfSceneBakeCache, type SdfSceneBakeCache,
  type SdfSceneBakeInstance, type SdfSceneBakeReport } from "./sdfSceneBake.js";
import { instanceMaxExtent } from "./sdfGiSceneAdapter.js";
import { sha256Bytes } from "../shaderPackage/hash.js";

export interface SdfGiBakePlanOptions {
  readonly cellSize?: number;
  readonly instanceDomain?: "aabb" | "scene";
  /** 逐资产增量缓存(跨烘焙携带;命中资产不重烘,报告逐条 cached)。 */
  readonly cache?: SdfSceneBakeCache;
}

export interface SdfGiBakePlan {
  readonly bake: ReturnType<typeof bakeSdfSceneGrid>;
  readonly cellSize: number;
}

/** 场景 dirty 烘焙:cells 超规模墙时确定性倍增 cellSize 重试(六次仍超 fail-visible 上抛)。 */
export function bakeSdfSceneWithRetries(instances: readonly SdfSceneBakeInstance[],
  options: SdfGiBakePlanOptions): SdfGiBakePlan {
  const domain = options.instanceDomain ?? "aabb";
  const maxExtent = instanceMaxExtent(instances);
  let cellSize = clampFinite(options.cellSize, 0.05, 1, clampFinite(maxExtent / 64, 0.05, 1, 0.25));
  let bake: ReturnType<typeof bakeSdfSceneGrid> | undefined;
  const bakeOptions = { cellSize, instanceDomain: domain,
    ...(options.cache ? { cache: options.cache } : {}) };
  try {
    bake = bakeSdfSceneGrid(instances, bakeOptions);
  } catch (error) {
    let lastError: unknown = error;
    for (let attempt = 0; attempt < 6 && bake === undefined; attempt++) {
      cellSize = Math.min(cellSize * 2, 8);
      try {
        bake = bakeSdfSceneGrid(instances, { ...bakeOptions, cellSize });
      } catch (retryError) { lastError = retryError; }
    }
    if (!bake) throw lastError;
  }
  return { bake, cellSize };
}

/**
 * 探针 lattice 采样域:SDF 网格边界内缩半格(贴面探针 SDF=0 → 全向假遮蔽;
 * sdfGiProductionRuntime 合同原文,提取后供烘焙计划与消费发布共用)。
 */
export function probeLatticeBounds(grid: { origin: readonly [number, number, number];
  cellSize: number; dimensions: readonly [number, number, number] }):
  { readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number] } {
  const inset = Math.max(grid.cellSize * 0.5, 1e-3);
  return {
    min: [grid.origin[0]! + inset, grid.origin[1]! + inset, grid.origin[2]! + inset] as const,
    max: [grid.origin[0]! + (grid.dimensions[0]! - 1) * grid.cellSize - inset,
      grid.origin[1]! + (grid.dimensions[1]! - 1) * grid.cellSize - inset,
      grid.origin[2]! + (grid.dimensions[2]! - 1) * grid.cellSize - inset] as const,
  };
}

/** lattice 推导参数(确定性解析与上限同 sdfGiProductionRuntime 既有合同)。 */
export function resolveProbeSpacing(grid: { cellSize: number },
  options: { probeSpacing?: number }): number {
  return options.probeSpacing ?? Math.max(grid.cellSize * 4, 0.25);
}

/** 烘焙 cellSize 解析(GPU/CPU 两条路共用的确定性基准:场景最长边/64,钳 [0.05,1])。 */
export function resolveSdfGiBakeCellSize(instances: readonly SdfSceneBakeInstance[],
  cellSize: number | undefined): number {
  const maxExtent = instanceMaxExtent(instances);
  return clampFinite(cellSize, 0.05, 1, clampFinite(maxExtent / 64, 0.05, 1, 0.25));
}

function clampFinite(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 烘焙报告的类型再导出(runtime 帧合同用;单一来源)。 */
export type { SdfSceneBakeReport };

/** 烘焙哈希缓存逐资产条目上限(内存安全阀;FIFO 淘汰,确定性)。 */
export const SDF_GI_BAKE_CACHE_MAX_ENTRIES = 2048;

/** 烘焙内容哈希域前缀(隔离其它 SHA-256 消费合同,同 runtimePackage canonical 先例)。 */
const SDF_GI_BAKE_HASH_DOMAIN = "deep-engine.sdf-gi.bake.content.v1\n";
const IDENTITY_BASIS_HASH: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const textEncoder = new TextEncoder();

/** 逐资产烘焙内容哈希:覆盖烘焙输入全量 —— 实例序 × (id + 顶点 + 索引 + 变换)
 * + cellSize + 域覆盖。任一变化即哈希不同;同输入逐位同哈希(确定性)。
 * 字节序 = 平机原生(与 clothParallelSolver.fingerprintFloat32 哈希 float 位同先例,
 * 跨机一致性不作承诺;哈希只在本进程内与上次烘焙对比)。 */
export function sdfGiBakeContentHash(instances: readonly SdfSceneBakeInstance[],
  cellSize: number, instanceDomain: "aabb" | "scene"): string {
  const tag = textEncoder.encode(SDF_GI_BAKE_HASH_DOMAIN);
  const ids = instances.map(instance => textEncoder.encode(instance.id));
  let byteLength = tag.length + 4 + 8 + 1;
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    byteLength += 4 + ids[index]!.length + typedByteLength(instance.mesh.positions)
      + 4 + typedByteLength(instance.mesh.indices) + 12 * 4;
  }
  const stream = new Uint8Array(byteLength);
  const view = new DataView(stream.buffer);
  let cursor = 0;
  stream.set(tag, cursor); cursor += tag.length;
  view.setUint32(cursor, instances.length, true); cursor += 4;
  for (let index = 0; index < instances.length; index++) {
    const instance = instances[index]!;
    view.setUint32(cursor, ids[index]!.length, true); cursor += 4;
    stream.set(ids[index]!, cursor); cursor += ids[index]!.length;
    stream.set(typedBytes(instance.mesh.positions), cursor);
    cursor += typedByteLength(instance.mesh.positions);
    view.setUint32(cursor, instance.mesh.indices.length, true); cursor += 4;
    stream.set(typedBytes(instance.mesh.indices), cursor);
    cursor += typedByteLength(instance.mesh.indices);
    const basis = instance.transform?.basis;
    const translation = instance.transform?.translation;
    for (let lane = 0; lane < 9; lane++) {
      view.setFloat32(cursor, basis?.[lane] ?? IDENTITY_BASIS_HASH[lane]!, true);
      cursor += 4;
    }
    for (let lane = 0; lane < 3; lane++) {
      view.setFloat32(cursor, translation?.[lane] ?? 0, true); cursor += 4;
    }
  }
  view.setFloat64(cursor, cellSize, true); cursor += 8;
  stream[cursor] = instanceDomain === "scene" ? 1 : 0;
  return sha256Bytes(stream);
}

/** 烘焙缓存条目上限裁剪(FIFO;Map 插入序即最旧优先,确定性)。 */
export function pruneSdfGiBakeCache(cache: SdfSceneBakeCache,
  maxEntries = SDF_GI_BAKE_CACHE_MAX_ENTRIES): void {
  const entries = cache.entries;
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

function typedBytes(typed: Float32Array | Uint32Array): Uint8Array {
  return new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
}

function typedByteLength(typed: Float32Array | Uint32Array): number {
  return typed.byteLength;
}
