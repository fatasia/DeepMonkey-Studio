import type { VirtualGeometryDagPage, VirtualGeometryDagPageTable } from "./virtualGeometryDagPages.js";

/**
 * Nanite M3 —— DAG 页驻留表(F3 virtualTexturePageTable 同构,几何域)。
 *
 * 硬字节预算;准入粗层优先(祖先链前缀不变量:驻留页的每层祖先必须已驻留,
 * 绘制页在流送中永远有可渲染回退)。重claim 是压力驱动 LRU:候选 = 本帧未请求、
 * 非 in-flight、最久未见(lastUsedFrame 最小)且已过 dwell;细层先于粗层淘汰
 * (丢细层只是画质渐变,逐粗层父页会级联带走全部驻留后代)。准入 in-flight
 * 到 commit 才可用;取消回滚不泄引用;先校验后变更(事务性)。冻结相机下
 * 请求集不变 ⇒ 零驱逐零准入(按构造零抖动)。
 */

/** dwell 驻留保护上限(与 F3 同值):超限视为误配置。 */
export const DEEP_VIRTUAL_GEOMETRY_MAX_DWELL_FRAMES = 4096;

export interface VirtualGeometryResidencyBudget {
  /** 驻留页字节总预算(硬上限)。 */
  readonly maxBytes: number;
  /** 页数上限(可选,与字节预算同时生效)。 */
  readonly maxPages?: number;
  /** 驻留保护:页准入后至少驻留这么多帧才可被压力驱逐。 */
  readonly minResidentFrames?: number;
}

export interface VirtualGeometryResidencyHandle {
  readonly id: string;
  readonly level: number;
  readonly cluster: number;
  readonly costBytes: number;
  readonly lastUsedFrame: number;
  readonly admittedFrame: number;
  readonly inflight: boolean;
}

export interface VirtualGeometryResidencyStats {
  readonly frame: number;
  readonly requestCount: number;
  readonly residentCount: number;
  readonly inflightCount: number;
  readonly residentBytes: number;
  readonly budgetBytes: number;
  readonly admittedCount: number;
  readonly evictedCount: number;
  readonly deferredCount: number;
  readonly budgetUtilization: number;
}

export interface VirtualGeometryResidencyPlan {
  readonly frame: number;
  readonly admitted: readonly VirtualGeometryResidencyHandle[];
  readonly evicted: readonly VirtualGeometryResidencyHandle[];
  readonly deferred: readonly string[];
  readonly resident: readonly VirtualGeometryResidencyHandle[];
  readonly stats: VirtualGeometryResidencyStats;
}

interface ResidentEntry {
  readonly page: VirtualGeometryDagPage;
  lastUsedFrame: number;
  readonly admittedFrame: number;
  inflight: boolean;
}

export class VirtualGeometryDagResidency {
  private readonly resident = new Map<string, ResidentEntry>();
  private residentBytes = 0;
  private readonly minResidentFrames: number;
  private readonly table: VirtualGeometryDagPageTable;
  private readonly budget: VirtualGeometryResidencyBudget;

  // 显式字段赋值而非构造器参数属性:能力自检对拍网(scripts/rendererCapabilityManifest.test.mjs)
  // 经 node strip-only 模式加载本模块,参数属性语法不受支持(实测踩坑)。
  constructor(table: VirtualGeometryDagPageTable, budget: VirtualGeometryResidencyBudget) {
    this.table = table;
    this.budget = budget;
    if (!Number.isSafeInteger(budget.maxBytes) || budget.maxBytes < 1) {
      throw new RangeError("Virtual geometry residency maxBytes must be a positive safe integer.");
    }
    if (budget.maxPages !== undefined && (!Number.isSafeInteger(budget.maxPages) || budget.maxPages < 1)) {
      throw new RangeError("Virtual geometry residency maxPages must be a positive safe integer.");
    }
    const dwell = budget.minResidentFrames ?? 0;
    if (!Number.isSafeInteger(dwell) || dwell < 0 || dwell > DEEP_VIRTUAL_GEOMETRY_MAX_DWELL_FRAMES) {
      throw new RangeError(
        `Virtual geometry minResidentFrames must be a safe integer from 0 through ${DEEP_VIRTUAL_GEOMETRY_MAX_DWELL_FRAMES}.`);
    }
    this.minResidentFrames = dwell;
  }

  get residentCount(): number { return this.resident.size; }
  get residentByteCount(): number { return this.residentBytes; }
  get inflightCount(): number { return [...this.resident.values()].filter((entry) => entry.inflight).length; }

