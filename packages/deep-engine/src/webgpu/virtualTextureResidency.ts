import { buildVirtualTexturePageRequests,
  type VirtualTextureFootprint } from "../virtualTextures/virtualTextureRequests.js";
import { VirtualTexturePageTable, type VirtualTexturePageHandle } from "../virtualTextures/virtualTexturePageTable.js";
import type { VirtualTexturePage, VirtualTextureTileSpec } from "../virtualTextures/virtualTexturePages.js";
import { GUARANTEED_MAX_TEXTURE_ARRAY_LAYERS, resolveVirtualTextureResidencyBudget,
  type VirtualTextureResidencyBudget, type VirtualTextureResidencyTelemetry } from "./virtualTextureResidencyBudget.js";
import type { DeviceSession } from "./deviceSession.js";
import { createAdmittedTexture } from "./resourceAdmission.js";

/**
 * F3 虚拟纹理 GPU 预算驻留控制器:把页表计划落到一张页 atlas(2D array,每 layer
 * 一页)。预算双口径见 virtualTextureResidencyBudget(逻辑驻留与 GPU atlas 同一硬顶;
 * atlasLayers = 页表 maxPages,"在表页必有槽位"由构造保证)。fail-closed:atlas 创建
 * 失败/session 未就绪 → 整体 fallback(采样方走整纹理 LOD);单批 writeTexture 失败 →
 * 整批回滚+槽位回收;页数据缺失/失配 → 该页立即回滚并级联回滚同链高 mip,绝不伪造
 * 可采样页。页数据按需取自页源回调,不持有整纹理像素。同步推进、零 readback。
 */

export type { VirtualTextureResidencyBudget, VirtualTextureResidencyTelemetry } from "./virtualTextureResidencyBudget.js";
export type VirtualTexturePageSource = (pageId: string) => VirtualTexturePage | undefined;

interface UploadBatch {
  readonly handles: readonly VirtualTexturePageHandle[];
  readonly layers: ReadonlyMap<string, number>;
}

export class VirtualTextureAtlasResidency {
  private readonly session: DeviceSession;
  private readonly table: VirtualTexturePageTable;
  private readonly spec: VirtualTextureTileSpec;
  private readonly pageSource: VirtualTexturePageSource;
  private readonly resolved: ReturnType<typeof resolveVirtualTextureResidencyBudget>;
  private readonly queue: VirtualTexturePageHandle[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly slotOfPage = new Map<string, number>();
  private readonly freeLayers: number[] = [];
  private readonly seenTextures = new Set<string>();
  private readonly releasedTextures = new Set<string>();
  private atlas: GPUTexture | undefined;
  private batch: UploadBatch | undefined;
  private state: "active" | "fallback" | "disposed" = "active";
  private fallbackReasonText: string | undefined;
  private totals = { uploadsQueued: 0, uploadsCommitted: 0, uploadsRolledBack: 0,
    evictions: 0, missingPages: 0, batchFailures: 0 };
  private lastFrame = -1;

  constructor(session: DeviceSession, spec: VirtualTextureTileSpec, budget: VirtualTextureResidencyBudget,
    pageSource: VirtualTexturePageSource) {
    if (typeof pageSource !== "function") throw new TypeError("Virtual texture page source must be a function.");
    const maxArrayLayers = session.device.limits.maxTextureArrayLayers ?? GUARANTEED_MAX_TEXTURE_ARRAY_LAYERS;
    this.session = session;
    this.spec = spec;
    this.pageSource = pageSource;
    this.resolved = resolveVirtualTextureResidencyBudget(budget, spec, maxArrayLayers);
    this.table = new VirtualTexturePageTable(spec, this.resolved.tableBudget);
    for (let layer = this.resolved.atlasLayers - 1; layer >= 0; layer--) this.freeLayers.push(layer);
  }

  /** 页表(供 resolveVirtualTextureSample 缺页解析与诊断);fallback 态显式拒绝(回整纹理)。 */
  get pageTable(): VirtualTexturePageTable { this.assertUsable(); return this.table; }
  get fallbackActive(): boolean { return this.state === "fallback"; }
  get fallbackReason(): string | undefined { return this.fallbackReasonText; }
  /** 页 atlas(2D array,单 mip,每 layer 一页);懒创建,fallback/销毁后为 undefined。 */
  get atlasTexture(): GPUTexture | undefined { return this.atlas; }

  /** 在表页 → atlas layer 槽位(tile lookup shader 页表 uniform 数据源);in-flight 页占槽不可采样。 */
  layerOf(pageId: string): number | undefined {
    return this.state === "disposed" ? undefined : this.slotOfPage.get(pageId);
  }

  /**
   * 逐帧推进:fallback 时零工作、只回报遥测(采样方回退整纹理);否则先续传上一帧
   * backlog,再按本帧 footprint 规划准入并入队,启动至多一批上传(错误作用域异步
   * 收口),plan 的 evicted 立即回收槽位。同步、零 readback。
   */
  advance(frame: number, footprints: readonly VirtualTextureFootprint[]): VirtualTextureResidencyTelemetry {
    if (this.state === "disposed") throw new Error("Virtual texture atlas residency is disposed.");
    if (!Number.isSafeInteger(frame) || frame <= this.lastFrame) {
      throw new RangeError("Residency frames must be non-negative and strictly advancing.");
    }
    this.lastFrame = frame;
    if (this.state === "active") {
      this.flushUploadQueue();
      const plan = this.table.plan(buildVirtualTexturePageRequests(footprints, this.spec), frame);
      for (const handle of plan.admitted) {
        if (this.queuedIds.has(handle.id)) continue;
        this.queue.push(handle); this.queuedIds.add(handle.id);
        this.seenTextures.add(handle.textureId);
      }
      for (const handle of plan.evicted) { this.freeSlot(handle.id); this.totals.evictions += 1; }
      this.flushUploadQueue();
    }
    return this.telemetry(frame);
  }

  /** 释放一个纹理:队列中的 in-flight 页先回滚,已提交页整纹理逐出(槽位回收)。 */
  releaseTexture(textureId: string): void {
    this.assertUsable();
    if (typeof textureId !== "string" || textureId.length === 0) {
      throw new TypeError("Virtual texture release id must be a non-empty string.");
    }
    this.releasedTextures.add(textureId);
    this.drainReleasedFromQueue(textureId);
    this.tryReleaseCommitted(textureId);
  }

  /** 终态释放(幂等):队列 in-flight 回滚、已提交页逐出、atlas 释放;此后所有 API 拒绝。 */
  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    for (const textureId of this.seenTextures) this.drainReleasedFromQueue(textureId);
    this.queue.length = 0; this.queuedIds.clear(); this.releasedTextures.clear();
    // 未收口批次由 settleBatch 在 disposed 分支回滚(单一回滚路径,不双跳)。
    this.atlas = undefined;
  }
  private telemetry(frame: number): VirtualTextureResidencyTelemetry {
    return Object.freeze({
      frame, residentBytes: this.table.residentByteCount, residentPages: this.table.residentCount,
      atlasLayers: this.resolved.atlasLayers, atlasBytes: this.resolved.atlasLayers * this.resolved.layerBytes,
      uploadsQueued: this.totals.uploadsQueued, uploadsCommitted: this.totals.uploadsCommitted,
      uploadsRolledBack: this.totals.uploadsRolledBack, uploadBacklog: this.queue.length,
      evictions: this.totals.evictions, missingPages: this.totals.missingPages,
      batchFailures: this.totals.batchFailures, fallbackActive: this.state === "fallback",
      ...(this.fallbackReasonText !== undefined ? { fallbackReason: this.fallbackReasonText } : {}),
    });
  }

