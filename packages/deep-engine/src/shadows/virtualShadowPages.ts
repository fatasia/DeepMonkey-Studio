import { VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_GRID, pageOf, projectToRing,
  type VirtualShadowClipmapPlan, type VirtualShadowRing } from "./virtualShadowClipmap.js";

/**
 * B1 Brief-VSM 页表驻留 + 投影误差 Top-K 物化(CPU 确定性策略,零运行时依赖)。
 *
 * - 物理页池:2048² × 4 atlas 层 × 16×16 页槽(页 128²)= 1024 槽;slot = layer·256 + ty·16 + tx
 *   (GPU 页表 layers 数组直接存打包 slot,采样端解码,合同见 webgpu/virtualShadowSampling.ts);
 * - 请求:可见对象按环投影 → 期望 mip(期望世界 texel / 环 texel)+ 页坐标;
 *   误差 = 对象屏幕像素面积(主视投影,同一 F4 反馈代理口径)聚合到页;
 * - 排序:动态失效页最优先,其后按误差降序、稳定 id 序;Top-K 截断受双预算
 *   (maxPagesPerFrame = 光空间剔除相位槽 0..7,maxCostMs 估算模型)约束;
 * - 版本号:静态页版本 = (sceneRevision, 计划签名) 驻留缓存;动态页每动态纪元版本 +1;
 * - 顶 mip(单页/环)钉住驻留 ⇒ 采样回退链(环内粗 mip → 上一环)恒有叶,零洞。
 */

export const VIRTUAL_SHADOW_ATLAS_EDGE = 2048;
export const VIRTUAL_SHADOW_ATLAS_LAYERS = 4;
export const VIRTUAL_SHADOW_ATLAS_TILES = VIRTUAL_SHADOW_ATLAS_EDGE / 128;
export const VIRTUAL_SHADOW_PHYSICAL_PAGES = VIRTUAL_SHADOW_ATLAS_LAYERS * VIRTUAL_SHADOW_ATLAS_TILES ** 2;
/** 每帧物化页上限:光空间剔除相位键(shadow:0..7)只有 8 槽。 */
export const VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME = 8;

export interface VirtualShadowObjectInput {
  /** 世界包围球心。 */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 世界包围半径(> 0)。 */
  readonly radius: number;
  /** 主视屏幕像素面积 × 实例数(误差权重,同 F4 反馈代理口径)。 */
  readonly screenPixels: number;
  /** 期望世界 texel 尺寸(主视每像素世界尺寸;0 = 全部落在最粗 mip)。 */
  readonly desiredWorldTexel: number;
}

