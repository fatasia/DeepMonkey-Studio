/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { RenderResourceLifetime } from "../renderGraph.js";
import { createAdmittedTexture } from "./resourceAdmission.js";
import { pbrFrameResourceContract, type FramePlanUsage } from "./pbrFramePlanResources.js";
import { failWithResourceCleanup } from "./resourceCleanup.js";
import type { PbrTransientTextureKey, PbrTransientRequest, PbrTransientTextureHandle, PbrTransientPoolInvalidationReason, PbrTransientTexturePoolStats } from "./pbrTransientTextureTypes.js";
export type { PbrTransientTextureKey, PbrTransientRequest, PbrTransientTextureHandle, PbrTransientPoolInvalidationReason, PbrTransientTexturePoolStats } from "./pbrTransientTextureTypes.js";

/**
 * DE26/B04 第一切片 · 帧内 transient 纹理池。
 *
 * 依据 B03 资源合同的完整兼容键(格式+尺寸+采样+usage,与 renderGraph aliasKey 同口径)
 * 复用 GPUTexture:只服务帧内目标(ao-half/oit-accumulation 等);跨帧 history 资源
 * (previous-hiz/next-hiz/temporal-hdr,以及任何带 historyRole 的合同条目)永不入池。
 *
 * 复用安全以 queue 生命周期为界:release 只把纹理挂起,真正回池发生在
 * endFrame(committed=true) —— 即 queue.submit 之后;帧内生命周期重叠的同键请求
 * 一律新建,不做帧内共享。失败提交(encode throw)的本帧纹理全部销毁,不回池。
 * 池实例按 DeviceSession 归属,无任何全局注册表;并行 renderer 候选天然不共享。
 */

/** 跨帧 history 合同条目:任务权威边界,显式列举 + historyRole 运行时兜底双重排除。 */
export const PBR_HISTORY_TRANSIENT_EXCLUDED = Object.freeze(["previous-hiz", "next-hiz", "temporal-hdr"] as const);
export const DEFAULT_TRANSIENT_TEXTURE_BUDGET_BYTES = 512 * 1024 * 1024;

/** B03 计划层 usage 字符串 → 运行时 GPUTextureUsage 位;未知字符串或空集 fail-closed 抛错。 */
export function framePlanUsageFlags(usages: readonly FramePlanUsage[]): GPUTextureUsageFlags {
  let flags = 0;
  for (const usage of usages) {
    switch (usage) {
      case "render-attachment": flags |= GPUTextureUsage.RENDER_ATTACHMENT; break;
      case "texture-binding": flags |= GPUTextureUsage.TEXTURE_BINDING; break;
      case "storage-binding": flags |= GPUTextureUsage.STORAGE_BINDING; break;
      case "copy-src": flags |= GPUTextureUsage.COPY_SRC; break;
      default: throw new Error(`Unknown frame plan usage flag: ${String(usage)}.`);
    }
  }
  if (!flags) throw new Error("Frame plan usage flags must not be empty for a pooled texture.");
  return flags;
}

const BYTES_PER_PIXEL: Readonly<Record<string, number>> = Object.freeze({
  "r8unorm": 1, "r16float": 2, "rg8unorm": 2, "rg16float": 4,
  "rgba8unorm": 4, "rgba8snorm": 4, "r32float": 4, "depth32float": 4,
  "rgba16float": 8, "rg32float": 8, "rgba32float": 16,
});

/** 估算纹理显存字节:bytes/pixel × 宽 × 高 × 采样;未登记格式抛错,不做静默猜测。 */
export function transientTextureBytes(format: string, width: number, height: number, sampleCount: number): number {
  const bytesPerPixel = BYTES_PER_PIXEL[format];
  if (bytesPerPixel === undefined) throw new Error(`Transient texture byte estimation has no entry for format: ${format}.`);
  const bytes = bytesPerPixel * width * height * sampleCount;
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error("Transient texture byte estimate exceeds safe integer range.");
  return bytes;
}

export function pbrTransientTextureKeyValue(key: PbrTransientTextureKey): string {
  return `${key.format}|${key.width}x${key.height}|s${key.sampleCount}|u${key.usage}`;
}

interface PoolTexture {
  readonly handle: PbrTransientTextureHandle;
  readonly bytes: number;
  readonly frame: number;
  state: "in-flight" | "pending-return";
}

interface AliasSlot {
  readonly entry: PoolTexture;
  readonly aliasKey: string;
  readonly keyValue: string;
  lastUse: number;
}

