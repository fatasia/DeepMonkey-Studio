import type { VirtualTextureFootprint } from "./virtualTextureRequests.js";

/**
 * F3 虚拟纹理采样反馈读取器(CPU 静态代理,零 GPU readback)。
 *
 * 把渲染循环已有的 CPU 可见量(draw 的 UV 覆盖域 + 屏幕覆盖像素)翻译成
 * tile 级 footprint 序列,驱动页表准入。照 pbrAutoExposure 的静态代理先例:
 * 不新增任何 GPU 往返,反馈不可用时显式计数而不是产出伪请求(fail-closed)。
 *
 * mip 选择口径:一屏幕像素覆盖的 mip-0 纹素数 ρ = 域纹素数 / 屏幕像素数
 * (纯几何比值,不依赖世界尺度);驻留请求取 floor(log4(ρ)) —— 采样端三线性
 * 使用的基准 mip,细于它的层级留给渐进细化。逐 draw 聚合(同纹理条目按
 * tile 取最细 mip / 最大权重),逐 tile 投影细化留 GPU tile-feedback 联测。
 */

/** 每纹理的页网格档案;宿主从 generateVirtualTexturePages 的产物 + 原始尺寸构造。 */
export interface VirtualTextureFeedbackTextureInfo {
  /** mip-0 尺寸(纹素)。 */
  readonly width: number;
  readonly height: number;
  readonly gridX: number;
  readonly gridY: number;
  /** 每条 tile 链的页数(mip 0..chainMips-1)。 */
  readonly chainMips: number;
}

export type VirtualTextureFeedbackTextureLookup =
  (textureId: string) => VirtualTextureFeedbackTextureInfo | undefined;

/** 一个可见 draw 的采样需求;同纹理多条目由读取器按 tile 聚合。 */
export interface VirtualTextureFeedbackEntry {
  readonly textureId: string;
  /** draw 的 UV 覆盖域;repeat 寻址支持(超界按模回绕,tile 去重)。 */
  readonly uvMinX: number;
  readonly uvMinY: number;
  readonly uvMaxX: number;
  readonly uvMaxY: number;
  /** draw 的屏幕覆盖像素(>0;0 = 不可见,丢弃并计数)。 */
  readonly screenPixels: number;
}

export interface VirtualTextureFeedbackFrameStats {
  readonly entryCount: number;
  readonly footprintCount: number;
  readonly droppedInvalid: number;
  readonly droppedInvisible: number;
  readonly droppedUnknownTexture: number;
  /** 同纹理多条目聚合发生的次数。 */
  readonly mergedEntries: number;
}

export interface VirtualTextureFeedbackFrame {
  readonly frame: number;
  readonly footprints: readonly VirtualTextureFootprint[];
  readonly stats: VirtualTextureFeedbackFrameStats;
}

interface TileDemand {
  mip: number;
  weight: number;
}

/** UV 覆盖域 + 屏幕像素 → tile 级 footprint;非法输入丢弃并显式计数,不产伪请求。 */
export class VirtualTextureFeedbackReader {
  private readonly lookup: VirtualTextureFeedbackTextureLookup;

  constructor(lookup: VirtualTextureFeedbackTextureLookup) {
    if (typeof lookup !== "function") throw new TypeError("Virtual texture feedback lookup must be a function.");
    this.lookup = lookup;
  }

