/**
 * 世界分区 → chunk 流送桥（波次4 前奏）：把世界单元流送计划翻译成 residency 域的
 * chunk 键集合合同。纯函数、确定性；真实 residency 挂载（AuthorChunkStream/
 * SceneChunkResidency.update 的 desired set）由接线切片消费本模块输出。
 * 键约定：世界单元 chunk 的 key 形如 `world|<cx>|<cz>|<lod>`——`world|` 前缀保证与
 * 作者场景 chunk 键空间永不冲突（authorChunkStream 以场景几何 id 命名）。
 */

import { worldCellCenter, worldCellKey, worldStreamingPlan, WORLD_CELL_LOD_COUNT,
  type WorldCellId, type WorldStreamingInput } from "./worldPartition.js";

export interface WorldChunkDemand {
  readonly key: string;
  readonly cell: WorldCellId;
  readonly lod: number;
  /** 0..1，越小越紧迫（与 worldStreamingPriority 同序归一）。 */
  readonly urgency: number;
  readonly center: readonly [number, number, number];
}

export interface WorldChunkBridgeOptions {
  /** 同时处于期望集的单元数上限（含各 LOD 层）。 */
  readonly maxCells?: number;
  /** 期望集中保留的 LOD 层数（0 = 仅最细层）。默认全部。 */
  readonly maxLod?: number;
}

const DEFAULT_MAX_CELLS = 64;

/** 相机流送输入 → 有序 chunk 期望集（紧迫度升序；同紧迫度 key 字典序）。 */
export function planWorldChunkDemand(input: WorldStreamingInput, radius: number,
  options: WorldChunkBridgeOptions = {}): readonly WorldChunkDemand[] {
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1) throw new RangeError("maxCells must be a positive integer.");
  const maxLod = options.maxLod ?? WORLD_CELL_LOD_COUNT;
  if (!Number.isSafeInteger(maxLod) || maxLod < 1 || maxLod > WORLD_CELL_LOD_COUNT) {
    throw new RangeError(`maxLod must be an integer in [1,${WORLD_CELL_LOD_COUNT}].`);
  }
  const plan = worldStreamingPlan(input, radius).slice(0, maxCells);
  // 紧迫度按流送优先级秩次归一到 0..1（秩 0 = 最优先，即相机单元），与
  // worldStreamingPriority 严格同序；同一单元各 LOD 共享同一紧迫度。
  // 秩次归一对任意半径/maxCells 组合都确定且有界，供消费方做 visible/prefetch 分档。
  const rankDenominator = Math.max(1, plan.length - 1);
  const cells: WorldChunkDemand[] = [];
  for (let index = 0; index < plan.length; index++) {
    const cell = plan[index]!;
    const urgency = index / rankDenominator;
    const center2d = worldCellCenter(cell);
    for (let lod = 0; lod < maxLod; lod++) {
      cells.push({ key: worldChunkKey(cell, lod), cell, lod, urgency,
        center: [center2d.x, 0, center2d.z] });
    }
  }
  return cells;
}

export function worldChunkKey(cell: WorldCellId, lod: number): string {
  return `world|${worldCellKey(cell)}|lod${lod}`;
}

/** 键解析：非 world| 前缀返回 undefined（作者 chunk 键不受影响）。 */
export function parseWorldChunkKey(key: string): { cell: WorldCellId; lod: number } | undefined {
  const parts = key.split("|");
  if (parts.length !== 4 || parts[0] !== "world") return undefined;
  const cx = Number(parts[1]!), cz = Number(parts[2]!);
  const lodMatch = /^lod(\d+)$/.exec(parts[3]!);
  if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz) || !lodMatch) return undefined;
  const lod = Number(lodMatch[1]);
  if (!Number.isSafeInteger(lod) || lod < 0 || lod >= WORLD_CELL_LOD_COUNT) return undefined;
  return { cell: { cx, cz }, lod };
}