/** history 合同条目拒绝入池;非合同资源(合同外私有 transient)允许,由调用方声明用途。 */
export function isPbrTransientPoolEligible(resourceId: string): boolean {
  if ((PBR_HISTORY_TRANSIENT_EXCLUDED as readonly string[]).includes(resourceId)) return false;
  try {
    if (pbrFrameResourceContract(resourceId).historyRole !== undefined) return false;
  } catch { /* 合同外资源:不在跨帧 history 目录,池准入放行。 */ }
  return true;
}

export class PbrTransientTexturePool {
  private readonly free = new Map<string, PoolTexture[]>();
  private readonly live = new Set<PoolTexture>();
  private readonly activeLeases = new Map<PbrTransientTextureHandle, PoolTexture>();
  private readonly aliasPlan = new Map<string, RenderResourceLifetime>();
  private readonly aliasSlots = new Map<number, AliasSlot>();
  private currentEpoch = 0;
  private currentFrame = 0;
  private frameIsOpen = false;
  private residentBytes = 0;
  private lastInvalidation: readonly [PbrTransientPoolInvalidationReason, number] | undefined;
  private readonly counters = {
    acquireCount: 0, hits: 0, frameAliasHits: 0, misses: 0, allocatedBytes: 0, reusedBytes: 0,
    discardedCount: 0, evictedCount: 0, peakResidentBytes: 0, budgetRejectedCount: 0, budgetEvictedBytes: 0,
  };

