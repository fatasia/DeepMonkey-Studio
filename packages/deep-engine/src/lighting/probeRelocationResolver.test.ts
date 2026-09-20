import { describe, expect, it } from "vitest";
import {
  DEEP_GI_PROBE_RECORD_BYTES,
  planIrradianceProbeClipmap, type ProbeAabb, type ProbeClipmapPlan, type ProbeVector3,
} from "./probeClipmapPlan.js";
import { packIrradianceProbeRecord, sampleIrradianceProbeClipmap,
  type IrradianceProbeRecord } from "./probeClipmapSampling.js";
import {
  ProbeRelocationPublisher, ProbeRelocationResolver,
} from "./probeRelocationResolver.js";

const WALL: ProbeAabb = { min: [0.5, -0.4, 0.7], max: [0.9, 0.4, 1.3] };

// gridSize [4,2,4], baseSpacing 1, level0 originCell [-2,-1,-2]; 世界格 (1,0,1) 恰好贴墙 0.1。
const plan = (): ProbeClipmapPlan => planIrradianceProbeClipmap({
  cameraPosition: [0, 0, 0],
  sceneBounds: { min: [-4, -2, -4], max: [3, 1, 3] },
  options: { levelCount: 2, gridSize: [4, 2, 4], baseSpacing: 1, updateBudget: 64 },
});
// 世界格 (1,0,1) → localCell (3,1,3) → linear (3*2+1)*4+3。
const WALL_PROBE_LINEAR = 31;
function updateIndexFor(plan: ProbeClipmapPlan, linear: number, level = 0): number {
  const index = plan.updates.findIndex(update => update.level === level && update.linearIndex === linear);
  if (index < 0) throw new Error("fixture probe is not scheduled");
  return index;
}

