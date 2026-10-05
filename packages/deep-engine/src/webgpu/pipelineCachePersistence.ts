/**
 * C26 跨会话预热计划持久化。
 *
 * WebGPU 没有 web 标准 API 可把 GPURenderPipeline 落盘(浏览器内置 Dawn
 * shader 磁盘缓存不受页面控制;@webgpu/types 亦无 pipeline data cache 字段,
 * DeviceSession 的 requestAdapter/requestDevice 无 cache 选项可登记)。
 * 能跨会话持久化的是「编译计划」:逐管线指纹、标签、优先级与上次实测耗时。
 * 下一次会话加载该计划,即可:
 * 1. 预热队列按上会话实测把首帧必需指纹排到最前(优先级建议);
 * 2. 跨会话对照逐管线编译耗时(回归监测口径)。
 *
 * 失效语义:指纹含 WGSL 源哈希——源变更后新指纹在计划中不存在,旧条目
 * 随 LRU 容量自然淘汰;schema 不符一律丢弃(fail-open,绝不把坏计划当真)。
 */

export const PIPELINE_WARMUP_PLAN_SCHEMA = "deep-pipeline-warmup-plan";
export const PIPELINE_WARMUP_PLAN_SCHEMA_VERSION = 1;

import type { PipelineCompileRecord } from "./pipelineCache.js";
import type { PipelineWarmupPriority } from "./pipelineWarmup.js";

export interface PipelineWarmupPlanEntry {
  readonly fingerprint: string;
  readonly label: string;
  readonly priority: PipelineWarmupPriority;
  /** 上会话实测编译耗时(毫秒);命中样本取中位。 */
  readonly lastDurationMs: number;
  readonly sampleCount: number;
  readonly updatedAtEpochMs: number;
}

