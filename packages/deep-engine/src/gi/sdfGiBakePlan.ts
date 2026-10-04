/**
 * Brief-GI M3:烘焙计划辅助(自 sdfGiProductionRuntime.encodeBake 提取,守 300 行体量门)。
 * 纯 CPU、确定性 —— cellSize 规模墙重试与探针 lattice 边界(内缩半格)的单一实现点,
 * CPU 烘焙与 GPU 烘焙两条路共用(探针消费物化的格几何同源)。
 */
import { bakeSdfSceneGrid, type SdfSceneBakeInstance, type SdfSceneBakeReport } from "./sdfSceneBake.js";
import { instanceMaxExtent } from "./sdfGiSceneAdapter.js";

export interface SdfGiBakePlanOptions {
  readonly cellSize?: number;
  readonly instanceDomain?: "aabb" | "scene";
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
  try {
    bake = bakeSdfSceneGrid(instances, { cellSize, instanceDomain: domain });
  } catch (error) {
    let lastError: unknown = error;
    for (let attempt = 0; attempt < 6 && bake === undefined; attempt++) {
      cellSize = Math.min(cellSize * 2, 8);
      try {
        bake = bakeSdfSceneGrid(instances, { cellSize, instanceDomain: domain });
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
