import { RUNTIME_IBL_MAX_BYTES, type RuntimePrefilteredIbl } from "../runtimePackage/environmentTypes.js";

/**
 * I-C19 动态 IBL：环境包热替换的失效/预算/回收状态机（纯 CPU，零 GPU import）。
 *
 * 失效语义：失效粒度恒为全量（RuntimePrefilteredIbl 是原子单元）；分 mip 只发生在
 * 驻留预算降级（链头截断重定基）；光源大改是显式非触发（split-sum IBL 与光源无关）。
 * 预算对象 = active + pending + 共享 LUT 的解码驻留字节（rgba16float 口径与
 * validateRuntimePrefilteredIbl 一致）。pending 单槽、最新优先即 LRU（新世代入位前先回滚
 * 旧 pending，故预算判定只对 active 稳态）；跨环境缓存被 I-C15 排除，唯一跨世代资产是
 * BRDF LUT（环境无关的纯数学积分，宽高与 base64 全等时免重传、随世代移交共享槽）。
 */

/** IBL 身份三元组：任一变化即全量失效（环境包替换 / 作者换 HDR 源）。 */
export interface DynamicIblIdentity { readonly id: string; readonly revision: number; readonly contentHash: string }

export type DynamicIblInvalidation = "initial" | "identity" | "unchanged";
export type DynamicIblDisposition = "accept" | "accept-degraded" | "rejected" | "unchanged";

export interface DynamicIblPlaneLease { readonly bytes: number; dispose(): void }
/** 租约按平面分解：LUT 在 commit 时可移交共享槽，specular/diffuse 随世代生灭。 */
export interface DynamicIblLease {
  readonly specular: DynamicIblPlaneLease;
  readonly diffuse: DynamicIblPlaneLease;
  readonly brdfLut: DynamicIblPlaneLease;
}

export interface DynamicIblStagePlan {
  readonly invalidation: DynamicIblInvalidation;
  readonly disposition: DynamicIblDisposition;
  readonly rawMips: number;
  readonly keptMips: number;
  /** 降级重定基后的纹理基尺寸（保留链尾 keptMips 个 mip，mip0 取 mips[raw-kept].size）；reject/unchanged 为 0。 */
  readonly keptBaseSize: number;
  readonly specularBytes: number;
  readonly diffuseBytes: number;
  readonly brdfLut: { readonly action: "upload" | "reuse"; readonly bytes: number };
  /** 候选入位的新增字节（LUT reuse 记 0）。 */
  readonly residencyBytes: number;
  /** active + 共享 LUT + 候选的合计驻留（本世代 commit 后的稳态字节）。 */
  readonly combinedBytes: number;
  readonly budgetBytes: number;
  readonly rejectReason?: "budget";
}

interface IblGeneration {
  readonly number: number;
  readonly identity: DynamicIblIdentity;
  readonly plan: DynamicIblStagePlan;
  readonly lut: { readonly width: number; readonly height: number; readonly dataBase64: string };
  readonly lease: DynamicIblLease;
  lutOwnedByShared: boolean;
  retired: boolean;
}

interface SharedLut { readonly width: number; readonly height: number; readonly dataBase64: string; lease: DynamicIblPlaneLease }

export const dynamicIblMipBytes = (size: number): number => size * size * 6 * 8;
export const dynamicIblLutBytes = (width: number, height: number): number => width * height * 8;
export function dynamicIblLeaseBytes(lease: DynamicIblLease): number {
  return lease.specular.bytes + lease.diffuse.bytes + lease.brdfLut.bytes;
}
export function iblIdentity(ibl: RuntimePrefilteredIbl): DynamicIblIdentity {
  return { id: ibl.id, revision: ibl.revision, contentHash: ibl.source.contentHash.value };
}
export function classifyDynamicIblInvalidation(previous: DynamicIblIdentity | undefined,
  next: DynamicIblIdentity): DynamicIblInvalidation {
  if (!previous) return "initial";
  return previous.id === next.id && previous.revision === next.revision && previous.contentHash === next.contentHash
    ? "unchanged" : "identity";
}

const finiteByteCount = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("IBL lease byte counts must be non-negative integers.");
  return value;
};
const assertPlane = (plane: DynamicIblPlaneLease, name: string): void => {
  if (!plane || typeof plane !== "object" || typeof plane.dispose !== "function") {
    throw new TypeError(`IBL ${name} lease must provide dispose().`);
  }
  finiteByteCount(plane.bytes);
};
const mipSizes = (ibl: RuntimePrefilteredIbl): readonly number[] =>
  ibl.specular.mips.map(mip => {
    const size = finiteByteCount(mip.size);
    if (size < 1) throw new TypeError("IBL specular mip sizes must be positive.");
    return size;
  });