  /** 每帧至多一批(错误作用域按批收口,批间不重叠,提交顺序即准入顺序)。 */
  private flushUploadQueue(): void {
    if (this.batch !== undefined || this.queue.length === 0) return;
    if (this.atlas === undefined && !this.ensureAtlas()) return;
    const handles: VirtualTexturePageHandle[] = [];
    const layers = new Map<string, number>();
    while (handles.length < this.resolved.maxUploadPagesPerFrame && this.queue.length > 0) {
      const handle = this.queue[0]!;
      const page = this.pageSource(handle.id);
      if (!page || page.data.length !== page.costBytes || page.costBytes !== handle.costBytes) {
        // 缺页级联:同链更高 mip 一并回滚移队——没有它们的前缀,后续提交必破前缀不变量。
        const doomed = [handle.id];
        for (let index = 1; index < this.queue.length;) {
          const other = this.queue[index]!;
          if (other.textureId === handle.textureId && other.tileX === handle.tileX
            && other.tileY === handle.tileY && other.mip > handle.mip) {
            doomed.push(other.id);
            this.queue.splice(index, 1);
            continue;
          }
          index += 1;
        }
        this.queue.shift();
        for (const id of doomed) this.queuedIds.delete(id);
        this.rollbackIds(doomed);
        this.totals.missingPages += 1;
        continue;
      }
      const layer = this.freeLayers.pop();
      if (layer === undefined) break;
      this.slotOfPage.set(handle.id, layer);
      layers.set(handle.id, layer);
      handles.push(handle);
      this.queue.shift(); this.queuedIds.delete(handle.id);
    }
    if (handles.length === 0) return;
    this.batch = { handles, layers };
    this.totals.uploadsQueued += handles.length;
    void this.writeBatch(handles, layers);
  }

  /** 一批全部 writeTexture 纳入同一组错误作用域;任一失败整批回滚。 */
  private writeBatch(handles: readonly VirtualTexturePageHandle[], layers: ReadonlyMap<string, number>): void {
    const device = this.session.device;
    const scopes: Promise<GPUError | null>[] = [];
    try {
      for (const filter of ["validation", "out-of-memory", "internal"] as const) {
        device.pushErrorScope(filter); scopes.push(device.popErrorScope());
      }
      for (const handle of handles) {
        const upload = uploadLayout(this.pageSource(handle.id)!, this.spec.tileEdgeTexels);
        device.queue.writeTexture({ texture: this.atlas!, mipLevel: 0,
          origin: { x: 0, y: 0, z: layers.get(handle.id)! } }, upload.data,
          { bytesPerRow: upload.bytesPerRow, rowsPerImage: upload.edge },
          { width: upload.edge, height: upload.edge, depthOrArrayLayers: 1 });
      }
    } catch (error) {
      this.settleBatch(handles, layers, false, error);
      return;
    }
    void Promise.all(scopes).then(errors => {
      const error = errors.find(value => value !== null);
      this.settleBatch(handles, layers, error === undefined, error);
    }, settleError => this.settleBatch(handles, layers, false, settleError));
  }