export interface VirtualShadowDynamicInput {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export interface VirtualShadowPageRequest {
  readonly ring: number;
  readonly mip: number;
  readonly tileX: number;
  readonly tileY: number;
  /** 聚合屏幕像素误差(降序优先)。 */
  readonly error: number;
  readonly dynamic: boolean;
  readonly id: string;
}

export interface VirtualShadowPageSlot {
  readonly layer: number;
  readonly tileX: number;
  readonly tileY: number;
  /** GPU 页表打包值(layer·256 + ty·16 + tx;-1 = 缺页哨兵同型)。 */
  readonly packed: number;
}

export interface VirtualShadowResidentPage {
  readonly id: string;
  readonly ring: number;
  readonly mip: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly slot: VirtualShadowPageSlot;
  readonly lastUsedFrame: number;
  readonly version: number;
  readonly dynamic: boolean;
  readonly pinned: boolean;
}

export interface VirtualShadowMaterializeBudget {
  readonly maxPagesPerFrame?: number;
  /** 单页物化估算毫秒(校准值;超预算按误差截断)。 */
  readonly perPageCostMs?: number;
  readonly frameBudgetMs?: number;
}

export interface VirtualShadowMaterializeStats {
  readonly frame: number;
  readonly requestPages: number;
  readonly materializedPages: number;
  readonly deferredByBudget: number;
  readonly dynamicInvalidated: number;
  readonly residentPages: number;
  readonly evictedPages: number;
  readonly estimatedCostMs: number;
  readonly budgetUtilization: number;
}

export interface VirtualShadowMaterializePlan {
  /** 本帧要重绘的页(排序后 Top-K,绘制顺序 = 数组序 = 剔除槽 0..7)。 */
  readonly renderPages: readonly VirtualShadowResidentPage[];
  readonly resident: readonly VirtualShadowResidentPage[];
  readonly stats: VirtualShadowMaterializeStats;
}

interface ResidentEntry {
  page: VirtualShadowResidentPage;
  slot: VirtualShadowPageSlot | undefined;
}

export function virtualShadowPageId(ring: number, mip: number, tileX: number, tileY: number): string {
  return `r${ring}|m${mip}|${tileX}|${tileY}`;
}

/** 期望 mip:期望世界 texel 相对本环 texel 的对数(clamp 到链内)。 */
export function desiredMip(ring: VirtualShadowRing, desiredWorldTexel: number): number {
  if (!(desiredWorldTexel > 0)) return VIRTUAL_SHADOW_MIP_COUNT - 1;
  const ratio = desiredWorldTexel / ring.texelWorldSize;
  return Math.min(VIRTUAL_SHADOW_MIP_COUNT - 1, Math.max(0, Math.round(Math.log2(ratio))));
}

export interface VirtualShadowPageTableOptions {
  readonly physicalPages?: number;
  /** 页平均成本估算的保守默认(校准前 0.08ms/页;真机回读后可覆写)。 */
  readonly perPageCostMs?: number;
}

/**
 * 帧驱动虚拟阴影页表:确定性、双预算硬截断、LRU 逐出(钉住顶 mip 除外)、
 * 动态页掩码局部失效。物理槽分配 = 空闲栈(LIFO),逐出页立即归还。
 */
export class VirtualShadowPageTable {
  private readonly resident = new Map<string, ResidentEntry>();
  private readonly freeSlots: number[] = [];
  private readonly pinned = new Set<string>();
  private dynamicDirty = new Set<string>();
  private requestedThisFrame = new Set<string>();
  private dynamicEpoch = 0;
  private sceneRevision = -1;
  private planSignature = "";
  private disposed = false;

  constructor(private readonly physicalPages = VIRTUAL_SHADOW_PHYSICAL_PAGES,
    private readonly perPageCostMs = 0.08) {
    if (!Number.isSafeInteger(physicalPages) || physicalPages < VIRTUAL_SHADOW_MIP_COUNT
      || physicalPages > VIRTUAL_SHADOW_PHYSICAL_PAGES) {
      throw new RangeError(`Virtual shadow physical pages must be within ${VIRTUAL_SHADOW_MIP_COUNT}..${VIRTUAL_SHADOW_PHYSICAL_PAGES}.`);
    }
    if (!Number.isFinite(perPageCostMs) || perPageCostMs <= 0) throw new RangeError("Virtual shadow per-page cost must be positive.");
    for (let slot = physicalPages - 1; slot >= 0; slot--) this.freeSlots.push(slot);
  }

  get residentCount(): number { return this.resident.size; }
  get freeSlotCount(): number { return this.freeSlots.length; }
  get dynamicInvalidationEpoch(): number { return this.dynamicEpoch; }

  /**
   * 动态物体页掩码:动态包围球投影到各环 mip 0..3(动态细节所在细 mip 层,页邻域
   * 半径按 2 tile 封顶),命中驻留页标记失效。每帧调用一次;失效页在下一帧 plan()
   * 里以最高优先级重绘(阴影延迟 ≤1 帧)。mip 4..7(粗层)由顶 mip 钉住链覆盖。
   */
  invalidateDynamic(objects: readonly VirtualShadowDynamicInput[], plan: VirtualShadowClipmapPlan): number {
    this.assertAlive();
    if (!Array.isArray(objects)) throw new TypeError("Dynamic shadow objects must be an array.");
    const touched = new Set<string>();
    for (const object of objects) {
      validateDynamicObject(object);
      for (const ring of plan.rings) {
        for (let mip = 0; mip <= Math.min(3, VIRTUAL_SHADOW_MIP_COUNT - 1); mip++) {
          const projected = projectToRing(ring, [object.x, object.y, object.z]);
          if (projected.u < 0 || projected.v < 0) continue;
          const inflated = inflateToGrid(ring, mip, projected.u, projected.v,
            object.radius / ring.texelWorldSize, 2);
          for (const tile of inflated) {
            const id = virtualShadowPageId(ring.index, mip, tile.tileX, tile.tileY);
            if (this.resident.has(id) && !this.pinned.has(id)) touched.add(id);
          }
        }
      }
    }
    if (touched.size === 0) return 0;
    this.dynamicDirty = touched;
    this.dynamicEpoch += 1;
    return touched.size;
  }