  constructor(readonly session: DeviceSession, readonly budgetBytes = DEFAULT_TRANSIENT_TEXTURE_BUDGET_BYTES) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) throw new Error("Transient texture budget must be a positive safe integer.");
  }

  get epoch(): number { return this.currentEpoch; }
  get frameOpen(): boolean { return this.frameIsOpen; }

  /** 只读统计快照;每次调用重新冻结,不随内部状态联动。 */
  get stats(): PbrTransientTexturePoolStats {
    let freeCount = 0, freeBytes = 0;
    for (const entries of this.free.values()) for (const entry of entries) { freeCount += 1; freeBytes += entry.bytes; }
    let inFlightCount = 0, inFlightBytes = 0, pendingCount = 0, pendingBytes = 0;
    for (const entry of this.live) {
      if (entry.state === "in-flight") { inFlightCount += 1; inFlightBytes += entry.bytes; }
      else { pendingCount += 1; pendingBytes += entry.bytes; }
    }
    return Object.freeze({
      budgetBytes: this.budgetBytes, residentBytes: this.residentBytes,
      budgetRejectedCount: this.counters.budgetRejectedCount, budgetEvictedBytes: this.counters.budgetEvictedBytes,
      epoch: this.currentEpoch, frameOpen: this.frameIsOpen, lastInvalidation: this.lastInvalidation,
      acquireCount: this.counters.acquireCount, hits: this.counters.hits,
      frameAliasHits: this.counters.frameAliasHits, misses: this.counters.misses,
      allocatedBytes: this.counters.allocatedBytes, reusedBytes: this.counters.reusedBytes,
      freeCount, freeBytes, inFlightCount, inFlightBytes,
      pendingReturnCount: pendingCount, pendingReturnBytes: pendingBytes,
      peakResidentBytes: this.counters.peakResidentBytes,
      discardedCount: this.counters.discardedCount, evictedCount: this.counters.evictedCount,
    });
  }

  beginFrame(resourceLifetimes: readonly RenderResourceLifetime[] = []): void {
    if (this.frameIsOpen) throw new Error("Transient texture pool frame scope is already open; close it with endFrame first.");
    this.currentFrame += 1;
    this.aliasPlan.clear(); this.aliasSlots.clear(); this.activeLeases.clear();
    for (const resource of resourceLifetimes) {
      if (resource.external || resource.aliasKey === undefined || resource.transientSlot === undefined) continue;
      if (!isPbrTransientPoolEligible(resource.id)) continue;
      this.aliasPlan.set(resource.id, resource);
    }
    this.frameIsOpen = true;
  }

  /** 帧内获取;命中只可能来自此前帧回池的纹理(queue.submit 之后),帧内同键二次获取一律新建。 */
  acquire(request: PbrTransientRequest): PbrTransientTextureHandle {
    if (!this.frameIsOpen) throw new Error("Transient texture pool acquire requires an open frame scope (beginFrame).");
    if (!isPbrTransientPoolEligible(request.resourceId)) {
      throw new Error(`Resource ${request.resourceId} is cross-frame history and must never enter the transient pool.`);
    }
    if (this.session.state !== "ready") {
      throw new Error(`GPU session is ${this.session.state}; transient pool refuses allocation until the epoch is rebuilt.`);
    }
    this.counters.acquireCount += 1;
    const key: PbrTransientTextureKey = Object.freeze({
      format: request.format, width: request.width, height: request.height,
      sampleCount: request.sampleCount, usage: request.usage,
    });
    if (![key.width, key.height, key.sampleCount].every(dimension => Number.isSafeInteger(dimension) && dimension >= 1)) {
      throw new Error(`Transient texture request for ${request.resourceId} has invalid dimensions:`
        + ` ${key.width}x${key.height} s${key.sampleCount}.`);
    }
    const keyValue = pbrTransientTextureKeyValue(key);
    const planned = this.aliasPlan.get(request.resourceId);
    if (planned?.transientSlot !== undefined && planned.aliasKey !== undefined) {
      const slot = this.aliasSlots.get(planned.transientSlot);
      if (slot && slot.aliasKey === planned.aliasKey && slot.keyValue === keyValue && slot.lastUse < planned.firstUse) {
        slot.lastUse = planned.lastUse;
        this.counters.hits += 1; this.counters.frameAliasHits += 1;
        this.counters.reusedBytes += slot.entry.bytes;
        return this.lease(slot.entry, request.resourceId);
      }
    }
    const bucket = this.free.get(keyValue);
    const pooled = bucket?.pop();
    if (bucket?.length === 0) this.free.delete(keyValue);
    if (pooled) {
      this.counters.hits += 1;
      this.counters.reusedBytes += pooled.bytes;
      const handle = this.track(makePoolEntry(pooled.handle, pooled.bytes, this.currentFrame));
      this.installAliasSlot(planned, keyValue, this.liveEntry(handle));
      return handle;
    }
    const handle = this.create(key, request.resourceId);
    this.installAliasSlot(planned, keyValue, this.liveEntry(handle));
    return handle;
  }

  /** 帧内释放:只挂起,不改变可见复用性;回池发生在 endFrame(committed=true)。 */
  release(handle: PbrTransientTextureHandle): void {
    const entry = this.ownedEntry(handle);
    this.activeLeases.delete(handle);
    if (![...this.activeLeases.values()].includes(entry)) entry.state = "pending-return";
  }

  /** 提交成功:挂起纹理并入空闲列表供下帧复用;提交失败:本帧接触过的纹理全部销毁。 */
  endFrame(committed: boolean): void {
    if (!this.frameIsOpen) throw new Error("Transient texture pool endFrame requires an open frame scope.");
    if (committed) {
      for (const entry of this.live) {
        if (entry.state !== "pending-return") {
          throw new Error(`Transient texture ${entry.handle.resourceId} was never released before endFrame;`
            + " every acquired transient must be released or the frame must fail.");
        }
      }
      this.frameIsOpen = false;
      for (const entry of this.live) {
        const keyValue = pbrTransientTextureKeyValue(entry.handle.key);
        const bucket = this.free.get(keyValue);
        if (bucket) bucket.push(entry);
        else this.free.set(keyValue, [entry]);
      }
      this.live.clear();
      this.activeLeases.clear(); this.aliasPlan.clear(); this.aliasSlots.clear();
      return;
    }
    this.frameIsOpen = false;
    this.discardLive();
  }

  /** resize / 设备丢失 / epoch 更迭:空闲与在途整体作废并关闭开着的帧,epoch 自增。 */
  invalidateAll(reason: PbrTransientPoolInvalidationReason): void {
    this.frameIsOpen = false;
    this.discardLive();
    let evicted = 0;
    for (const entries of this.free.values()) {
      for (const entry of entries) { this.destroy(entry); evicted += 1; }
    }
    this.free.clear();
    this.currentEpoch += 1;
    this.counters.evictedCount += evicted;
    this.lastInvalidation = Object.freeze([reason, this.currentEpoch] as const);
  }

  dispose(): void {
    this.invalidateAll("epoch-advance");
  }

  private create(key: PbrTransientTextureKey, resourceId: string): PbrTransientTextureHandle {
    const bytes = transientTextureBytes(key.format, key.width, key.height, key.sampleCount);
    this.makeRoom(bytes, resourceId);
    // Chrome 146+ 把带该 flag 的目标交给驱动做内存别名，主存压力不再随 transient 池线性增长；
    // 不支持的浏览器或未暴露该常量的宿主维持原 usage，路径逐字节不变。
    const usageTable: { readonly RENDER_ATTACHMENT?: number; readonly TRANSIENT_ATTACHMENT?: number } | undefined =
      typeof GPUTextureUsage === "undefined" ? undefined : GPUTextureUsage;
    const transientFlag = usageTable?.TRANSIENT_ATTACHMENT !== undefined && usageTable.RENDER_ATTACHMENT !== undefined
      && (key.usage & usageTable.RENDER_ATTACHMENT) !== 0 ? usageTable.TRANSIENT_ATTACHMENT : 0;
    let texture: GPUTexture;
    try {
      texture = createAdmittedTexture(this.session, {
        label: `Deep transient ${resourceId}`, size: { width: key.width, height: key.height },
        format: key.format, sampleCount: key.sampleCount, usage: key.usage | transientFlag,
      });
    } catch (error) { failWithResourceCleanup(error, `Transient texture allocation failed for ${resourceId}`, []); }
    const handle = handleOf(this.session, texture, key, resourceId);
    this.residentBytes += bytes;
    this.counters.allocatedBytes += bytes;
    this.counters.misses += 1;
    return this.track(makePoolEntry(handle, bytes, this.currentFrame));
  }

  /** 仅压力路径扫描空闲池；本帧已释放但未 submit 的目标仍不可驱逐。 */
  private makeRoom(bytes: number, resourceId: string): void {
    if (this.residentBytes + bytes <= this.budgetBytes) return;
    let liveBytes = 0;
    for (const entry of this.live) liveBytes += entry.bytes;
    if (liveBytes + bytes > this.budgetBytes) {
      this.counters.budgetRejectedCount += 1;
      throw new Error(`Transient texture budget exceeded for ${resourceId}: ${liveBytes} busy + ${bytes} requested >`
        + ` ${this.budgetBytes} bytes. Reduce render resolution or post-processing quality.`);
    }
    const candidates = [...this.free.values()].flat().sort((a, b) => a.frame - b.frame);
    for (const entry of candidates) {
      if (this.residentBytes + bytes <= this.budgetBytes) break;
      const key = pbrTransientTextureKeyValue(entry.handle.key), bucket = this.free.get(key)!;
      bucket.splice(bucket.indexOf(entry), 1);
      if (!bucket.length) this.free.delete(key);
      this.destroy(entry);
      this.counters.evictedCount += 1;
      this.counters.budgetEvictedBytes += entry.bytes;
    }
  }

  private destroy(entry: PoolTexture): void {
    this.session.release(entry.handle.texture);
    this.residentBytes -= entry.bytes;
  }

  private track(entry: PoolTexture): PbrTransientTextureHandle {
    this.live.add(entry);
    this.activeLeases.set(entry.handle, entry);
    this.trackPeak();
    return entry.handle;
  }

  private ownedEntry(handle: PbrTransientTextureHandle): PoolTexture {
    if (!this.frameIsOpen) throw new Error("Transient texture release requires an open frame scope.");
    const entry = this.activeLeases.get(handle);
    if (entry) return entry;
    for (const candidate of this.live) if (candidate.handle === handle && candidate.state === "pending-return") {
      throw new Error("Transient texture was released twice in the same frame.");
    }
    throw new Error("Released transient texture does not belong to this pool's open frame.");
  }

  /** 失败提交 / 整体作废共用的在途清理:全部销毁,绝不进空闲列表。 */
  private discardLive(): void {
    let discarded = 0;
    for (const entry of this.live) { this.destroy(entry); discarded += 1; }
    this.live.clear();
    this.activeLeases.clear(); this.aliasPlan.clear(); this.aliasSlots.clear();
    this.counters.discardedCount += discarded;
  }

  private trackPeak(): void {
    this.counters.peakResidentBytes = Math.max(this.residentBytes, this.counters.peakResidentBytes);
  }

  private lease(entry: PoolTexture, resourceId: string): PbrTransientTextureHandle {
    const handle: PbrTransientTextureHandle = Object.freeze({ ...entry.handle, resourceId });
    entry.state = "in-flight"; this.activeLeases.set(handle, entry);
    return handle;
  }

  private liveEntry(handle: PbrTransientTextureHandle): PoolTexture {
    const entry = this.activeLeases.get(handle);
    if (!entry) throw new Error("Transient texture lease was not registered.");
    return entry;
  }

  private installAliasSlot(planned: RenderResourceLifetime | undefined, keyValue: string, entry: PoolTexture): void {
    if (planned?.transientSlot === undefined || planned.aliasKey === undefined) return;
    if (!this.aliasSlots.has(planned.transientSlot)) this.aliasSlots.set(planned.transientSlot, {
      entry, aliasKey: planned.aliasKey, keyValue, lastUse: planned.lastUse,
    });
  }
}

function makePoolEntry(handle: PbrTransientTextureHandle, bytes: number, frame: number): PoolTexture {
  return { handle, bytes, frame, state: "in-flight" };
}

function handleOf(session: DeviceSession, texture: GPUTexture, key: PbrTransientTextureKey,
  resourceId: string): PbrTransientTextureHandle {
  try { return { texture, view: texture.createView(), key, resourceId }; }
  catch (error) { failWithResourceCleanup(error, `Transient texture view creation failed for ${resourceId}`,
    [() => session.release(texture)]); }
}