const chainBytes = (sizes: readonly number[], kept: number): number =>
  sizes.slice(sizes.length - kept).reduce((sum, size) => sum + dynamicIblMipBytes(size), 0);

/** 纯决策：不触碰状态。失效分类、LUT 复用判定与预算降级（链头截断、贪心保质量）都在这里。 */
export function planDynamicIblStage(active: IblGeneration | undefined, shared: SharedLut | undefined,
  ibl: RuntimePrefilteredIbl, budgetBytes: number): DynamicIblStagePlan {
  if (!ibl || typeof ibl !== "object") throw new TypeError("Dynamic IBL candidate must be a RuntimePrefilteredIbl.");
  const sizes = mipSizes(ibl), rawMips = sizes.length;
  const diffuseSize = finiteByteCount(ibl.diffuse.mips[0]?.size ?? 0);
  if (diffuseSize < 1) throw new TypeError("IBL diffuse mip sizes must be positive.");
  const diffuseBytes = dynamicIblMipBytes(diffuseSize);
  const lutBytes = dynamicIblLutBytes(ibl.brdfLut.width, ibl.brdfLut.height);
  const invalidation = classifyDynamicIblInvalidation(active && { ...active.identity }, iblIdentity(ibl));
  const base = { rawMips, diffuseBytes, budgetBytes };
  if (invalidation === "unchanged") {
    return { ...base, invalidation, disposition: "unchanged", keptMips: 0, keptBaseSize: 0, specularBytes: 0,
      brdfLut: { action: "upload" as const, bytes: 0 }, residencyBytes: 0,
      combinedBytes: active!.lease.specular.bytes + active!.lease.diffuse.bytes + (shared?.lease.bytes ?? 0) };
  }
  const activeBytes = active ? active.lease.specular.bytes + active.lease.diffuse.bytes : 0;
  const reuse = shared !== undefined && shared.width === ibl.brdfLut.width && shared.height === ibl.brdfLut.height
    && shared.dataBase64 === ibl.brdfLut.dataBase64;
  const brdfLut = { action: reuse ? ("reuse" as const) : ("upload" as const), bytes: reuse ? 0 : lutBytes };
  const fixedBytes = activeBytes + (shared?.lease.bytes ?? 0);
  for (let kept = rawMips; kept >= 1; kept--) {
    const specularBytes = chainBytes(sizes, kept), residencyBytes = specularBytes + diffuseBytes + brdfLut.bytes;
    if (fixedBytes + residencyBytes > budgetBytes) continue;
    return { ...base, invalidation, disposition: kept === rawMips ? "accept" : "accept-degraded",
      keptMips: kept, keptBaseSize: sizes[rawMips - kept]!, specularBytes, brdfLut, residencyBytes,
      combinedBytes: fixedBytes + residencyBytes };
  }
  return { ...base, invalidation, disposition: "rejected", keptMips: 0, keptBaseSize: 0, specularBytes: 0,
    brdfLut, residencyBytes: 0, combinedBytes: fixedBytes, rejectReason: "budget" };
}

/** 世代状态机：stage 入位 → commit 帧边界晋升并回收旧世代 / rollback 销毁候选。 */
export class DynamicIblResidency {
  static readonly DEFAULT_BUDGET_BYTES = 2 * RUNTIME_IBL_MAX_BYTES;
  readonly #budget: number;
  #active: IblGeneration | undefined;
  #pending: IblGeneration | undefined;
  #sharedLut: SharedLut | undefined;
  #disposed = false;
  #nextGeneration = 0;

