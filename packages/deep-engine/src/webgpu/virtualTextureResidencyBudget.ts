import type { VirtualTextureBudget } from "../virtualTextures/virtualTexturePageTable.js";
import type { VirtualTextureTileSpec } from "../virtualTextures/virtualTexturePages.js";

/**
 * F3 虚拟纹理驻留预算与遥测合同(纯逻辑,可单测)。
 *
 * 双口径硬预算由同一数字推导:逻辑驻留(页表 residentBytes)与 GPU atlas
 * (atlasLayers × tileEdge² × bytesPerTexel)都 ≤ maxResidentBytes——
 * atlasLayers 作为页表 maxPages 硬顶,保证"每个在表页必有槽位"。
 */

export interface VirtualTextureResidencyBudget {
  /** 逻辑驻留与 GPU atlas 的共同硬预算(字节)。 */
  readonly maxResidentBytes: number;
  /** 显式页数上限;缺省由 maxResidentBytes / 每层字节 向上取整推导(钳到设备上限)。 */
  readonly maxPages?: number;
  /** 单帧最大上传页数;缺省 16。 */
  readonly maxUploadPagesPerFrame?: number;
  /** 驻留保护帧数(防抖 dwell);透传页表。 */
  readonly minResidentFrames?: number;
}

export interface VirtualTextureResidencyTelemetry {
  readonly frame: number;
  /** 页表逻辑驻留字节(≤ maxResidentBytes)。 */
  readonly residentBytes: number;
  readonly residentPages: number;
  readonly atlasLayers: number;
  /** GPU atlas 字节(= atlasLayers × tileEdge² × bytesPerTexel,≤ maxResidentBytes)。 */
  readonly atlasBytes: number;
  readonly uploadsQueued: number;
  readonly uploadsCommitted: number;
  readonly uploadsRolledBack: number;
  readonly uploadBacklog: number;
  readonly evictions: number;
  readonly missingPages: number;
  readonly batchFailures: number;
  readonly fallbackActive: boolean;
  readonly fallbackReason?: string;
}

export interface VirtualTextureResidencyResolvedBudget {
  readonly maxResidentBytes: number;
  readonly atlasLayers: number;
  readonly layerBytes: number;
  readonly maxUploadPagesPerFrame: number;
  readonly tableBudget: VirtualTextureBudget;
}

export const DEFAULT_MAX_UPLOAD_PAGES_PER_FRAME = 16;
export const GUARANTEED_MAX_TEXTURE_ARRAY_LAYERS = 2048;

/** 预算解析:非法输入抛可操作错误(配置错误,构造期 fail-closed);推导三个硬顶。
 *  atlasLayers = floor(maxResidentBytes / 每层字节),保证 atlasBytes ≤ 预算;
 *  预算不足一整层时显式拒绝(抬高 maxResidentBytes 或 tileEdgeTexels)。 */
export function resolveVirtualTextureResidencyBudget(budget: VirtualTextureResidencyBudget,
  spec: VirtualTextureTileSpec, maxArrayLayers: number): VirtualTextureResidencyResolvedBudget {
  if (spec.bytesPerTexel !== 4) {
    throw new Error("Virtual texture atlas residency only supports RGBA8 pages (bytesPerTexel = 4).");
  }
  if (!Number.isSafeInteger(budget.maxResidentBytes) || budget.maxResidentBytes < 1) {
    throw new RangeError("Virtual texture residency maxResidentBytes must be a positive safe integer.");
  }
  const layerBytes = spec.tileEdgeTexels * spec.tileEdgeTexels * spec.bytesPerTexel;
  const floorLayers = Math.floor(budget.maxResidentBytes / layerBytes);
  if (floorLayers < 1) {
    throw new RangeError(`Virtual texture residency maxResidentBytes ${budget.maxResidentBytes} is smaller`
      + ` than one atlas layer (${layerBytes} bytes); raise maxResidentBytes or tileEdgeTexels.`);
  }
  const atlasLayers = budget.maxPages === undefined ? Math.min(floorLayers, maxArrayLayers)
    : requireWithinLayers(budget.maxPages, maxArrayLayers);
  const tableBudget: VirtualTextureBudget = { maxBytes: budget.maxResidentBytes, maxPages: atlasLayers,
    ...(budget.minResidentFrames !== undefined ? { minResidentFrames: budget.minResidentFrames } : {}) };
  return { maxResidentBytes: budget.maxResidentBytes, atlasLayers, layerBytes,
    maxUploadPagesPerFrame: budget.maxUploadPagesPerFrame ?? DEFAULT_MAX_UPLOAD_PAGES_PER_FRAME,
    tableBudget };
}

function requireWithinLayers(maxPages: number, maxArrayLayers: number): number {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new RangeError("Virtual texture residency maxPages must be a positive safe integer.");
  }
  if (maxPages > maxArrayLayers) {
    throw new RangeError(`Virtual texture residency maxPages ${maxPages} exceeds device limit ${maxArrayLayers};`
      + " lower maxPages or raise tileEdgeTexels.");
  }
  return maxPages;
}