  /**
   * 帧驱动调度:粗层优先准入(level 降序,同级绘制页优先、id 序),祖先链不齐则
   * defer(父页先行流送);预算不足时按 LRU 驱逐本帧未请求页腾位,腾不出则 defer。
   */
  plan(requestedPageIds: readonly string[], frame: number): VirtualGeometryResidencyPlan {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new RangeError("Virtual geometry residency frame must be a non-negative safe integer.");
    }
    const requested = new Set<string>();
    for (const id of requestedPageIds) {
      if (!this.table.byId.has(id)) throw new Error(`Unknown virtual geometry page request: ${id}.`);
      requested.add(id);
    }
    const uniqueIds = [...requested];
    const admitted: VirtualGeometryResidencyHandle[] = [];
    const evicted: VirtualGeometryResidencyHandle[] = [];
    const deferred: string[] = [];
    const chainAdmitted = new Set<string>();

    // 准入优先级:无父根页(含 M2 哨兵孤儿——无更粗回退、不可替代)最先;
    // 其余粗层优先(level 降序,父先于子满足链前缀),同级 id 序稳定。
    const candidates = uniqueIds
      .map((id) => this.table.byId.get(id)!)
      .sort((left, right) => ((left.parentId === null ? 0 : 1) - (right.parentId === null ? 0 : 1))
        || right.level - left.level || left.id.localeCompare(right.id));
    for (const page of candidates) {
      const entry = this.resident.get(page.id);
      if (entry) { entry.lastUsedFrame = frame; chainAdmitted.add(page.id); continue; }
      if (!this.ancestorsResident(page, chainAdmitted)) { deferred.push(page.id); continue; }
      if (this.fits(page)) {
        this.admit(page, frame); admitted.push(this.handle(this.resident.get(page.id)!)); chainAdmitted.add(page.id); continue;
      }
      if (this.evictUntilFits(page, requested, frame, evicted) && this.fits(page)) {
        this.admit(page, frame); admitted.push(this.handle(this.resident.get(page.id)!)); chainAdmitted.add(page.id);
      } else deferred.push(page.id);
    }

