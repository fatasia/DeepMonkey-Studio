import type { DecodedTexture, PixelLevel } from "../textures/decodedTexture.js";
import { boxDownsampleRgba8 } from "../virtualTextures/virtualTexturePages.js";
import { resolveVirtualTextureFootprints, resolveVirtualTextureSample,
  type VirtualTextureFootprintResolution } from "../virtualTextures/virtualTextureDiagnostics.js";
import { VirtualTextureFeedbackReader, virtualTextureFeedbackInfo,
  type VirtualTextureFeedbackEntry, type VirtualTextureFeedbackFrame,
  type VirtualTextureFeedbackTextureInfo } from "../virtualTextures/virtualTextureFeedback.js";
import { virtualTexturePageCostBytes, type VirtualTexturePage } from "../virtualTextures/virtualTexturePages.js";
import { resolveVirtualTextureOptions, type ResolvedVirtualTextureOptions,
  type VirtualTextureOptions } from "../virtualTextures/virtualTextureOptions.js";
import { VirtualTexturePageTablePacker, type VirtualTexturePackedPageTable } from "./virtualTexturePagePacking.js";
import type { DeviceSession } from "./deviceSession.js";
import { VirtualTextureAtlasResidency } from "./virtualTextureResidency.js";

export type { VirtualTextureFeedbackEntry, VirtualTextureFeedbackTextureInfo };

/**
 * F4 虚拟纹理帧桥:渲染循环 ↔ 反馈读取器 + 预算驻留控制器的单点适配。
 *
 * - 页数据按需生成:目录持有 RenderPacket 原始 DecodedTexture 引用(零拷贝),
 *   pageSource 回调时才切单页;mip level 缓存每纹理至多一级(LRU 1),换 mip 重算
 *   box 前缀——不持有整纹理像素的第二个常驻副本(F3 接线点 5 的承诺口径)。
 * - 驻留时钟独立自增:渲染帧可能失败重试(this.frame 只在成功路径递增),驻留只要求
 *   单调 tick,与渲染帧号解耦,重试帧不会触发 strictly-advancing 合同。
 * - 遥测 = 驻留遥测 + 反馈统计 + 采样消费统计 + CPU advance 计时,经
 *   FrameMetrics.virtualTextures 逐帧披露;resolve disabled 时工厂返回 undefined
 *   (照 autoExposure:默认关 = 字段不出现,零行为变化)。
 */

export interface VirtualTextureFeedbackTotals {
  readonly entryCount: number;
  readonly footprintCount: number;
  readonly droppedInvalid: number;
  readonly droppedInvisible: number;
  readonly droppedUnknownTexture: number;
  readonly mergedEntries: number;
  /** 反馈链路不可用的显式原因(fail-closed,不静默):no-catalog=目录为空;
   *  all-entries-dropped=本帧条目全部被丢弃(非法/未知纹理)且零页需求产出。
   *  全部不可见(droppedInvisible)是合法剔除,不算不可用。可用时字段不出现。 */
  readonly unavailable?: string;
}

/** 本帧 footprint 的页命中/缺失分布(采样解析口径;in-flight 页按不可采样计)。 */
export type VirtualTexturePageResolveStats = VirtualTextureFootprintResolution;

export interface VirtualTextureFrameMetrics {
  readonly enabled: true;
  readonly frame: number;
  readonly catalogTextures: number;
  readonly fallbackActive: boolean;
  readonly fallbackReason?: string;
  readonly atlasLayers: number;
  readonly atlasBytes: number;
  readonly residentPages: number;
  readonly residentBytes: number;
  readonly uploadsQueued: number;
  readonly uploadsCommitted: number;
  readonly uploadsRolledBack: number;
  readonly uploadBacklog: number;
  readonly evictions: number;
  readonly missingPages: number;
  readonly batchFailures: number;
  readonly feedback: VirtualTextureFeedbackTotals;
  /** 本帧页命中/缺失计数(fallback 态省略——采样方已回退整纹理,计数不适用)。 */
  readonly pages?: VirtualTexturePageResolveStats;
  /** tile-lookup 采样消费统计:本帧 CPU 发出的样本请求数(GPU 消费由 sampling pass 计)。 */
  readonly sampleRequests: number;
  /** GPU tile-lookup 消费结果(pass 编码侧回填;未编码帧缺省)。 */
  readonly sampling?: { readonly dispatches: number; readonly samples: number;
    readonly skipped: "no-samples" | "no-atlas-view" | "over-capacity" | undefined };
  readonly advanceMs: number;
}

