import { describe, expect, it, vi } from "vitest";
import { PIPELINE_WARMUP_PLAN_SCHEMA, PIPELINE_WARMUP_PLAN_SCHEMA_VERSION,
  clearPipelineWarmupPlan, loadPipelineWarmupPlan, persistPipelineWarmupPlanToBrowser,
  pipelineWarmupEntriesFromLedger, savePipelineWarmupPlan,
  type PipelineWarmupPlanEntry, type StorageLike, orderDeferredByWarmupPlan, } from "./pipelineCachePersistence.js";

function memoryStorage(): StorageLike & { map: Map<string, string>; failWrites: boolean } {
  const map = new Map<string, string>();
  const storage = {
    map, failWrites: false,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.failWrites) throw new Error("quota exceeded");
      map.set(key, value);
    },
    removeItem: (key: string) => { map.delete(key); },
  };
  return storage;
}

function entry(overrides: Partial<PipelineWarmupPlanEntry> = {}): PipelineWarmupPlanEntry {
  return { fingerprint: "pso-sha256-aa", label: "Deep forward PBR plain/depth/ccw", priority: "first-frame",
    lastDurationMs: 40, sampleCount: 1, updatedAtEpochMs: 1000, ...overrides };
}

describe("C26 cross-session warmup plan persistence", () => {
  it("round-trips saved entries through load", () => {
    const storage = memoryStorage();
    expect(savePipelineWarmupPlan(storage, [entry()])).toBe(true);
    const plan = loadPipelineWarmupPlan(storage);
    expect(plan).toMatchObject({ schema: PIPELINE_WARMUP_PLAN_SCHEMA, schemaVersion: PIPELINE_WARMUP_PLAN_SCHEMA_VERSION });
    expect(plan?.entries).toEqual([entry()]);
  });

  it("returns undefined for a missing, corrupted, or foreign-schema plan (fail-open)", () => {
    const storage = memoryStorage();
    expect(loadPipelineWarmupPlan(storage)).toBeUndefined();
    storage.map.set("key", "{not json");
    expect(loadPipelineWarmupPlan(storage, "key")).toBeUndefined();
    storage.map.set("key", JSON.stringify({ schema: "someone-else", schemaVersion: 1, entries: [entry()] }));
    expect(loadPipelineWarmupPlan(storage, "key")).toBeUndefined();
    storage.map.set("key", JSON.stringify({ schema: PIPELINE_WARMUP_PLAN_SCHEMA, schemaVersion: 99, entries: [] }));
    expect(loadPipelineWarmupPlan(storage, "key")).toBeUndefined();
    // 条目字段不合法时逐条丢弃,不整体作废。
    storage.map.set("key", JSON.stringify({ schema: PIPELINE_WARMUP_PLAN_SCHEMA,
      schemaVersion: PIPELINE_WARMUP_PLAN_SCHEMA_VERSION,
      entries: [entry(), { fingerprint: "", priority: "first-frame" }] }));
    expect(loadPipelineWarmupPlan(storage, "key")?.entries).toHaveLength(1);
  });

  it("survives throwing storage without throwing (quota/fail-open)", () => {
    const storage = memoryStorage();
    storage.failWrites = true;
    expect(savePipelineWarmupPlan(storage, [entry()])).toBe(false);
    expect(clearPipelineWarmupPlan(storage)).toBeUndefined();
  });

  it("merges same-fingerprint resamples into one entry with the faster duration and a grown sample count", () => {
    const storage = memoryStorage();
    savePipelineWarmupPlan(storage, [entry({ lastDurationMs: 60 })]);
    savePipelineWarmupPlan(storage, [entry({ lastDurationMs: 20, updatedAtEpochMs: 2000 })]);
    const merged = loadPipelineWarmupPlan(storage)?.entries;
    expect(merged).toHaveLength(1);
    expect(merged![0]).toMatchObject({ lastDurationMs: 20, sampleCount: 2, updatedAtEpochMs: 2000 });
  });

  it("keeps the newest entries when the plan would exceed capacity", () => {
    const storage = memoryStorage();
    for (let index = 0; index < 600; index += 1) {
      savePipelineWarmupPlan(storage, [entry({ fingerprint: `pso-sha256-${index}`, updatedAtEpochMs: index })]);
    }
    const plan = loadPipelineWarmupPlan(storage);
    expect(plan?.entries.length).toBeLessThanOrEqual(512);
    expect(plan?.entries.some(item => item.fingerprint === "pso-sha256-599")).toBe(true);
    expect(plan?.entries.some(item => item.fingerprint === "pso-sha256-0")).toBe(false);
  });

  it("drops a stale priority entry when the same fingerprint reappears with a new priority", () => {
    const storage = memoryStorage();
    savePipelineWarmupPlan(storage, [entry({ priority: "background" })]);
    savePipelineWarmupPlan(storage, [entry({ priority: "first-frame", updatedAtEpochMs: 3000 })]);
    expect(loadPipelineWarmupPlan(storage)?.entries).toEqual([
      entry({ priority: "first-frame", updatedAtEpochMs: 3000 })]);
  });
});