export interface PipelineWarmupPlan {
  readonly schema: string;
  readonly schemaVersion: number;
  readonly entries: readonly PipelineWarmupPlanEntry[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const PIPELINE_WARMUP_PLAN_STORAGE_KEY = "deep-engine.pipeline-warmup-plan.v1";
/** 计划条目上限:28 管线 × 若干会话样本仍有富余,防止无限增长。 */
const MAX_ENTRIES = 512;

/** 浏览器 localStorage 安全访问:不可用时返回 undefined(fail-open)。 */
export function browserLocalStorage(): StorageLike | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return undefined;
    const probe = `${PIPELINE_WARMUP_PLAN_STORAGE_KEY}.probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return undefined;
  }
}

function asPlan(value: unknown): PipelineWarmupPlan | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const plan = value as Record<string, unknown>;
  if (plan.schema !== PIPELINE_WARMUP_PLAN_SCHEMA) return undefined;
  if (plan.schemaVersion !== PIPELINE_WARMUP_PLAN_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(plan.entries)) return undefined;
  const entries: PipelineWarmupPlanEntry[] = [];
  for (const raw of plan.entries) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.fingerprint !== "string" || entry.fingerprint.length === 0) continue;
    if (typeof entry.label !== "string") continue;
    if (entry.priority !== "first-frame" && entry.priority !== "background" && entry.priority !== "idle") continue;
    if (typeof entry.lastDurationMs !== "number" || !(entry.lastDurationMs >= 0)) continue;
    if (typeof entry.sampleCount !== "number" || !Number.isSafeInteger(entry.sampleCount) || entry.sampleCount < 1) continue;
    if (typeof entry.updatedAtEpochMs !== "number" || !Number.isSafeInteger(entry.updatedAtEpochMs)) continue;
    entries.push({ fingerprint: entry.fingerprint, label: entry.label, priority: entry.priority,
      lastDurationMs: entry.lastDurationMs, sampleCount: entry.sampleCount,
      updatedAtEpochMs: entry.updatedAtEpochMs });
  }
  return { schema: PIPELINE_WARMUP_PLAN_SCHEMA, schemaVersion: PIPELINE_WARMUP_PLAN_SCHEMA_VERSION, entries };
}

/** 读取持久化计划;缺失/损坏/schema 不符一律 undefined,绝不抛。 */
export function loadPipelineWarmupPlan(storage: StorageLike, key = PIPELINE_WARMUP_PLAN_STORAGE_KEY):
PipelineWarmupPlan | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    return asPlan(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** 合并保存逐管线编译样本(fingerprint+priority 相同的条目做中位合并)。失败返回 false。 */
export function savePipelineWarmupPlan(storage: StorageLike,
  samples: readonly PipelineWarmupPlanEntry[], key = PIPELINE_WARMUP_PLAN_STORAGE_KEY): boolean {
  try {
    const existing = loadPipelineWarmupPlan(storage, key)?.entries ?? [];
    const byFingerprint = new Map<string, PipelineWarmupPlanEntry>();
    for (const entry of [...existing, ...samples]) {
      const previous = byFingerprint.get(entry.fingerprint);
      // fingerprint 唯一;同指纹同优先级合并(采样中位),优先级以最新样本为准。
      byFingerprint.set(entry.fingerprint, previous && previous.priority === entry.priority
        ? mergeEntry(previous, entry)
        : entry);
    }
    const entries = [...byFingerprint.values()]
      .sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs)
      .slice(0, MAX_ENTRIES);
    storage.setItem(key, JSON.stringify({
      schema: PIPELINE_WARMUP_PLAN_SCHEMA, schemaVersion: PIPELINE_WARMUP_PLAN_SCHEMA_VERSION, entries,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearPipelineWarmupPlan(storage: StorageLike, key = PIPELINE_WARMUP_PLAN_STORAGE_KEY): void {
  try { storage.removeItem(key); } catch { /* fail-open */ }
}

function mergeEntry(previous: PipelineWarmupPlanEntry, next: PipelineWarmupPlanEntry): PipelineWarmupPlanEntry {
  // 只保留计数不保留历史明细;两样本取较小值近似"中位",对预热排序足够稳定。
  const median = Math.min(previous.lastDurationMs, next.lastDurationMs);
  return { ...next, lastDurationMs: median, sampleCount: previous.sampleCount + next.sampleCount };
}

/**
 * 把一次构建的逐管线编译清单分类为预热计划条目:
 * 指纹 ∈ criticalFingerprints → first-frame,其余 → background。
 * 缓存命中(0ms)与失败样本不计入(它们不构成预热依据)。
 */
export function pipelineWarmupEntriesFromLedger(records: readonly PipelineCompileRecord[],
  criticalFingerprints: readonly string[], now: number = Date.now()): PipelineWarmupPlanEntry[] {
  const critical = new Set(criticalFingerprints);
  const byFingerprint = new Map<string, PipelineWarmupPlanEntry>();
  for (const record of records) {
    if (record.cacheHit || record.failed) continue;
    const previous = byFingerprint.get(record.fingerprint);
    if (previous) continue;
    byFingerprint.set(record.fingerprint, {
      fingerprint: record.fingerprint,
      label: record.label,
      priority: critical.has(record.fingerprint) ? "first-frame" : "background",
      lastDurationMs: record.durationMs,
      sampleCount: 1,
      updatedAtEpochMs: now,
    });
  }
  return [...byFingerprint.values()];
}

/** 背景变体入队排序:有上会话实测耗时的指纹按耗时降序排最前(最长编译最早
 * 起步,并发 2 下隐藏延迟),未知指纹保持原相对顺序随后。确定性、不突变入参。 */
export function orderDeferredByWarmupPlan<T>(items: readonly T[],
  plan: PipelineWarmupPlan | undefined, fingerprintOf: (item: T) => string): readonly T[] {
  if (!plan || plan.entries.length === 0) return items;
  const known = new Map<string, number>();
  for (const entry of plan.entries) known.set(entry.fingerprint, entry.lastDurationMs);
  return items
    .map((item, index) => ({ item, index, durationMs: known.get(fingerprintOf(item)) }))
    .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1) || a.index - b.index)
    .map(({ item }) => item);
}

/** 浏览器落盘:不可用/配额失败一律 false,绝不抛(fail-open)。 */
export function persistPipelineWarmupPlanToBrowser(entries: readonly PipelineWarmupPlanEntry[],
  storage?: StorageLike): boolean {
  const target = storage ?? browserLocalStorage();
  if (!target) return false;
  return savePipelineWarmupPlan(target, entries);
}