/** 采样 pass 页表打包的每纹理档案(网格按 mip 显式给出,shader 不做尺寸推导)。 */
export interface VirtualTextureCatalogEntry {
  readonly textureId: string;
  readonly chainMips: number;
  readonly mipGrids: readonly { readonly gridWidth: number; readonly gridHeight: number;
    readonly levelWidth: number; readonly levelHeight: number }[];
}

export interface VirtualTextureSampleRequest {
  readonly textureIndex: number;
  readonly u: number;
  readonly v: number;
  readonly mip: number;
}

interface CatalogSource {
  readonly info: VirtualTextureFeedbackTextureInfo;
  readonly mipGrids: VirtualTextureCatalogEntry["mipGrids"];
  readonly source: DecodedTexture;
}

/** 两行仿射 UV 变换作用于 [0,1]² 的包围域(repeat 回绕由反馈读取器处理)。 */
export function virtualTextureUvBounds(
  transform: readonly [number, number, number, number, number, number]): {
  readonly uvMinX: number; readonly uvMinY: number; readonly uvMaxX: number; readonly uvMaxY: number } {
  const [m00, m01, tx, m10, m11, ty] = transform;
  const xs = [tx, m00 + tx, m01 + tx, m00 + m01 + tx];
  const ys = [ty, m10 + ty, m11 + ty, m10 + m11 + ty];
  return { uvMinX: Math.min(...xs), uvMaxX: Math.max(...xs), uvMinY: Math.min(...ys), uvMaxY: Math.max(...ys) };
}

export function createVirtualTextureFrameBridge(session: DeviceSession,
  options: VirtualTextureOptions | undefined): VirtualTextureFrameBridge | undefined {
  return VirtualTextureFrameBridge.create(session, options);
}

export class VirtualTextureFrameBridge {
  /** resolve disabled(未启用/非法配置)→ undefined(照 autoExposure:字段不出现,零行为变化)。 */
  static create(session: DeviceSession,
    options: VirtualTextureOptions | undefined): VirtualTextureFrameBridge | undefined {
    const resolved = resolveVirtualTextureOptions(options ?? {});
    return resolved.enabled ? new VirtualTextureFrameBridge(session, resolved) : undefined;
  }

  private readonly residency: VirtualTextureAtlasResidency;
  private readonly reader: VirtualTextureFeedbackReader;
  private readonly sources = new Map<string, CatalogSource>();
  private readonly levelCache = new Map<string, { readonly mip: number; readonly level: PixelLevel }>();
  private readonly catalogOrder: string[] = [];
  private readonly pagePacker: VirtualTexturePageTablePacker;
  private readonly pageResolveTotals = { hits: 0, pageFaults: 0, fallbackTextures: 0 };
  /** 纹理目录版本号:增删/换版各递增;打包缓存键的一半(另一半是层分配 epoch)。 */
  private catalogEpochValue = 0;
  private tick = 0;
  private lastMetrics: VirtualTextureFrameMetrics | undefined;
  private lastSamples: readonly VirtualTextureSampleRequest[] = [];
  private disposed = false;

  private readonly now: () => number;

  private constructor(session: DeviceSession, private readonly resolved: ResolvedVirtualTextureOptions
    & { readonly enabled: true }) {
    this.now = resolved.frameClock ?? (() => Date.now());
    this.residency = new VirtualTextureAtlasResidency(session, resolved.spec, {
      maxResidentBytes: resolved.maxResidentBytes,
      ...(resolved.maxPages !== undefined ? { maxPages: resolved.maxPages } : {}),
      maxUploadPagesPerFrame: resolved.maxUploadPagesPerFrame,
      ...(resolved.minResidentFrames > 0 ? { minResidentFrames: resolved.minResidentFrames } : {}),
    }, pageId => this.page(pageId));
    this.reader = new VirtualTextureFeedbackReader(textureId => this.sources.get(textureId)?.info);
    this.pagePacker = new VirtualTexturePageTablePacker(() => this.textureCatalog(),
      (textureId, tileX, tileY, mip) => this.layerOfPage(textureId, tileX, tileY, mip),
      resolved.spec.tileEdgeTexels);
  }