describe("C26 ledger -> warmup plan classification", () => {
  it("classifies critical fingerprints as first-frame, others as background, skipping hits/failures", () => {
    const entries = pipelineWarmupEntriesFromLedger([
      { fingerprint: "pso-crit", label: "Deep shadow solid/ccw", durationMs: 5, cacheHit: false, failed: false, settledAtMs: 1 },
      { fingerprint: "pso-back", label: "Deep forward PBR material/blend/ccw", durationMs: 20, cacheHit: false, failed: false, settledAtMs: 2 },
      { fingerprint: "pso-hit", label: "Deep forward PBR plain/depth/ccw", durationMs: 0, cacheHit: true, failed: false, settledAtMs: 3 },
      { fingerprint: "pso-fail", label: "Deep forward PBR normal/blend/ccw", durationMs: 9, cacheHit: false, failed: true, settledAtMs: 4 },
    ], ["pso-crit"], 7777);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ fingerprint: "pso-crit", priority: "first-frame", lastDurationMs: 5 });
    expect(entries[1]).toMatchObject({ fingerprint: "pso-back", priority: "background", lastDurationMs: 20 });
    expect(entries.every(item => item.updatedAtEpochMs === 7777)).toBe(true);
  });

  it("persists via an explicit storage, and returns false when no browser storage exists", () => {
    const storage = memoryStorage();
    expect(persistPipelineWarmupPlanToBrowser([entry()], storage)).toBe(true);
    expect(loadPipelineWarmupPlan(storage)?.entries).toHaveLength(1);
    // 显式把 localStorage 摘掉,模拟 Node/隐私模式:fail-open 返回 false。
    vi.stubGlobal("localStorage", undefined);
    expect(persistPipelineWarmupPlanToBrowser([entry()])).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("orderDeferredByWarmupPlan", () => {
  const plan: PipelineWarmupPlan = { schema: PIPELINE_WARMUP_PLAN_SCHEMA, schemaVersion: 1, entries: [
    { fingerprint: "fp-slow", label: "slow", priority: "background", lastDurationMs: 900, sampleCount: 1, updatedAtEpochMs: 1 },
    { fingerprint: "fp-fast", label: "fast", priority: "background", lastDurationMs: 5, sampleCount: 1, updatedAtEpochMs: 2 },
  ] };
  const items = [{ key: "a", fp: "fp-x" }, { key: "b", fp: "fp-slow" }, { key: "c", fp: "fp-fast" }, { key: "d", fp: "fp-y" }];
  const fpOf = (item: { fp: string }) => item.fp;

  it("orders known-expensive fingerprints first, unknown items keep original relative order after", () => {
    const ordered = orderDeferredByWarmupPlan(items, plan, fpOf);
    expect(ordered.map(i => i.key)).toEqual(["b", "c", "a", "d"]);
  });
  it("returns the original array order without a plan or empty entries", () => {
    expect(orderDeferredByWarmupPlan(items, undefined, fpOf).map(i => i.key)).toEqual(["a", "b", "c", "d"]);
    expect(orderDeferredByWarmupPlan(items, { ...plan, entries: [] }, fpOf).map(i => i.key)).toEqual(["a", "b", "c", "d"]);
  });
});