  /**
   * Top-K 物化规划:请求 → 动态优先 + 误差降序 → 双预算截断 → 驻留分配。
   * 页内容世界对齐(锚点吸附页格),静态页版本 = sceneRevision:
   * 场景与光照计划不变 ⇒ 驻留页零重绘;变化 ⇒ 全量重验(误差序逐帧收敛)。
   */
  plan(plan: VirtualShadowClipmapPlan, objects: readonly VirtualShadowObjectInput[],
    frame: number, sceneRevision: number, budget: VirtualShadowMaterializeBudget = {}):
      VirtualShadowMaterializePlan {
    this.assertAlive();
    if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("Frame index must be a non-negative safe integer.");
    if (!Number.isSafeInteger(sceneRevision) || sceneRevision < 0) throw new RangeError("Scene revision must be a non-negative safe integer.");
    const signature = planSignatureOf(plan);
    const contentStable = sceneRevision === this.sceneRevision && signature === this.planSignature;
    this.sceneRevision = sceneRevision;
    this.planSignature = signature;
    // 1) 请求聚合:可见对象按环投影 → 期望 mip 页,误差 = 屏幕像素面积累加。
    const errors = new Map<string, number>();
    const requestOf = new Map<string, VirtualShadowPageRequest>();
    for (const object of objects) {
      validateObject(object);
      for (const ring of plan.rings) {
        const projected = projectToRing(ring, [object.x, object.y, object.z]);
        if (projected.u < 0 || projected.v < 0 || projected.u > 1 || projected.v > 1) continue;
        const mip = desiredMip(ring, object.desiredWorldTexel);
        const tile = pageOf(ring, mip, projected.u, projected.v);
        if (!tile) continue;
        const id = virtualShadowPageId(ring.index, mip, tile.tileX, tile.tileY);
        errors.set(id, (errors.get(id) ?? 0) + Math.max(0, object.screenPixels));
        if (!requestOf.has(id)) {
          requestOf.set(id, Object.freeze({ ring: ring.index, mip, tileX: tile.tileX, tileY: tile.tileY,
            error: 0, dynamic: false, id }));
        }
      }
    }
    // 2) 顶 mip 单页/环:恒请求 + 钉住(零洞回退叶)。
    for (const ring of plan.rings) {
      const id = virtualShadowPageId(ring.index, VIRTUAL_SHADOW_MIP_COUNT - 1, 0, 0);
      this.pinned.add(id);
      if (!requestOf.has(id)) {
        requestOf.set(id, Object.freeze({ ring: ring.index, mip: VIRTUAL_SHADOW_MIP_COUNT - 1,
          tileX: 0, tileY: 0, error: 0, dynamic: false, id }));
      }
    }
    // 3) 动态失效掩码:失效驻留页并入请求(最高优先级)。
    const dynamics = new Set<string>();
    for (const id of this.dynamicDirty) {
      const entry = this.resident.get(id);
      if (!entry || entry.page.pinned) continue;
      if (!requestOf.has(id)) {
        const page = entry.page;
        requestOf.set(id, Object.freeze({ ring: page.ring, mip: page.mip, tileX: page.tileX,
          tileY: page.tileY, error: 0, dynamic: true, id }));
      }
      dynamics.add(id);
    }
    // 4) 需重绘集:未驻留 ∪ 动态失效 ∪ 内容版本过期(静态版本 = sceneRevision)。
    const needRender = new Set<string>();
    for (const id of requestOf.keys()) {
      const entry = this.resident.get(id);
      if (!entry || dynamics.has(id) || !contentStable || entry.page.version !== sceneRevision) needRender.add(id);
    }
    // 5) 双预算截断 + 驻留分配。
    const maxPages = Math.min(budget.maxPagesPerFrame ?? VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME,
      VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME);
    const frameBudgetMs = budget.frameBudgetMs ?? 2.5;
    const perPage = budget.perPageCostMs ?? this.perPageCostMs;
    const candidates = [...needRender].map(id => requestOf.get(id)!)
      .sort((left, right) => rank(left, right, dynamics, this.pinned, errors));
    const renderPages: VirtualShadowResidentPage[] = [];
    let evicted = 0;
    let deferredByBudget = 0;
    let estimatedMs = 0;
    for (const request of candidates) {
      if (renderPages.length >= maxPages || estimatedMs + perPage > frameBudgetMs) {
        deferredByBudget += 1;
        continue;
      }
      const entry = this.resident.get(request.id);
      let slot = entry?.slot ?? this.allocateSlot();
      if (!slot) {
        if (this.evictOneLru(frame)) { evicted += 1; slot = this.allocateSlot(); }
        if (!slot) { deferredByBudget += 1; continue; }
      }
      const page: VirtualShadowResidentPage = Object.freeze({
        id: request.id, ring: request.ring, mip: request.mip, tileX: request.tileX, tileY: request.tileY,
        slot, lastUsedFrame: frame,
        version: dynamics.has(request.id) ? this.dynamicEpoch : sceneRevision,
        dynamic: dynamics.has(request.id), pinned: this.pinned.has(request.id),
      });
      if (entry) this.releaseSlot(entry.slot);
      this.resident.set(request.id, { page, slot });
      renderPages.push(page);
      estimatedMs += perPage;
    }
    // 6) 触碰驻留页时间戳(请求命中),未请求非钉住页 LRU 逐出。
    for (const id of requestOf.keys()) {
      const entry = this.resident.get(id);
      if (entry && !needRender.has(id)) entry.page = { ...entry.page, lastUsedFrame: frame };
    }
    evicted += this.evictUnrequested(frame);
    this.dynamicDirty = new Set();
    this.requestedThisFrame = new Set(requestOf.keys());
    const resident = [...this.resident.values()].map(entry => entry.page)
      .sort((left, right) => left.id.localeCompare(right.id));
    const stats: VirtualShadowMaterializeStats = Object.freeze({
      frame, requestPages: requestOf.size, materializedPages: renderPages.length,
      deferredByBudget, dynamicInvalidated: dynamics.size, residentPages: resident.length,
      evictedPages: evicted, estimatedCostMs: estimatedMs,
      budgetUtilization: frameBudgetMs > 0 ? estimatedMs / frameBudgetMs : 0,
    });
    return Object.freeze({ renderPages: Object.freeze(renderPages), resident, stats });
  }

