import { prepareRenderPacket, type PreparedBatch, type PreparedPacket, type RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import type { PbrResidencyFrameTarget } from "../webgpu/pbrResidencyStream.js";
import { createSceneChunkResidency, type SceneChunkResidency, type SceneChunkResidencyDemand } from "../webgpu/sceneChunkResidency.js";
import { stageSceneChunkFrame } from "../webgpu/sceneChunkFrameStage.js";
import { failWithResourceCleanup } from "../webgpu/resourceCleanup.js";
import { AuthorChunkCatalog } from "./authorChunkCatalog.js";
import { compilePacketBoundsHlod } from "../packetBoundsHlod.js";
import { compileVirtualGeometryPages } from "../virtualGeometryPages.js";
import { HLOD_PROXY_MATERIAL_ID, type HlodClusterFramePlan, type HlodClusterProxyDraw,
  type HlodClusterStreamResources } from "./hlodClusterStream.js";

export interface AuthorChunkStreamRuntime extends PbrResidencyFrameTarget { readonly session: DeviceSession
  /** Adaptive quality hook; absent or out-of-range values keep the fixed budget. */
  residencyBudgetScale?: () => number }

/** 刀 C 首帧归因:chunk 上传段级 mark(CPU 编译 / catalog / 驻留上传 / 帧装配)。 */
function markChunkPhase(name: string): void {
  const clock = (globalThis as unknown as { performance?: { mark(name: string): unknown } }).performance;
  if (typeof clock?.mark === "function") {
    clock.mark(`deep-webgpu:packet-${name}`);
  }
}
export interface AuthorChunkStreamDiagnostics {
  readonly path: "full-packet" | "scene-chunks";
  readonly reason: string;
  readonly chunkCount: number;
  readonly visibleChunks: number;
  readonly prefetchChunks: number;
  readonly derivedCpuBytes: number;
  readonly residentGpuBytes: number;
  readonly virtualPages: number;
  readonly virtualPageBytes: number;
  /** B4 簇级隐藏(有 cluster 计划的帧才携带)。 */
  readonly hlodHiddenInstances?: number;
  readonly hlodActiveProxies?: number;
  readonly hlodCollapsedNodes?: number;
}
interface CatalogOwner { readonly catalog: AuthorChunkCatalog; readonly residency: SceneChunkResidency; replaceRequired: boolean
  /** 已注册的簇代理 overlay 块(key = hlod-cluster:<instanceId>)。 */
  readonly proxies: Map<string, PreparedPacket>
  /** 上一接受帧的 visible demand 键(含代理块):这些块的租约仍被已发布帧持有。 */
  visibleKeys: Set<string> }
interface ClusterApplication {
  readonly demands: readonly SceneChunkResidencyDemand[];
  readonly updates: ReadonlyMap<string, PreparedBatch>;
  readonly hiddenInstances: number;
  readonly activeProxies: number;
  /** 本帧 visible demand 键;staging 成功后写回 owner.visibleKeys。 */
  readonly visibleKeys: ReadonlySet<string>;
}
const GPU_BYTES = 128 * 1024 * 1024;

/** One derived catalog per runtime; staged replacements never retire the last drawable catalog early. */
export class AuthorChunkStream {
  private active: CatalogOwner | undefined;
  private frame = 0;
  private closed = false;
  private pending: AbortController | undefined;
  private pendingWork: Promise<boolean> | undefined;
  private generation = 0;
  private compiledPacket: RenderPacket | undefined;
  private virtualSources = new Map<string, readonly string[]>();
  private virtualPageCount = 0;
  private virtualPageBytes = 0;
  private state: AuthorChunkStreamDiagnostics = { path: "full-packet", reason: "not-started", chunkCount: 0,
    visibleChunks: 0, prefetchChunks: 0, derivedCpuBytes: 0, residentGpuBytes: 0, virtualPages: 0, virtualPageBytes: 0 };
  constructor(private readonly runtime: AuthorChunkStreamRuntime, private readonly meshlets = false,
    private readonly clusterResources?: HlodClusterStreamResources) {}
  get diagnostics(): AuthorChunkStreamDiagnostics { return this.state; }
  get hasCatalog(): boolean { return this.active !== undefined; }
  sync(packet: RenderPacket, full: boolean, view: RenderView, signal?: AbortSignal,
    cluster?: HlodClusterFramePlan): Promise<boolean> {
    return this.enqueue((current) => this.execute(packet, full, view, current, cluster), signal);
  }
  /** Re-evaluate only the camera closure; do not recompile HLOD pages or repack every instance. */
  syncView(view: RenderView, signal?: AbortSignal, cluster?: HlodClusterFramePlan): Promise<boolean> {
    if (!this.active || !this.compiledPacket) return Promise.reject(new Error("Author chunk view requires a published catalog."));
    return this.enqueue((current) => this.executeView(view, current, cluster), signal);
  }
  private enqueue(work: (signal: AbortSignal) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error("Author chunk stream is disposed."));
    const generation = ++this.generation, previous = this.pendingWork;
    this.pending?.abort();
    const controller = new AbortController(); this.pending = controller;
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      controller.signal.throwIfAborted();
      if (generation !== this.generation || this.closed) throw new Error("Author chunk sync superseded.");
      return work(controller.signal);
    })().finally(() => { signal?.removeEventListener("abort", abort); if (this.pending === controller) this.pending = undefined; });
    this.pendingWork = pending; return pending;
  }
  fullPacketPublished(reason: string): void {
    const old = this.active; this.active = undefined; old?.residency.dispose();
    this.state = { path: "full-packet", reason, chunkCount: 0, visibleChunks: 0, prefetchChunks: 0,
      derivedCpuBytes: 0, residentGpuBytes: 0, virtualPages: 0, virtualPageBytes: 0 };
  }
  dispose(): void {
    if (this.closed) return; this.closed = true; this.generation++; this.pending?.abort();
    this.fullPacketPublished("disposed");
  }
  private async execute(packet: RenderPacket, full: boolean, view: RenderView, signal: AbortSignal,
    cluster?: HlodClusterFramePlan): Promise<boolean> {
    if (packet.deformation !== undefined || packet.instances.some(instance => instance.pose !== undefined)) return false;
    // The derived packet is GPU-only. Three remains authoritative for object identity,
    // picking, measurement and the full CPU geometry snapshot.
    const streamedPacket = this.streamPacket(packet, full);
    markChunkPhase("pages-compiled");
    const old = this.active, prior = old?.catalog.batchUpdates;
    let candidate: CatalogOwner | undefined;
    let staged = false;
    let applied: ClusterApplication | undefined;
    try {
      if (!old || old.replaceRequired || full || !old.catalog.update(streamedPacket)) candidate = this.create(streamedPacket);
      markChunkPhase("catalog-ready");
      const owner = candidate ?? old!;
      const demands = owner.catalog.demand(view);
      applied = cluster ? this.applyClusterPlan(owner, demands, cluster) : undefined;
      // 波次4 接线点（世界分区流送）：世界单元期望集由 threeBridge/worldStreamingBridge.ts
      // 的 decideWorldStreamingReplan → translateWorldChunkDemand → diffWorldChunkDesired
      // 生成，走独立的 SceneChunkResidency 实例，不进本 author catalog 域；本处全量
      // 期望集语义（省略即逐出）与世界单元一致，两种域禁止混用同一 residency。
      const frame = await owner.residency.update({ frame: ++this.frame,
        chunks: applied ? applied.demands : demands, signal });
      markChunkPhase("residency-uploaded");
      await stageSceneChunkFrame(this.runtime, frame, signal,
        applied ? applied.updates : owner.catalog.batchUpdates);
      markChunkPhase("chunk-frame-staged");
      staged = true;
      signal.throwIfAborted();
      if (applied) owner.visibleKeys = new Set(applied.visibleKeys);
      if (candidate) { this.active = candidate; old?.residency.dispose(); }
      this.state = Object.freeze({ path: "scene-chunks", reason: "static-author-batches;casters-required",
        chunkCount: owner.catalog.chunks.length,
        visibleChunks: (applied ? applied.demands : demands).filter(value => value.mode === "visible").length,
        prefetchChunks: (applied ? applied.demands : demands).filter(value => value.mode === "prefetch").length,
        derivedCpuBytes: owner.catalog.cpuBytes, residentGpuBytes: owner.residency.telemetrySnapshot().residentBytes,
        virtualPages: this.virtualPageCount, virtualPageBytes: this.virtualPageBytes,
        ...(applied ? { hlodHiddenInstances: applied.hiddenInstances, hlodActiveProxies: applied.activeProxies,
          hlodCollapsedNodes: cluster!.collapsedNodeCount } : {}) });
      return true;
    } catch (error) {
      failWithResourceCleanup(error, "Author chunk candidate failed.", [
        () => { if (staged) this.runtime.cancelResidentPacketStage(); },
        () => { if (candidate && candidate !== this.active) candidate.residency.dispose(); },
        () => { if (old && prior) {
        old.catalog.restoreBatchUpdates(prior);
        // A rejected draw may still leave eviction retirements leased by the last good frame.
        // Retry in a fresh domain; never release that visible frame just to unblock its planner.
        old.replaceRequired = true;
        } },
      ]);
    }
  }
  private async executeView(view: RenderView, signal: AbortSignal,
    cluster?: HlodClusterFramePlan): Promise<boolean> {
    const owner = this.active;
    if (!owner || owner.replaceRequired) throw new Error("Author chunk catalog must be rebuilt before a camera update.");
    const demands = owner.catalog.demand(view);
    let staged = false;
    let applied: ClusterApplication | undefined;
    try {
      applied = cluster ? this.applyClusterPlan(owner, demands, cluster) : undefined;
      const frame = await owner.residency.update({ frame: ++this.frame,
        chunks: applied ? applied.demands : demands, signal });
      await stageSceneChunkFrame(this.runtime, frame, signal,
        applied ? applied.updates : owner.catalog.batchUpdates);
      staged = true;
      signal.throwIfAborted();
      if (applied) owner.visibleKeys = new Set(applied.visibleKeys);
      this.state = Object.freeze({ ...this.state,
        visibleChunks: (applied ? applied.demands : demands).filter(value => value.mode === "visible").length,
        prefetchChunks: (applied ? applied.demands : demands).filter(value => value.mode === "prefetch").length,
        residentGpuBytes: owner.residency.telemetrySnapshot().residentBytes,
        ...(applied ? { hlodHiddenInstances: applied.hiddenInstances, hlodActiveProxies: applied.activeProxies,
          hlodCollapsedNodes: cluster!.collapsedNodeCount } : {}) });
      return true;
    } catch (error) {
      if (staged) this.runtime.cancelResidentPacketStage();
      // The planner can have retired old leases while the last displayed frame remains live.
      owner.replaceRequired = true;
      throw error;
    }
  }

  /**
   * B4 驻留感知簇应用:全隐藏块按阴影降级(prefetch,驻留不绘制)或省略(可逐出);
   * 混合块保留 demand 并以批数据行置零补偿隐藏实例(身份不变,批修订合同不破坏);
   * 活动代理按需注册 overlay 块并进入 visible demand,非活动代理省略即可逐出。
   *
   * 迁移帧合同(RenderLeaseLedger):同一 residency 帧内"逐出租约未释放的块"+"上传
   * 新块"会被拒绝(retained-before-upload)。凡本帧有新上传(恢复先前被逐出的块或
   * 激活新代理),上一帧可见但本帧被丢弃的块(簇隐藏省略、视锥收缩、代理失活)
   * 一律降级为 prefetch 推迟一帧;纯逐出帧(零上传)再完成显存回收,稳态不受影响。
   */
  private applyClusterPlan(owner: CatalogOwner, demands: readonly SceneChunkResidencyDemand[],
    plan: HlodClusterFramePlan): ClusterApplication {
    const chunkByKey = new Map(owner.catalog.chunks.map(chunk => [chunk.key, chunk]));
    const updates = new Map(owner.catalog.batchUpdates);
    const nextDemands: SceneChunkResidencyDemand[] = [];
    const visibleKeys = new Set<string>();
    const droppedDemands = new Map<string, SceneChunkResidencyDemand>();
    let hiddenInstances = 0;
    for (const demand of demands) {
      const chunk = chunkByKey.get(demand.key);
      if (!chunk) { nextDemands.push(demand); continue; }
      const ids = chunk.initial.instanceIds;
      const hidden = ids.filter(id => plan.hiddenInstanceIds.has(id));
      if (hidden.length === 0) { nextDemands.push(demand); continue; }
      hiddenInstances += hidden.length;
      const batch = owner.catalog.batchUpdates.get(chunk.initial.key) ?? chunk.initial;
      if (hidden.length === ids.length) {
        // 全隐藏:整块省略交由逐出。阴影由该簇的活动代理接管(代理批默认 castShadow),
        // 原块 caster 状态不再构成驻留理由。
        droppedDemands.set(demand.key, demand);
        continue;
      }
      const rows = new Map(ids.map((id, index) => [id, index]));
      const data = batch.data.slice();
      for (const id of hidden) {
        const row = rows.get(id)! * 36;
        for (let offset = 0; offset < 24; offset++) data[row + offset] = 0;
      }
      updates.set(batch.key, { ...batch, data });
      nextDemands.push(demand);
    }
    let activeProxies = 0;
    const proxyDemands = new Map<string, SceneChunkResidencyDemand>();
    for (const [instanceId, draw] of plan.activeProxyDraws) {
      activeProxies += 1;
      const key = `hlod-cluster:${instanceId}`;
      let prepared = owner.proxies.get(key);
      if (!prepared) {
        prepared = prepareRenderPacket(this.proxyPacket(draw));
        owner.residency.registerChunk(key, prepared);
        owner.proxies.set(key, prepared);
      }
      // 批修订合同要求投影内每个批都有同身份的 updates 条目;代理批一并入映射。
      updates.set(prepared.batches[0]!.key, prepared.batches[0]!);
      proxyDemands.set(key, { key, mode: "visible",
        demands: [{ batchKey: prepared.batches[0]!.key, priority: 1_000 }] });
    }
    nextDemands.push(...proxyDemands.values());
    // 迁移帧判定:本帧新上传(visible 且上一帧不可见)与租约丢弃(上一帧可见且本帧
    // 不在期望集:簇隐藏省略或视锥收缩)并存时,丢弃者降级 prefetch 推迟一帧。
    const currentVisible = new Set([...nextDemands.filter(demand => demand.mode === "visible").map(demand => demand.key)]);
    const uploadingNow = [...currentVisible].some(key => !owner.visibleKeys.has(key));
    if (uploadingNow) {
      for (const key of owner.visibleKeys) {
        if (currentVisible.has(key)) continue;
        const dropped = droppedDemands.get(key);
        const chunk = chunkByKey.get(key);
        if (dropped) nextDemands.push({ ...dropped, mode: "prefetch" });
        else if (chunk) {
          const batch = owner.catalog.batchUpdates.get(chunk.initial.key) ?? chunk.initial;
          nextDemands.push({ key, mode: "prefetch",
            demands: [{ batchKey: batch.key, priority: -100 }] });
        }
      }
      for (const [key, prepared] of owner.proxies) {
        if (proxyDemands.has(key) || !owner.visibleKeys.has(key) || currentVisible.has(key)) continue;
        nextDemands.push({ key, mode: "prefetch",
          demands: [{ batchKey: prepared.batches[0]!.key, priority: -100 }] });
      }
    }
    for (const demand of nextDemands) if (demand.mode === "visible") visibleKeys.add(demand.key);
    return { demands: nextDemands, updates, hiddenInstances, activeProxies, visibleKeys };
  }

  private proxyPacket(draw: HlodClusterProxyDraw): RenderPacket {
    const resources = this.clusterResources;
    if (!resources) throw new Error("HLOD cluster plan arrived without stream resources.");
    const geometry = resources.geometries.get(draw.geometryId);
    if (!geometry) throw new Error(`HLOD cluster proxy geometry is not distributed in the packet: ${draw.geometryId}`);
    const material = resources.materials.find(candidate => candidate.id === HLOD_PROXY_MATERIAL_ID);
    if (!material) throw new Error(`HLOD cluster proxy material ${HLOD_PROXY_MATERIAL_ID} is missing from the packet.`);
    return { geometries: [geometry], materials: [material],
      instances: [{ id: draw.instanceId, geometry: draw.geometryId, material: material.id,
        transform: [...draw.transform] }] };
  }
  private streamPacket(packet: RenderPacket, full: boolean): RenderPacket {
    if (full || !this.compiledPacket) {
      const paged = compileVirtualGeometryPages(packet);
      this.virtualSources = new Map(paged.sourceInstances);
      this.virtualPageCount = paged.pages.length;
      this.virtualPageBytes = paged.pages.reduce((sum, page) => sum + page.byteLength, 0);
      this.compiledPacket = compilePacketBoundsHlod(paged.packet, { spatialPartitions: 4 }).packet;
      return this.compiledPacket;
    }
    const compiled = new Map(this.compiledPacket.instances.map(instance => [instance.id, instance]));
    return Object.freeze({ ...packet, geometries: this.compiledPacket.geometries,
      instances: Object.freeze(packet.instances.flatMap(instance => {
        const ids = this.virtualSources.get(instance.id) ?? [instance.id];
        return ids.map(id => {
          const derived = compiled.get(id);
          if (derived === undefined) return instance;
          // Author LOD from the fresh packet is authoritative; a compiled HLOD screen-space
          // proxy (only ever on instances without author LOD) must survive the refresh.
          const lod = instance.lod ?? derived.lod;
          return Object.freeze({ ...instance, id, geometry: derived.geometry, ...(lod ? { lod } : {}) });
        });
      })) });
  }
  private create(packet: RenderPacket): CatalogOwner {
    const catalog = new AuthorChunkCatalog(packet);
    // Adaptive pressure lowers the ceiling for newly created catalogs; the live catalog still
    // sheds memory through visibility-driven eviction, not by shrinking under its residents.
    const scale = clampResidencyScale(this.runtime.residencyBudgetScale?.() ?? 1);
    const budgetBytes = Math.max(1, Math.floor(GPU_BYTES * scale));
    // Two catalog generations may overlap while the renderer owns the previous frame's leases.
    const residency = createSceneChunkResidency(this.runtime.session,
      { maxResidentBytes: budgetBytes, maxUploadBytesPerFrame: budgetBytes, retainFrames: 0 }, { meshlets: this.meshlets });
    try { for (const chunk of catalog.chunks) residency.registerChunk(chunk.key, chunk.packet); }
    // 波次4 接线点：`world|<cx>|<cz>|lodN` 键的世界单元 chunk 不在此注册（其生命周期
    // 跟随相机位姿而非 RenderPacket sync）；注册路径见 threeBridge/worldStreamingBridge.ts 顶部合同。
    catch (error) { residency.dispose(); throw error; }
    return { catalog, residency, replaceRequired: false, proxies: new Map(), visibleKeys: new Set<string>() };
  }
}

function clampResidencyScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.5, value));
}

export const clampAuthorChunkResidencyScale = clampResidencyScale;
