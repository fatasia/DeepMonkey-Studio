import { describe, expect, it } from "vitest";
import { PbrRenderer } from "./pbrRenderer.js";
import { pipelineCompileCacheForDevice } from "./pipelineCache.js";

function fixture() {
  let time = 0;
  const device = {} as GPUDevice;
  const cache = pipelineCompileCacheForDevice(device, { now: () => time });
  const descriptor: GPURenderPipelineDescriptor = { label: "snapshot probe", layout: "auto",
    vertex: { module: {} as GPUShaderModule, entryPoint: "main" } };
  const snapshot = () => PbrRenderer.prototype.getPipelineCompileRecords.call({ session: { device } } as PbrRenderer);
  return { cache, descriptor, snapshot, device, setTime: (value: number) => { time = value; } };
}

describe("I-C26 public compile snapshot", () => {
  it("copies only settled records and freezes data without draining the internal ledger", async () => {
    const f = fixture();
    let settle!: (pipeline: GPURenderPipeline) => void;
    const pending = f.cache.create(["source"], f.descriptor, () => new Promise(resolve => { settle = resolve; }));
    const empty = f.snapshot();
    expect(empty).toEqual([]);
    f.setTime(12.5); settle({} as GPURenderPipeline); await pending;
    const first = f.snapshot();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ durationMs: 12.5, cacheHit: false, failed: false, settledAtMs: 12.5 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(() => Object.assign(first[0]!, { durationMs: 0 })).toThrow(TypeError);
    expect(() => (first as unknown as unknown[]).push({})).toThrow(TypeError);
    f.setTime(20); await f.cache.create(["source"], f.descriptor, () => { throw Error("must be reused"); });
    expect(empty).toEqual([]);
    expect(first).toHaveLength(1);
    expect(f.snapshot()).toHaveLength(2);
    expect(f.cache.records).toHaveLength(2);
    expect(f.snapshot()[1]).toMatchObject({ cacheHit: true, durationMs: 0, settledAtMs: 20 });
    expect(first[0]).not.toBe(f.cache.records[0]);
  });

  it("reports failed compile and retry without mixing a replacement device", async () => {
    const f = fixture();
    f.setTime(3);
    const failed = f.cache.create(["source"], f.descriptor, async () => { f.setTime(7); throw Error("compile failed"); });
    await expect(failed).rejects.toThrow("compile failed");
    const retained = f.snapshot();
    expect(retained[0]).toMatchObject({ failed: true, cacheHit: false, durationMs: 4 });
    await f.cache.create(["source"], f.descriptor, async () => ({} as GPURenderPipeline));
    expect(f.snapshot().map(record => record.failed)).toEqual([true, false]);
    expect(retained).toHaveLength(1);
    expect(PbrRenderer.prototype.getPipelineCompileRecords.call({ session: { device: {} } } as PbrRenderer)).toEqual([]);
  });

  it("bounds cache-hit records with the same budget as real compile records", async () => {
    const f = fixture();
    await f.cache.create(["source"], f.descriptor, async () => ({} as GPURenderPipeline));
    for (let i = 1; i <= 4100; i++) {
      f.setTime(i);
      await f.cache.create(["source"], f.descriptor, () => { throw Error("cache hit compiled again"); });
    }
    expect(f.cache.stats).toEqual({ entries: 1, misses: 1, hits: 4100 });
    expect(f.cache.records).toHaveLength(4096);
    expect(f.snapshot()[0]?.settledAtMs).toBe(5);
    expect(f.snapshot().at(-1)?.settledAtMs).toBe(4100);
    expect(f.snapshot().every(record => record.cacheHit)).toBe(true);
  });
});