  /** 版本查询(物化去重/诊断用);未驻留 = -1。 */
  versionOf(id: string): number {
    return this.resident.get(id)?.page.version ?? -1;
  }

  slotOf(id: string): VirtualShadowPageSlot | undefined {
    return this.resident.get(id)?.slot;
  }

  invalidate(): void {
    this.assertAlive();
    for (const [id, entry] of [...this.resident.entries()]) {
      if (this.pinned.has(id)) continue;
      this.releaseSlot(entry.slot);
      this.resident.delete(id);
    }
    this.sceneRevision = -1;
    this.planSignature = "";
  }

  dispose(): void {
    this.assertAlive();
    this.resident.clear();
    this.freeSlots.length = 0;
    this.pinned.clear();
    this.dynamicDirty.clear();
    this.disposed = true;
  }

  private evictUnrequested(frame: number): number {
    let evicted = 0;
    for (const [id, entry] of [...this.resident.entries()]) {
      if (this.pinned.has(id) || this.requestedThisFrame.has(id)) continue;
      if (entry.page.lastUsedFrame >= frame) continue;
      this.releaseSlot(entry.slot);
      this.resident.delete(id);
      evicted += 1;
    }
    return evicted;
  }

  private evictOneLru(frame: number): boolean {
    const victim = [...this.resident.entries()]
      .filter(([id, entry]) => !this.pinned.has(id) && entry.page.lastUsedFrame < frame
        && !this.requestedThisFrame.has(id))
      .sort(([, left], [, right]) => left.page.lastUsedFrame - right.page.lastUsedFrame)[0];
    if (!victim) return false;
    this.releaseSlot(victim[1].slot);
    this.resident.delete(victim[0]);
    return true;
  }