  /** 全量同步包纹理目录:新增入目录( RGBA8 之外 fail-closed 拒绝),消失/换版释放驻留。 */
  syncTextures(textures: readonly DecodedTexture[]): void {
    this.assertUsable();
    const seen = new Set<string>();
    for (const texture of textures) {
      if (!texture || typeof texture.id !== "string" || texture.id.length === 0
        || texture.id.includes("|") || texture.compression !== undefined) continue;
      seen.add(texture.id);
      const existing = this.sources.get(texture.id);
      if (existing && existing.source.revision === texture.revision) continue;
      if (existing) this.dropTexture(texture.id);
      this.addTexture(texture);
    }
    for (const textureId of [...this.sources.keys()]) if (!seen.has(textureId)) this.dropTexture(textureId);
  }

  /** 反馈 → 驻留逐帧推进;返回本帧遥测并留存 tile-lookup 采样请求。
   *  页命中/缺失计数在 advance 后解析(此刻本帧准入仍 in-flight,按不可采样计——
   *  fail-closed 口径);累计口径经 pageResolveCounts,收敛断言须在批次收口后差分。 */
  observeFrame(entries: readonly VirtualTextureFeedbackEntry[]): VirtualTextureFrameMetrics {
    this.assertUsable();
    const begin = this.now();
    const frame = this.tick;
    const observed = this.reader.observe(frame, entries);
    const telemetry = this.residency.advance(this.tick, observed.footprints);
    this.lastSamples = this.sampleRequestsFrom(observed.footprints);
    const unavailable = feedbackUnavailableReason(this.sources.size, observed);
    const pages = telemetry.fallbackActive ? undefined
      : resolveVirtualTextureFootprints(this.residency.pageTable, observed.footprints);
    if (pages) {
      this.pageResolveTotals.hits += pages.hits;
      this.pageResolveTotals.pageFaults += pages.pageFaults;
      this.pageResolveTotals.fallbackTextures += pages.fallbackTextures;
    }
    const metrics: VirtualTextureFrameMetrics = Object.freeze({
      enabled: true, frame: this.tick, catalogTextures: this.sources.size,
      fallbackActive: telemetry.fallbackActive,
      ...(telemetry.fallbackReason !== undefined ? { fallbackReason: telemetry.fallbackReason } : {}),
      atlasLayers: telemetry.atlasLayers, atlasBytes: telemetry.atlasBytes,
      residentPages: telemetry.residentPages, residentBytes: telemetry.residentBytes,
      uploadsQueued: telemetry.uploadsQueued, uploadsCommitted: telemetry.uploadsCommitted,
      uploadsRolledBack: telemetry.uploadsRolledBack, uploadBacklog: telemetry.uploadBacklog,
      evictions: telemetry.evictions, missingPages: telemetry.missingPages, batchFailures: telemetry.batchFailures,
      feedback: Object.freeze({ entryCount: observed.stats.entryCount, footprintCount: observed.stats.footprintCount,
        droppedInvalid: observed.stats.droppedInvalid, droppedInvisible: observed.stats.droppedInvisible,
        droppedUnknownTexture: observed.stats.droppedUnknownTexture, mergedEntries: observed.stats.mergedEntries,
        ...(unavailable !== undefined ? { unavailable } : {}) }),
      ...(pages ? { pages: Object.freeze(pages) } : {}),
      sampleRequests: this.lastSamples.length, advanceMs: this.now() - begin,
    });
    this.tick += 1;
    this.lastMetrics = metrics;
    return metrics;
  }

  /** 累计页命中/缺失计数(构造以来;批次收口时点由调用方保证时语义才收敛)。 */
  get pageResolveCounts(): VirtualTexturePageResolveStats { return Object.freeze({ ...this.pageResolveTotals }); }

  /**
   * 页表打包(epoch 缓存):目录与层分配均不变时 O(1) 复用同一产物,变化帧才重打包
   * (repackCount 可观测)。产出的 params[0] 为占位 0,采样 pass 逐帧覆盖样本数;
   * epoch 传给 encode 后稳定帧可跳过 meta/layers 大缓冲重写。fallback 态显式拒绝
   * (采样方走整纹理路径,页表不适用),与 pageTable getter 同语义。
   */
  packPageTable(): VirtualTexturePackedPageTable {
    this.assertUsable();
    if (this.residency.fallbackActive) {
      throw new Error(`Virtual texture page table packing is unavailable in fallback`
        + ` (${this.residency.fallbackReason ?? "unknown"}); use the whole-texture LOD path.`);
    }
    return this.pagePacker.pack(this.catalogEpochValue, this.residency.layerEpoch);
  }