  observe(frame: number, entries: readonly VirtualTextureFeedbackEntry[]): VirtualTextureFeedbackFrame {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new RangeError("Feedback frame index must be a non-negative safe integer.");
    }
    if (!Array.isArray(entries)) throw new TypeError("Virtual texture feedback entries must be an array.");
    const stats = { entryCount: entries.length, footprintCount: 0, droppedInvalid: 0,
      droppedInvisible: 0, droppedUnknownTexture: 0, mergedEntries: 0 };
    const demands = new Map<string, Map<number, TileDemand>>();
    for (const entry of entries) {
      if (!isValidEntry(entry)) { stats.droppedInvalid += 1; continue; }
      if (!(entry.screenPixels > 0)) { stats.droppedInvisible += 1; continue; }
      const info = this.lookup(entry.textureId);
      if (!info) { stats.droppedUnknownTexture += 1; continue; }
      const mip = wantedMip(entry, info);
      const tiles = coveredTiles(entry, info);
      const previous = demands.get(entry.textureId);
      if (previous) stats.mergedEntries += 1;
      const textureTiles = previous ?? new Map<number, TileDemand>();
      demands.set(entry.textureId, textureTiles);
      for (const tile of tiles) {
        const demand = textureTiles.get(tile);
        if (!demand) textureTiles.set(tile, { mip, weight: entry.screenPixels / tiles.size });
        else { demand.mip = Math.min(demand.mip, mip); demand.weight = Math.max(demand.weight, entry.screenPixels / tiles.size); }
      }
    }
    const footprints: VirtualTextureFootprint[] = [];
    for (const [textureId, textureTiles] of demands) {
      for (const [tileIndex, demand] of textureTiles) {
        const info = this.lookup(textureId)!;
        const tileX = tileIndex % info.gridX, tileY = Math.floor(tileIndex / info.gridX);
        footprints.push(Object.freeze({ textureId, tileX, tileY, maxMip: demand.mip, weight: demand.weight }));
      }
    }
    footprints.sort((left, right) => left.textureId.localeCompare(right.textureId)
      || left.tileY - right.tileY || left.tileX - right.tileX);
    stats.footprintCount = footprints.length;
    return Object.freeze({ frame, footprints: Object.freeze(footprints), stats: Object.freeze(stats) });
  }
}

/** 从离线页集产物构造反馈档案(冻结快照,供 Map 或查找闭包复用)。 */
export function virtualTextureFeedbackInfo(textureId: string, width: number, height: number,
  gridX: number, gridY: number, chainMips: number): VirtualTextureFeedbackTextureInfo {
  if (typeof textureId !== "string" || textureId.length === 0 || textureId.includes("|")) {
    throw new TypeError("Virtual texture feedback texture id must be non-empty without '|'.");
  }
  for (const [key, value] of Object.entries({ width, height, gridX, gridY, chainMips })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Virtual texture feedback info ${key} must be a positive safe integer.`);
    }
  }
  return Object.freeze({ textureId, width, height, gridX, gridY, chainMips });
}

function isValidEntry(entry: VirtualTextureFeedbackEntry): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.textureId !== "string" || entry.textureId.length === 0 || entry.textureId.includes("|")) return false;
  const uv = [entry.uvMinX, entry.uvMinY, entry.uvMaxX, entry.uvMaxY] as const;
  if (!uv.every(Number.isFinite)) return false;
  if (!(entry.uvMaxX > entry.uvMinX) || !(entry.uvMaxY > entry.uvMinY)) return false;
  return Number.isFinite(entry.screenPixels) && entry.screenPixels >= 0;
}

/** 每屏幕像素覆盖的 mip-0 纹素数 ρ = 域纹素数/屏幕像素数;请求 mip = floor(log4 ρ)。 */
function wantedMip(entry: VirtualTextureFeedbackEntry, info: VirtualTextureFeedbackTextureInfo): number {
  const domainTexels = (entry.uvMaxX - entry.uvMinX) * info.width * (entry.uvMaxY - entry.uvMinY) * info.height;
  const texelsPerScreenPixel = domainTexels / entry.screenPixels;
  const lod = Math.log2(Math.max(texelsPerScreenPixel, 1)) / 2;
  return Math.min(Math.max(Math.floor(lod), 0), info.chainMips - 1);
}

/** UV 域覆盖的 tile 索引集;repeat 寻址按模回绕,迭代数以网格尺寸为上界。 */
function coveredTiles(entry: VirtualTextureFeedbackEntry, info: VirtualTextureFeedbackTextureInfo): Set<number> {
  const tiles = new Set<number>();
  const columns = coveredIndices(entry.uvMinX, entry.uvMaxX, info.gridX);
  const rows = coveredIndices(entry.uvMinY, entry.uvMaxY, info.gridY);
  for (const row of rows) for (const column of columns) tiles.add(row * info.gridX + column);
  return tiles;
}

function coveredIndices(min: number, max: number, grid: number): number[] {
  const first = Math.floor(min * grid), last = Math.ceil(max * grid) - 1;
  if (last - first + 1 >= grid) return Array.from({ length: grid }, (_, index) => index);
  const unique = new Set<number>();
  for (let index = first; index <= last; index++) unique.add(((index % grid) + grid) % grid);
  return [...unique];
}