  constructor(budgetBytes: number = DynamicIblResidency.DEFAULT_BUDGET_BYTES) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new TypeError("Dynamic IBL budget must be a positive integer byte count.");
    }
    this.#budget = budgetBytes;
  }

  get budgetBytes(): number { return this.#budget; }
  get disposed(): boolean { return this.#disposed; }
  get activeIdentity(): DynamicIblIdentity | undefined { return this.#active && { ...this.#active.identity }; }
  get activeGeneration(): number | undefined { return this.#active?.number; }
  get pendingGeneration(): number | undefined { return this.#pending?.number; }
  /** 活跃租约字节（LUT 已移交共享槽时不重复计）。 */
  get activeResidencyBytes(): number {
    return this.#active ? this.#active.lease.specular.bytes + this.#active.lease.diffuse.bytes
      + (this.#active.lutOwnedByShared ? 0 : this.#active.lease.brdfLut.bytes) : 0;
  }
  get sharedLutBytes(): number { return this.#sharedLut?.lease.bytes ?? 0; }
  get combinedResidencyBytes(): number {
    return this.activeResidencyBytes + (this.#pending ? dynamicIblLeaseBytes(this.#pending.lease) : 0) + this.sharedLutBytes;
  }
  /** 零泄漏不变式的观察口：每个世代租约要么 active、要么 pending、要么已回收；LUT 单独计共享槽。 */
  get outstandingLeases(): number { return (this.#active ? 1 : 0) + (this.#pending ? 1 : 0) + (this.#sharedLut ? 1 : 0); }

  plan(ibl: RuntimePrefilteredIbl): DynamicIblStagePlan {
    this.assertLive();
    return planDynamicIblStage(this.#active, this.#sharedLut, ibl, this.#budget);
  }

  /** 状态机即时接管租约：unchanged/rejected 也会立刻销毁，调用方零负担。 */
  stage(ibl: RuntimePrefilteredIbl, lease: DynamicIblLease): { status: "staged" | "idempotent" | "rejected";
    generation?: number; plan: DynamicIblStagePlan } {
    this.assertLive();
    assertPlane(lease.specular, "specular"); assertPlane(lease.diffuse, "diffuse"); assertPlane(lease.brdfLut, "brdf LUT");
    const plan = planDynamicIblStage(this.#active, this.#sharedLut, ibl, this.#budget);
    if (plan.disposition === "unchanged") {
      this.retirePlanes(lease); return { status: "idempotent", plan };
    }
    if (plan.disposition === "rejected") {
      this.retirePlanes(lease); return { status: "rejected", plan };
    }
    if (lease.specular.bytes !== plan.specularBytes || lease.diffuse.bytes !== plan.diffuseBytes
      || lease.brdfLut.bytes !== plan.brdfLut.bytes) {
      this.retirePlanes(lease);
      throw new TypeError("IBL lease bytes differ from the staged plan.");
    }
    this.rollbackPending();
    const generation = ++this.#nextGeneration;
    this.#pending = { number: generation, identity: iblIdentity(ibl), plan,
      lut: { width: ibl.brdfLut.width, height: ibl.brdfLut.height, dataBase64: ibl.brdfLut.dataBase64 },
      lease, lutOwnedByShared: false, retired: false };
    return { status: "staged", generation, plan };
  }

  /** 帧边界晋升：pending 就位后旧 active 立即回收；plan 决定 LUT 是否移交共享槽。 */
  commit(generation: number): boolean {
    this.assertLive();
    if (this.#pending?.number !== generation) return false;
    const candidate = this.#pending!;
    this.#pending = undefined;
    const previous = this.#active;
    this.#active = candidate;
    if (candidate.plan.brdfLut.action === "upload") this.replaceSharedLut(candidate);
    if (previous) this.retireGeneration(previous);
    return true;
  }

  rollback(generation: number): boolean {
    this.assertLive();
    if (this.#pending?.number !== generation) return false;
    this.rollbackPending(); return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    const shared = this.#sharedLut; this.#sharedLut = undefined;
    const pending = this.#pending; this.#pending = undefined;
    const active = this.#active; this.#active = undefined;
    for (const generation of [active, pending]) {
      if (!generation) continue;
      try { this.retireGeneration(generation); } catch (error) { errors.push(error); }
    }
    if (shared) try { shared.lease.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Dynamic IBL residency cleanup failed.");
  }

  /** 候选 LUT 升为共享资产：旧共享 LUT 即刻回收；候选世代不再拥有该平面。 */
  private replaceSharedLut(candidate: IblGeneration): void {
    const previous = this.#sharedLut;
    this.#sharedLut = { ...candidate.lut, lease: candidate.lease.brdfLut };
    candidate.lutOwnedByShared = true;
    if (previous) previous.lease.dispose();
  }

  private rollbackPending(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    this.retireGeneration(pending);
  }

  private retireGeneration(generation: IblGeneration): void {
    if (generation.retired) return;
    generation.retired = true;
    const lut = generation.lutOwnedByShared ? undefined : generation.lease.brdfLut;
    const errors: unknown[] = [];
    for (const plane of [generation.lease.specular, generation.lease.diffuse, lut] as const) {
      if (!plane) continue;
      try { plane.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Dynamic IBL generation retirement failed.");
  }

  private retirePlanes(lease: DynamicIblLease): void {
    const errors: unknown[] = [];
    for (const plane of [lease.specular, lease.diffuse, lease.brdfLut] as const) {
      try { plane.dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Dynamic IBL lease retirement failed.");
  }

  private assertLive(): void {
    if (this.#disposed) throw new Error("Dynamic IBL residency is disposed.");
  }
}