  /** 自构造以来页表实际重打包次数(缓存命中不计数;CPU 页表更新对照口径)。 */
  get pageRepackCount(): number { return this.pagePacker.repackCount; }

  get fallbackActive(): boolean { return this.residency.fallbackActive; }
  get fallbackReason(): string | undefined { return this.residency.fallbackReason; }
  get metrics(): VirtualTextureFrameMetrics | undefined { return this.lastMetrics; }
  get samples(): readonly VirtualTextureSampleRequest[] { return this.lastSamples; }
  get atlasTexture(): GPUTexture | undefined { return this.residency.atlasTexture; }
  /** atlas layer 边长(纹素)= tileEdgeTexels;tile-lookup 页内 uv 归一化基准。 */
  get atlasEdgeTexels(): number { return this.resolved.spec.tileEdgeTexels; }

  textureCatalog(): readonly VirtualTextureCatalogEntry[] {
    return this.catalogOrder.map(textureId => {
      const source = this.sources.get(textureId)!;
      return { textureId, chainMips: source.info.chainMips, mipGrids: source.mipGrids };
    });
  }

  /** 采样判定链(F3 报告合同:先 resolveVirtualTextureSample 判合法性,再取 layerOf):
   *  缺页/in-flight/pending 一律 undefined(tile-lookup 输出哨兵色),绝不返回未提交槽位。 */
  layerOfPage(textureId: string, tileX: number, tileY: number, mip: number): number | undefined {
    try {
      const sample = resolveVirtualTextureSample(this.residency.pageTable, textureId, tileX, tileY, mip);
      if (sample.status !== "resident" || sample.resolvedMip === null) return undefined;
      return this.residency.layerOf(`${textureId}|${tileX},${tileY}|mip${sample.resolvedMip}`);
    } catch {
      // fallback 态页表访问显式拒绝:调用方走整纹理路径,这里返回 undefined 同语义。
      return undefined;
    }
  }

  releaseTexture(textureId: string): void { this.dropTexture(textureId); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.residency.dispose();
    this.sources.clear(); this.levelCache.clear(); this.catalogOrder.length = 0;
    this.lastMetrics = undefined; this.lastSamples = [];
  }

  private addTexture(texture: DecodedTexture): void {
    const spec = this.resolved.spec;
    const planLevels = 1 + Math.ceil(Math.log2(Math.max(texture.width, texture.height)));
    const chainMips = Math.min(planLevels, Math.round(1 + Math.log2(spec.tileEdgeTexels)));
    const gridWidth = Math.ceil(texture.width / spec.tileEdgeTexels);
    const gridHeight = Math.ceil(texture.height / spec.tileEdgeTexels);
    const mipGrids = Array.from({ length: chainMips }, (_, mip) => {
      const levelWidth = Math.max(1, texture.width >> mip);
      const levelHeight = Math.max(1, texture.height >> mip);
      return { gridWidth: Math.ceil(levelWidth / Math.max(1, spec.tileEdgeTexels >> mip)),
        gridHeight: Math.ceil(levelHeight / Math.max(1, spec.tileEdgeTexels >> mip)), levelWidth, levelHeight };
    });
    try {
      this.sources.set(texture.id, { source: texture,
        info: virtualTextureFeedbackInfo(texture.id, texture.width, texture.height, gridWidth, gridHeight, chainMips),
        mipGrids });
      this.catalogOrder.push(texture.id);
      this.catalogEpochValue += 1;
    } catch { /* 非法档案(id/尺寸)不入目录;反馈侧 droppedUnknownTexture 逐类可见。 */ }
  }

  private dropTexture(textureId: string): void {
    if (!this.sources.delete(textureId)) return;
    this.catalogEpochValue += 1;
    this.levelCache.delete(textureId);
    const order = this.catalogOrder.indexOf(textureId);
    if (order >= 0) this.catalogOrder.splice(order, 1);
    try { this.residency.releaseTexture(textureId); } catch { /* fallback 态页表访问显式拒绝:目录同步先行。 */ }
  }