    const resident = [...this.resident.values()].map((entry) => this.handle(entry))
      .sort((left, right) => left.id.localeCompare(right.id));
    const stats: VirtualGeometryResidencyStats = Object.freeze({
      frame, requestCount: requested.size, residentCount: resident.length,
      inflightCount: this.inflightCount, residentBytes: this.residentBytes, budgetBytes: this.budget.maxBytes,
      admittedCount: admitted.length, evictedCount: evicted.length, deferredCount: deferred.length,
      budgetUtilization: this.residentBytes / this.budget.maxBytes,
    });
    return Object.freeze({ frame, admitted: Object.freeze(admitted), evicted: Object.freeze(evicted),
      deferred: Object.freeze(deferred), resident, stats });
  }

  /** 上传完成页转可用;提交后须全链祖先已提交(in-flight 不可采样/绘制)。 */
  commitAdmissions(ids: readonly string[]): void {
    this.transition(ids, (entry) => ({ ...entry, inflight: false }), "committed");
  }

  /** 取消上传回滚;已提交页拒绝回滚(边界已过,同 F3)。 */
  rollbackAdmissions(ids: readonly string[]): void {
    this.transition(ids, (entry) => {
      if (!entry.inflight) throw new Error(`Virtual geometry page ${entry.page.id} is committed and cannot be rolled back.`);
      return undefined;
    }, "resident");
  }

  /** 整资产卸载(T11 生成失效同型):任一 in-flight 即拒绝。 */
  evictAll(): readonly VirtualGeometryResidencyHandle[] {
    const evicted = [...this.resident.values()].map((entry) => this.handle(entry));
    for (const entry of this.resident.values()) {
      if (entry.inflight) throw new Error(`Virtual geometry page ${entry.page.id} is in-flight and cannot be evicted.`);
    }
    this.residentBytes = 0;
    this.resident.clear();
    return Object.freeze(evicted);
  }

  private admit(page: VirtualGeometryDagPage, frame: number): void {
    this.resident.set(page.id, { page, lastUsedFrame: frame, admittedFrame: frame, inflight: true });
    this.residentBytes += page.byteLength;
  }

  private fits(page: VirtualGeometryDagPage): boolean {
    if (this.residentBytes + page.byteLength > this.budget.maxBytes) return false;
    return this.budget.maxPages === undefined || this.resident.size + 1 <= this.budget.maxPages;
  }

  private ancestorsResident(page: VirtualGeometryDagPage, chainAdmitted: ReadonlySet<string>): boolean {
    let cursor = page.parentId;
    while (cursor) {
      if (!this.resident.has(cursor) && !chainAdmitted.has(cursor)) return false;
      cursor = this.table.byId.get(cursor)?.parentId ?? null;
    }
    return true;
  }

  /** LRU(最久未见)驱逐至腾出 costBytes;本帧请求页与非 in-flight 保护不逐。 */
  private evictUntilFits(page: VirtualGeometryDagPage, requested: ReadonlySet<string>, frame: number,
    evicted: VirtualGeometryResidencyHandle[]): boolean {
    const evictable = [...this.resident.entries()]
      .filter(([, entry]) => !requested.has(entry.page.id) && !entry.inflight
        && entry.lastUsedFrame < frame && frame - entry.admittedFrame >= this.minResidentFrames)
      .sort((left, right) => left[1].lastUsedFrame - right[1].lastUsedFrame
        || left[1].page.level - right[1].page.level || left[0].localeCompare(right[0]));
    while (evictable.length > 0 && !this.fits(page)) {
      const [, victim] = evictable.shift()!;
      this.dropCascade(victim.page.id, evicted);
    }
    return this.fits(page);
  }

  /** 驱逐一页并级联驱逐其全部驻留后代(粗层是细层的唯一回退,断链不可渲染)。 */
  private dropCascade(id: string, evicted: VirtualGeometryResidencyHandle[]): void {
    const entry = this.resident.get(id);
    if (!entry) return;
    for (const resident of [...this.resident.values()]) {
      if (resident.page.id === id || this.hasAncestor(resident.page, id)) {
        evicted.push(this.handle(resident));
        this.residentBytes -= resident.page.byteLength;
        this.resident.delete(resident.page.id);
      }
    }
  }

  private hasAncestor(page: VirtualGeometryDagPage, ancestorId: string): boolean {
    let cursor = page.parentId;
    while (cursor) {
      if (cursor === ancestorId) return true;
      cursor = this.table.byId.get(cursor)?.parentId ?? null;
    }
    return false;
  }

  private transition(ids: readonly string[], map: (entry: ResidentEntry) => ResidentEntry | undefined,
    mode: "resident" | "committed"): void {
    if (!Array.isArray(ids)) throw new TypeError("Virtual geometry residency ids must be an array.");
    const unique = [...new Set(ids)];
    for (const id of unique) {
      if (!this.resident.has(id)) throw new Error(`Unknown virtual geometry page: ${id}.`);
    }
    const next = new Map(this.resident);
    for (const id of unique) {
      const mapped = map(next.get(id)!);
      if (mapped) next.set(id, mapped); else next.delete(id);
    }
    this.assertPrefixInvariant(next);
    if (mode === "committed") this.assertCommittedPrefix(next);
    this.resident.clear();
    let bytes = 0;
    for (const [id, entry] of next) { this.resident.set(id, entry); bytes += entry.page.byteLength; }
    this.residentBytes = bytes;
  }

  private assertPrefixInvariant(resident: ReadonlyMap<string, ResidentEntry>): void {
    for (const entry of resident.values()) {
      let cursor = entry.page.parentId;
      while (cursor) {
        if (!resident.has(cursor)) {
          throw new Error(`Virtual geometry ancestor-prefix invariant violated for ${entry.page.id}.`);
        }
        cursor = this.table.byId.get(cursor)?.parentId ?? null;
      }
    }
  }

  /** 已提交(可绘制)页的祖先必须全部已提交:in-flight 粗层不构成合法回退。 */
  private assertCommittedPrefix(resident: ReadonlyMap<string, ResidentEntry>): void {
    for (const entry of resident.values()) {
      if (entry.inflight) continue;
      let cursor = entry.page.parentId;
      while (cursor) {
        const ancestor = resident.get(cursor);
        if (!ancestor || ancestor.inflight) {
          throw new Error(`Virtual geometry committed-prefix invariant violated for ${entry.page.id}.`);
        }
        cursor = this.table.byId.get(cursor)?.parentId ?? null;
      }
    }
  }

  private handle(entry: ResidentEntry): VirtualGeometryResidencyHandle {
    return Object.freeze({ id: entry.page.id, level: entry.page.level, cluster: entry.page.cluster,
      costBytes: entry.page.byteLength, lastUsedFrame: entry.lastUsedFrame,
      admittedFrame: entry.admittedFrame, inflight: entry.inflight });
  }
}