  private settleBatch(handles: readonly VirtualTexturePageHandle[], layers: ReadonlyMap<string, number>,
    ok: boolean, error: unknown): void {
    if (this.batch !== undefined && this.batch.handles === handles) this.batch = undefined;
    const ids = handles.map(handle => handle.id);
    if (this.state === "disposed" || !ok) {
      if (!ok) this.totals.batchFailures += 1;
      this.rollbackIds(ids);
      for (const id of layers.keys()) this.freeSlot(id);
      return;
    }
    this.table.commitAdmissions(ids);
    this.totals.uploadsCommitted += handles.length;
    for (const textureId of new Set(handles.map(handle => handle.textureId)))
      if (this.releasedTextures.has(textureId)) this.tryReleaseCommitted(textureId);
  }

  /** 单一回滚计数点:in-flight 页回滚必经此处,uploadsRolledBack 不在调用方重复累加。 */
  private rollbackIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.table.rollbackAdmissions(ids);
    this.totals.uploadsRolledBack += ids.length;
  }

  private drainReleasedFromQueue(textureId: string): void {
    const ids: string[] = [];
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const handle = this.queue[index]!;
      if (handle.textureId !== textureId) continue;
      this.queue.splice(index, 1);
      this.queuedIds.delete(handle.id);
      ids.push(handle.id);
    }
    this.rollbackIds(ids);
  }

  private tryReleaseCommitted(textureId: string): void {
    try {
      const evicted = this.table.evictTexture(textureId);
      for (const handle of evicted) { this.freeSlot(handle.id); this.totals.evictions += 1; }
      this.releasedTextures.delete(textureId);
    } catch {
      // 仍有 in-flight 页(在未收口批次里):批次收口后由 settleBatch 重试释放。
    }
  }

  private ensureAtlas(): boolean {
    if (this.session.state !== "ready") {
      this.enterFallback("virtual-texture:session-not-ready");
      return false;
    }
    try {
      this.atlas = createAdmittedTexture(this.session, {
        label: "Deep virtual texture page atlas",
        size: { width: this.spec.tileEdgeTexels, height: this.spec.tileEdgeTexels,
          depthOrArrayLayers: this.resolved.atlasLayers },
        format: "rgba8unorm", dimension: "2d", mipLevelCount: 1,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.atlas.createView();
      return true;
    } catch (error) {
      this.enterFallback(`virtual-texture:atlas-creation-failed(${(error as Error).message})`);
      return false;
    }
  }

  /** fallback:in-flight 全部回滚,advance 零工作,采样方走整纹理 LOD 路径。 */
  private enterFallback(reason: string): void {
    if (this.state !== "active") return;
    this.state = "fallback";
    this.fallbackReasonText = reason;
    const ids = this.queue.map(handle => handle.id);
    this.queue.length = 0; this.queuedIds.clear();
    this.rollbackIds(ids);
  }

  private freeSlot(pageId: string): void {
    const layer = this.slotOfPage.get(pageId);
    if (layer === undefined) return;
    this.slotOfPage.delete(pageId);
    this.freeLayers.push(layer);
  }

  private assertUsable(): void {
    if (this.state === "disposed") throw new Error("Virtual texture atlas residency is disposed.");
    if (this.state === "fallback") {
      throw new Error(`Virtual texture atlas residency is in fallback (${this.fallbackReason ?? "unknown"});`
        + " use the whole-texture LOD path.");
    }
  }
}

/** 页字节按生边 edge²(零填充)紧排;writeTexture 行距须 256 对齐,生边 < 64 时
 *  行距上取整并逐行重排进临时缓冲(仅深 mip 小页,单页 ≤ 16 KiB)。 */
function uploadLayout(page: VirtualTexturePage, tileEdgeTexels: number): {
  readonly data: Uint8Array<ArrayBuffer>; readonly bytesPerRow: number; readonly edge: number;
} {
  const edge = Math.max(1, tileEdgeTexels >> page.mip);
  const rawRow = edge * 4;
  const bytesPerRow = Math.ceil(rawRow / 256) * 256;
  if (bytesPerRow === rawRow) return { data: page.data, bytesPerRow, edge };
  const padded = new Uint8Array(bytesPerRow * (edge - 1) + rawRow);
  for (let row = 0; row < edge; row++) {
    padded.set(page.data.subarray(row * rawRow, (row + 1) * rawRow), row * bytesPerRow);
  }
  return { data: padded, bytesPerRow, edge };
}