describe("probe relocation resolver", () => {
  it("round-trips solver offsets through packIrradianceProbeRecord into reference sampling", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    const frame = resolver.resolve(probe, [WALL]);
    const index = updateIndexFor(probe, WALL_PROBE_LINEAR);
    expect(frame.solvedCount).toBe(probe.updates.length);
    expect(frame.changedIndices).toEqual([index]);
    expect(frame.dirtyBounds).toHaveLength(1);
    const offsets = frame.write?.offsets ?? [];
    const encoded = packIrradianceProbeRecord({ irradiance: [0, 0, 0], validity: 0,
      meanDistance: 0, distanceVariance: 0, positionOffset: offsets[index] });
    expect(encoded.byteLength).toBe(DEEP_GI_PROBE_RECORD_BYTES);
    const decoded = [...new Float32Array(encoded).slice(8, 11)];
    expect(decoded[0]).toBeCloseTo(0.1, 6); // 逸出方向 +x
    expect(decoded[1]).toBe(0); expect(decoded[2]).toBe(0);

    // 采样闭环：只有贴墙探针带偏移，权重向逸出方向（+x 侧接收点）倾斜。
    const levels = probe.levels.slice(0, 2);
    const baseRecords = (offset: ProbeVector3 | undefined): (IrradianceProbeRecord | undefined)[] =>
      Array.from({ length: 64 }, (_, linear) => linear >= 32 ? undefined : {
        irradiance: linear === WALL_PROBE_LINEAR ? [1, 0, 0] : [0, 1, 0],
        validity: 1, meanDistance: linear === WALL_PROBE_LINEAR ? 0.05 : 1_000_000,
        distanceVariance: 0.0001, occlusionFloor: 0,
        ...(offset && linear === WALL_PROBE_LINEAR ? { positionOffset: offset } : {}),
      });
    const plain = sampleIrradianceProbeClipmap({ worldPosition: [0.9, 0, 1], worldNormal: [1, 0, 0],
      levels, records: baseRecords(undefined) });
    const relocated = sampleIrradianceProbeClipmap({ worldPosition: [0.9, 0, 1], worldNormal: [1, 0, 0],
      levels, records: baseRecords([decoded[0]!, decoded[1]!, decoded[2]!]) });
    expect(plain.fallback).toBe(false); expect(relocated.selectedLevel).toBe(0);
    expect(relocated.irradiance[0]).toBeGreaterThan(plain.irradiance[0]);
    expect(relocated.irradiance[1]).toBeLessThan(plain.irradiance[1]);
    expect(relocated.accumulatedWeight).toBeGreaterThan(plain.accumulatedWeight);
    // 解析闭式：偏移后贴墙探针距离接收点 0 ≤ meanDistance → 可见度权重 1。
    expect(relocated.accumulatedWeight).toBeCloseTo(1, 5);
  });

  it("is idempotent once probes are safe", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    resolver.resolve(probe, [WALL]);
    const second = resolver.resolve(probe, [WALL]);
    expect(second.changedCount).toBe(0);
    expect(second.dirtyBounds).toHaveLength(0);
    expect(second.write?.offsets[updateIndexFor(probe, WALL_PROBE_LINEAR)])
      .toEqual([expect.closeTo(0.1, 6), 0, 0]);
  });

  it("lands a deeply embedded probe within two frame iterations", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    const slab: ProbeAabb = { min: [-0.3, -0.3, -0.3], max: [0.3, 0.3, 0.3] };
    // 世界格 [0,0,0] 处 level0 与 level1（间距 2）探针重合，两者同时逸出 +x。
    const fine = updateIndexFor(probe, (2 * 2 + 1) * 4 + 2);
    const coarse = updateIndexFor(probe, (2 * 2 + 1) * 4 + 2, 1);
    const first = resolver.resolve(probe, [slab]);
    expect(first.changedIndices).toEqual([fine, coarse]);
    expect(first.write?.offsets[fine]).toEqual([expect.closeTo(0.5, 6), 0, 0]);
    expect(first.write?.offsets[coarse]).toEqual([expect.closeTo(0.7, 6), 0, 0]);
    const second = resolver.resolve(probe, [slab]);
    expect(second.changedCount).toBe(0); // 第二帧：距面恰为 margin → 安全，两种间距都落位
    expect(second.write?.offsets[fine]).toEqual([expect.closeTo(0.5, 6), 0, 0]);
    expect(second.write?.offsets[coarse]).toEqual([expect.closeTo(0.7, 6), 0, 0]);
  });

  it("holds the 0.5-cell cap for beyond-cap penetration and stays stable", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    const deep: ProbeAabb = { min: [-0.6, -0.6, -0.6], max: [0.6, 0.6, 0.6] };
    const fine = updateIndexFor(probe, (2 * 2 + 1) * 4 + 2);
    const coarse = updateIndexFor(probe, (2 * 2 + 1) * 4 + 2, 1);
    resolver.resolve(probe, [deep]);
    const second = resolver.resolve(probe, [deep]);
    expect(second.changedCount).toBe(0); // level0 需求 0.8 > 上限 0.5：钉在上限；level1 需求 1.0 恰等于上限 1.0：落位
    expect(second.write?.offsets[fine]).toEqual([expect.closeTo(0.5, 6), 0, 0]);
    expect(second.write?.offsets[coarse]).toEqual([expect.closeTo(1, 6), 0, 0]);
  });

  it("suppresses sub-debounce drift so the dirty evidence chain converges", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    const near: ProbeAabb = { min: [0.5, -0.4, 0.7], max: [0.83, 0.4, 1.3] }; // push 0.03 < 0.05
    const frame = resolver.resolve(probe, [near]);
    expect(frame.changedCount).toBe(0);
    expect(frame.dirtyBounds).toHaveLength(0);
    const index = updateIndexFor(probe, WALL_PROBE_LINEAR);
    expect(frame.write?.offsets[index]?.[0]).toBeGreaterThan(0);
    expect(frame.write?.offsets[index]?.[0]).toBeLessThan(0.05);
  });

  it("is fail-closed on invalid plans, occluders and options", () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    expect(() => resolver.resolve(probe, [{ min: [0.5, 0.5, 0.5], max: [0.4, 0.6, 0.6] }]))
      .toThrow(RangeError);
    expect(() => resolver.resolve({ ...probe, levels: [] }, [])).toThrow(RangeError);
    expect(() => resolver.resolve(probe, undefined as unknown as readonly ProbeAabb[])).toThrow(TypeError);
    expect(() => new ProbeRelocationResolver({ debounceCells: -1 })).toThrow(RangeError);
    expect(() => new ProbeRelocationResolver({ maxOffsetCells: 1.5 })).toThrow(RangeError);
    expect(() => resolver.resolve(probe, [{ min: [NaN, 0, 0], max: [1, 1, 1] }])).toThrow(RangeError);
  });

  it("strips offset-changed probes from the dynamic class for the same frame", async () => {
    const resolver = new ProbeRelocationResolver(), probe = plan();
    const calls: { context: unknown; relocation: unknown }[] = [];
    const upstream = { deviceEpoch: "gpu-1",
      setValidated: (_plan: ProbeClipmapPlan, _epoch: string, _signal?: AbortSignal,
        context?: unknown, relocation?: unknown) => {
        calls.push({ context, relocation });
        return Promise.resolve({} as never);
      },
      dispose: () => undefined };
    const publisher = new ProbeRelocationPublisher(
      upstream as Parameters<typeof ProbeRelocationPublisher>[0], resolver);
    const changedIndex = updateIndexFor(probe, WALL_PROBE_LINEAR);
    const context = { frame: 1, schedulerGeneration: 1, frameBudget: 64, capacityBudget: 64,
      cameraCut: false, invalidation: "none" as const,
      dynamicUpdateIndices: [changedIndex, changedIndex + 1] };
    publisher.setFrameOccluders([WALL]);
    await publisher.setValidated(probe, "gpu-1", undefined, context);
    const filtered = (calls[0]!.context as typeof context).dynamicUpdateIndices;
    expect(filtered).toEqual([changedIndex + 1]);
    expect(calls[0]!.relocation).toBeDefined();
    // 无偏移变化的帧：context 原样透传。
    await publisher.setValidated(probe, "gpu-1", undefined, context);
    expect(calls[1]!.context).toBe(context);
    expect(calls[1]!.relocation).toBeDefined(); // 非零偏移按帧重写，杜绝发布失败后的陈旧记录
  });
});