  /** 单页按需切取(与 paginatePreparedTexture 单页逻辑同源,一致性由测试锁定)。
   *  textureId 不含 '|'(目录准入已拒绝),页 id 恰为三段,直接切分解析。 */
  private page(pageId: string): VirtualTexturePage | undefined {
    const parts = pageId.split("|");
    if (parts.length !== 3) return undefined;
    const coords = /^(-?\d+),(-?\d+)$/.exec(parts[1]!), mipMatch = /^mip(\d+)$/.exec(parts[2]!);
    if (!coords || !mipMatch) return undefined;
    const textureId = parts[0]!;
    const tileX = Number(coords[1]), tileY = Number(coords[2]), mip = Number(mipMatch[1]);
    const entry = this.sources.get(textureId);
    if (!entry || mip >= entry.info.chainMips) return undefined;
    const spec = this.resolved.spec;
    const edge = Math.max(1, spec.tileEdgeTexels >> mip);
    const grid = entry.mipGrids[mip]!;
    if (tileX < 0 || tileY < 0 || tileX >= grid.gridWidth || tileY >= grid.gridHeight) return undefined;
    const level = this.levelFor(textureId, mip);
    if (!level || level.data.length < level.width * level.height * 4) return undefined;
    const x0 = tileX * edge, y0 = tileY * edge;
    const width = Math.max(0, Math.min(edge, level.width - x0));
    const height = Math.max(0, Math.min(edge, level.height - y0));
    const costBytes = virtualTexturePageCostBytes(spec, mip);
    const data = new Uint8Array(costBytes);
    for (let row = 0; row < height; row++) {
      const start = (y0 + row) * level.width * 4 + x0 * 4;
      data.set(level.data.subarray(start, start + width * 4), row * edge * 4);
    }
    return Object.freeze({ id: pageId, textureId, tileX, tileY, mip, width, height, costBytes, data });
  }

  /** 每纹理 LRU 1 级 mip 缓存:优先用宿主自带 mipmaps(零计算零拷贝),否则 box 链前缀重算。 */
  private levelFor(textureId: string, mip: number): PixelLevel | undefined {
    const cached = this.levelCache.get(textureId);
    if (cached && cached.mip === mip) return cached.level;
    const source = this.sources.get(textureId)?.source;
    if (!source) return undefined;
    let level: PixelLevel = source;
    if (mip > 0) {
      const provided = source.mipmaps?.[mip - 1];
      if (provided) level = provided;
      else { let previous: PixelLevel = source;
        for (let step = 0; step < mip; step++) { previous = boxDownsampleRgba8(previous); }
        level = previous; }
    }
    this.levelCache.set(textureId, { mip, level });
    return level;
  }

  /** tile-lookup 样本:footprint tile 中心 UV,有界截断(上传与 dispatch 帧预算内)。 */
  private sampleRequestsFrom(footprints: readonly { readonly textureId: string; readonly tileX: number;
    readonly tileY: number; readonly maxMip: number }[]): readonly VirtualTextureSampleRequest[] {
    const SAMPLE_BUDGET = 64;
    const requests: VirtualTextureSampleRequest[] = [];
    for (const footprint of footprints) {
      if (requests.length >= SAMPLE_BUDGET) break;
      const index = this.catalogOrder.indexOf(footprint.textureId);
      const grid = this.sources.get(footprint.textureId)?.mipGrids[footprint.maxMip];
      if (index < 0 || !grid) continue;
      requests.push({ textureIndex: index,
        u: (footprint.tileX + 0.5) / grid.gridWidth, v: (footprint.tileY + 0.5) / grid.gridHeight,
        mip: footprint.maxMip });
    }
    return requests;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("Virtual texture frame bridge is disposed.");
  }
}

/** 反馈链路不可用的显式原因;可用(或合法的零可见)返回 undefined。 */
function feedbackUnavailableReason(catalogTextures: number,
  observed: VirtualTextureFeedbackFrame): string | undefined {
  if (catalogTextures === 0) return "no-catalog";
  if (observed.footprints.length === 0
    && observed.stats.droppedInvalid + observed.stats.droppedUnknownTexture > 0) return "all-entries-dropped";
  return undefined;
}