  private allocateSlot(): VirtualShadowPageSlot | undefined {
    const slot = this.freeSlots.pop();
    if (slot === undefined) return undefined;
    return Object.freeze({ layer: Math.floor(slot / VIRTUAL_SHADOW_ATLAS_TILES ** 2),
      tileY: Math.floor(slot / VIRTUAL_SHADOW_ATLAS_TILES) % VIRTUAL_SHADOW_ATLAS_TILES,
      tileX: slot % VIRTUAL_SHADOW_ATLAS_TILES,
      packed: slot });
  }

  private releaseSlot(slot: VirtualShadowPageSlot | undefined): void {
    if (slot) this.freeSlots.push(slot.packed);
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Virtual shadow page table is disposed.");
  }
}

/** 环内膨胀投影:动态包围球可能跨页,按半径(单位 texel)展开邻接页集合(span 封顶防炸)。 */
function inflateToGrid(ring: VirtualShadowRing, mip: number, u: number, v: number,
  radiusTexels: number, spanCap = Number.POSITIVE_INFINITY): readonly { readonly tileX: number; readonly tileY: number }[] {
  const grid = VIRTUAL_SHADOW_PAGE_GRID >> mip;
  const center = pageOf(ring, mip, u, v);
  if (!center) return [];
  const span = Math.min(grid, spanCap, Math.max(1, Math.ceil(radiusTexels * grid / 2)));
  const tiles: { tileX: number; tileY: number }[] = [];
  for (let tileY = Math.max(0, center.tileY - span); tileY <= Math.min(grid - 1, center.tileY + span); tileY++) {
    for (let tileX = Math.max(0, center.tileX - span); tileX <= Math.min(grid - 1, center.tileX + span); tileX++) {
      tiles.push({ tileX, tileY });
    }
  }
  return tiles;
}

function planSignatureOf(plan: VirtualShadowClipmapPlan): string {
  // 锚点移动是良性的(页世界对齐),签名只含会迁移页内容的量:环几何 + 光基向 + 阴影距离。
  return plan.rings.map(ring => ring.halfExtent.toFixed(4)).join("|")
    + `@${plan.lightDirection.map(value => value.toFixed(6)).join(",")}`
    + `#${plan.maxShadowDistance.toFixed(3)}`;
}

/** 排序:动态失效 > 钉住(零洞叶)> 误差降序 > 稳定 id(确定性,同帧同输入同序)。 */
function rank(left: VirtualShadowPageRequest, right: VirtualShadowPageRequest,
  dynamics: ReadonlySet<string>, pinned: ReadonlySet<string>, errors: ReadonlyMap<string, number>): number {
  const tier = (id: string): number => dynamics.has(id) ? 0 : pinned.has(id) ? 1 : 2;
  const leftTier = tier(left.id), rightTier = tier(right.id);
  if (leftTier !== rightTier) return leftTier - rightTier;
  const leftError = errors.get(left.id) ?? 0, rightError = errors.get(right.id) ?? 0;
  if (leftError !== rightError) return rightError - leftError;
  return left.id.localeCompare(right.id);
}

function validateObject(object: VirtualShadowObjectInput): void {
  if (!object || typeof object !== "object") throw new TypeError("Virtual shadow object must be an object.");
  if (![object.x, object.y, object.z, object.radius].every(value => Number.isFinite(value))) {
    throw new RangeError("Virtual shadow object bounds must be finite.");
  }
  if (!(object.radius > 0)) throw new RangeError("Virtual shadow object radius must be positive.");
  if (!Number.isFinite(object.screenPixels) || object.screenPixels < 0) {
    throw new RangeError("Virtual shadow object screenPixels must be a non-negative finite number.");
  }
  if (!Number.isFinite(object.desiredWorldTexel) || object.desiredWorldTexel < 0) {
    throw new RangeError("Virtual shadow object desiredWorldTexel must be a non-negative finite number.");
  }
}

function validateDynamicObject(object: VirtualShadowDynamicInput): void {
  if (!object || typeof object !== "object") throw new TypeError("Virtual shadow dynamic object must be an object.");
  if (![object.x, object.y, object.z, object.radius].every(value => Number.isFinite(value)) || !(object.radius > 0)) {
    throw new RangeError("Virtual shadow dynamic bounds must be finite with positive radius.");
  }
}
