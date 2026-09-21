import { describe, expect, it } from "vitest";
import { packIrradianceProbeRecord } from "../lighting/probeClipmapSampling.js";
import { planIrradianceProbeClipmap } from "../lighting/probeClipmapPlan.js";
import type { RayBatchQuery } from "./rayBackendTypes.js";
import { buildBvh } from "./bvhBuilder.js";
import { buildProbeOcclusionRayExtensionBatch, collectProbeOcclusionRayExtensionCandidates,
  composeProbeOcclusionEstimates, probeOcclusionDirection, probeOcclusionEstimatesWithRayExtension,
  probeOcclusionProbesFromUpdates, resolveProbeOcclusionRayExtensionOptions,
  toIrradianceProbeRecordPatch, PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME,
  type ProbeOcclusionEstimate, type ProbeOcclusionRayExtensionBatchResult,
  type ProbeOcclusionRayExtensionExecutor, type ProbeOcclusionRayExtensionOptions,
  type ProbeOcclusionRayExtensionProbe } from "./probeOcclusionRayExtension.js";
import { buildTracedScene, traceClosest } from "./rayTrace.js";

const EXTENSION: ProbeOcclusionRayExtensionOptions = { enabled: true };
const probe = (index: number, x = 0, y = 0, z = 0): ProbeOcclusionRayExtensionProbe => ({ index, x, y, z });

class RecordingExecutor implements ProbeOcclusionRayExtensionExecutor {
  calls = 0;
  lastQuery: RayBatchQuery | undefined;
  constructor(private readonly respond: (query: RayBatchQuery) => Promise<ProbeOcclusionRayExtensionBatchResult>) {}
  traceBatch(query: RayBatchQuery): Promise<ProbeOcclusionRayExtensionBatchResult> {
    this.calls += 1; this.lastQuery = query; return this.respond(query);
  }
}
/** 全 miss（开放空间）。 */
const revealAll = (): RecordingExecutor => new RecordingExecutor(async (query) =>
  ({ hits: Array.from({ length: query.tMax.length }, () => undefined) }));
/** 全命中于固定 t。 */
const occludeAll = (t: number): RecordingExecutor => new RecordingExecutor(async (query) =>
  ({ hits: Array.from({ length: query.tMax.length }, () => ({ t })) }));
/** 逐射线回放参考命中序列。 */
const replay = (ts: readonly (number | undefined)[]): RecordingExecutor => new RecordingExecutor(async () =>
  ({ hits: ts.map((t) => (t === undefined ? undefined : { t })) }));

describe("resolveProbeOcclusionRayExtensionOptions", () => {
  it("applies defaults and clamps the frame budget to the hard limit", () => {
    expect(resolveProbeOcclusionRayExtensionOptions(EXTENSION)).toMatchObject({ directionCount: 8,
      maxDistance: 32, occluderMask: 0xffff_ffff, buriedMeanDistance: 0.01,
      maxRaysPerFrame: PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME });
    expect(resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 100_000 }).maxRaysPerFrame)
      .toBe(PROBE_OCCLUSION_RAY_EXTENSION_MAX_RAYS_PER_FRAME);
    expect(resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 16 }).directionCount).toBe(16);
  });
  it("fails fast on contract violations (directions, distance, mask, buried, budget, probe terms)", () => {
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 0 })).toThrow(/directionCount/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 17 })).toThrow(/directionCount/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxDistance: 0 })).toThrow(/maxDistance/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxDistance: 1_000_001 })).toThrow(/maxDistance/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, occluderMask: -1 })).toThrow(/occluderMask/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, buriedMeanDistance: -1 })).toThrow(/buriedMeanDistance/);
    expect(() => resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: -1 })).toThrow(/maxRaysPerFrame/);
    expect(() => collectProbeOcclusionRayExtensionCandidates([probe(Number.NaN)])).toThrow(/non-finite/);
    expect(() => collectProbeOcclusionRayExtensionCandidates([probe(0), probe(2)])).toThrow(/index/);
  });
});

describe("probeOcclusionDirection (fixed deterministic direction set)", () => {
  it("is deterministic, unit-length, pairwise distinct and spans both hemispheres", () => {
    const a = Array.from({ length: 16 }, (_, ordinal) => probeOcclusionDirection(ordinal, 16));
    const b = Array.from({ length: 16 }, (_, ordinal) => probeOcclusionDirection(ordinal, 16));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(new Set(a.map((d) => d.join(","))).size).toBe(16);
    for (const [x, y, z] of a) {
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      expect(z).toBeLessThan(1); expect(z).toBeGreaterThan(-1); // 开区间，无极点重复。
    }
    expect(a.some(([, , z]) => z > 0 && z < 1)).toBe(true);
    expect(a.some(([, , z]) => z < 0 && z > -1)).toBe(true);
  });
  it("matches the closed-form Fibonacci sphere placement", () => {
    const golden = Math.PI * (1 + Math.sqrt(5));
    const [x, y, z] = probeOcclusionDirection(3, 8);
    const phi = Math.acos(1 - 2 * ((3 + 0.5) / 8)), theta = golden * (3 + 0.5);
    expect(x).toBeCloseTo(Math.sin(phi) * Math.cos(theta), 12);
    expect(y).toBeCloseTo(Math.cos(phi), 12);
    expect(z).toBeCloseTo(Math.sin(phi) * Math.sin(theta), 12);
  });
});

describe("buildProbeOcclusionRayExtensionBatch", () => {
  const resolved = resolveProbeOcclusionRayExtensionOptions(EXTENSION);
  it("emits probe-major rays with the probe origin, uniform tMax and mask passthrough", () => {
    const batch = buildProbeOcclusionRayExtensionBatch([probe(0, 1, 2, 3), probe(1, 4, 5, 6)], resolved);
    expect(batch.query.tMax.length).toBe(16);
    expect(batch.clamped).toBe(false);
    expect([...batch.query.origins].slice(0, 6)).toEqual([1, 2, 3, 1, 2, 3]);
    expect([...batch.query.origins].slice(24, 30)).toEqual([4, 5, 6, 4, 5, 6]);
    expect([...batch.query.tMax].every((t) => t === 32)).toBe(true);
    expect(batch.query.mask).toBe(0xffff_ffff);
    const [dx, dy, dz] = [batch.query.directions[0]!, batch.query.directions[1]!, batch.query.directions[2]!];
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(1, 7); // 单位方向直发世界空间（f32 存储舍入）。
  });
  it("clamps the dispatch to the probe budget and flags the downgrade (including zero-ray frames)", () => {
    const candidates = [probe(0), probe(1), probe(2)];
    const clamped = buildProbeOcclusionRayExtensionBatch(candidates,
      resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 16 }));
    expect(clamped.query.tMax.length).toBe(16);
    expect(clamped.dispatched).toHaveLength(2);
    expect(clamped.clamped).toBe(true);
    const empty = buildProbeOcclusionRayExtensionBatch(candidates,
      resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, maxRaysPerFrame: 4 }));
    expect(empty.query.tMax.length).toBe(0);
    expect(empty.dispatched).toHaveLength(0);
    expect(empty.clamped).toBe(true);
  });
});

describe("composeProbeOcclusionEstimates (aggregate statistics)", () => {
  const resolved = resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 4 });
  it("open space: all miss → floor 1, meanDistance = maxDistance, no nearest, not buried", () => {
    const { estimates, estimatedProbes, buriedProbes } = composeProbeOcclusionEstimates([probe(0)], [probe(0)],
      resolveProbeOcclusionRayExtensionOptions(EXTENSION), Array.from({ length: 8 }, () => undefined));
    const estimate = estimates[0]!;
    expect(estimatedProbes).toBe(1); expect(buriedProbes).toBe(0);
    expect(estimate.missRatio).toBe(1); expect(estimate.visibilityFloor).toBe(1);
    expect(estimate.meanDistance).toBe(32); expect(estimate.distanceVariance).toBe(0);
    expect(estimate.nearestHitDistance).toBeUndefined(); expect(estimate.buried).toBe(false);
  });
  it("closed shell: all hit → mean/variance over hit distances, buried gate is parametric", () => {
    const hits = Array.from({ length: 4 }, () => ({ t: 2 }));
    const generous = composeProbeOcclusionEstimates([probe(0)], [probe(0)],
      resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 4, buriedMeanDistance: 3 }),
      hits).estimates[0]!;
    expect(generous).toMatchObject({ missRatio: 0, meanDistance: 2, distanceVariance: 0,
      nearestHitDistance: 2, buried: true }); // miss=0 且 mean ≤ 3 → 判埋入。
    const tight = composeProbeOcclusionEstimates([probe(0)], [probe(0)],
      resolveProbeOcclusionRayExtensionOptions({ ...EXTENSION, directionCount: 4, buriedMeanDistance: 0.5 }),
      hits).estimates[0]!;
    expect(tight.buried).toBe(false); // mean 2 > 0.5：贴壳但不满足埋入阈值。
  });
  it("mixed hits: miss ratio, population variance and nearest distance aggregate exactly", () => {
    const hits = [{ t: 1 }, undefined, { t: 3 }, undefined];
    const { estimates } = composeProbeOcclusionEstimates([probe(0), probe(1)], [probe(0)], resolved, hits);
    const estimate = estimates[0]!;
    expect(estimate.missRatio).toBe(0.5); expect(estimate.visibilityFloor).toBe(0.5);
    expect(estimate.meanDistance).toBe(2); expect(estimate.distanceVariance).toBe(1);
    expect(estimate.nearestHitDistance).toBe(1); expect(estimate.directionCount).toBe(4);
    expect(estimates[1]).toBeUndefined(); // 未派发探针无估计。
  });
});

describe("probeOcclusionEstimatesWithRayExtension", () => {
  const probes = [probe(0, 0, 0, 0), probe(1, 10, 0, 0), probe(2, 0, 10, 0)];
  it("is a zero-change passthrough when the switch is off (executor untouched)", async () => {
    const executor = revealAll();
    const result = await probeOcclusionEstimatesWithRayExtension(probes, { ...EXTENSION, enabled: false }, executor);
    expect(result.extension).toMatchObject({ enabled: false, probes: 3, dispatchedRays: 0, estimatedProbes: 0 });
    expect(result.estimates).toEqual([undefined, undefined, undefined]);
    expect(executor.calls).toBe(0);
  });
  it("estimates every dispatched probe and passes the occluder mask through", async () => {
    const executor = revealAll();
    const result = await probeOcclusionEstimatesWithRayExtension(probes,
      { ...EXTENSION, occluderMask: 0x4 }, executor);
    expect(executor.calls).toBe(1);
    expect(executor.lastQuery!.mask).toBe(0x4);
    expect(executor.lastQuery!.tMax.length).toBe(24);
    expect(result.extension).toMatchObject({ enabled: true, probes: 3, dispatchedProbes: 3,
      dispatchedRays: 24, directionCount: 8, estimatedProbes: 3, buriedProbes: 0, budgetClamped: false });
    expect(result.estimates.map((estimate) => estimate?.index)).toEqual([0, 1, 2]);
    expect(result.extension.degradedReason).toBeUndefined();
  });
  it("flags buried probes when every direction hits within the buried threshold", async () => {
    const result = await probeOcclusionEstimatesWithRayExtension(probes,
      { ...EXTENSION, buriedMeanDistance: 0.5 }, occludeAll(0.25));
    expect(result.extension).toMatchObject({ estimatedProbes: 3, buriedProbes: 3 });
    expect(result.estimates[0]).toMatchObject({ missRatio: 0, meanDistance: 0.25, buried: true });
  });
  it("keeps budget-clamped probes estimate-free (fail-closed prefix truncation)", async () => {
    const result = await probeOcclusionEstimatesWithRayExtension(probes,
      { ...EXTENSION, maxRaysPerFrame: 16 }, revealAll());
    expect(result.extension).toMatchObject({ dispatchedProbes: 2, dispatchedRays: 16, budgetClamped: true,
      estimatedProbes: 2 });
    expect(result.estimates[2]).toBeUndefined();
  });
  it("falls back to no estimates when the executor fails", async () => {
    const failing = new RecordingExecutor(async () => {
      throw new Error("Two-level ray trace stack overflow (capacity 32) on 24 ray(s); batch rejected (fail-closed).");
    });
    const result = await probeOcclusionEstimatesWithRayExtension(probes, EXTENSION, failing);
    expect(result.extension.degradedReason).toMatch(/stack overflow/);
    expect(result.extension.dispatchedRays).toBe(24);
    expect(result.extension.estimatedProbes).toBe(0);
    expect(result.estimates).toEqual([undefined, undefined, undefined]);
  });
  it("requires an executor when enabled", async () => {
    const result = await probeOcclusionEstimatesWithRayExtension(probes, EXTENSION);
    expect(result.extension.degradedReason).toMatch(/requires an executor/);
  });
});

describe("CPU reference parity against rayTrace.ts (closed cube)", () => {
  /** 解析口径：原点探针在 [-2,2]³ 轴对齐盒内的出口距离 = 2/max|d|。 */
  const analyticExit = (d: readonly [number, number, number]): number =>
    2 / Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]));
  const vertices = new Float32Array([-2, -2, -2, 2, -2, -2, -2, 2, -2, 2, 2, -2,
    -2, -2, 2, 2, -2, 2, -2, 2, 2, 2, 2, 2]);
  const indices = Uint32Array.from([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1,
    2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);
  const cube = buildTracedScene({ id: "cube", vertices, indices });
  it("traceClosest reproduces the analytic exit distance; aggregation matches the analytic mean", () => {
    const resolved = resolveProbeOcclusionRayExtensionOptions(EXTENSION);
    const candidates = collectProbeOcclusionRayExtensionCandidates([probe(0)]);
    const { query, dispatched } = buildProbeOcclusionRayExtensionBatch(candidates, resolved);
    const reference = Array.from({ length: query.tMax.length }, (_, ray) =>
      traceClosest(cube, { ox: query.origins[ray * 3]!, oy: query.origins[ray * 3 + 1]!,
        oz: query.origins[ray * 3 + 2]!, dx: query.directions[ray * 3]!, dy: query.directions[ray * 3 + 1]!,
        dz: query.directions[ray * 3 + 2]!, tMax: query.tMax[ray]! })?.t);
    const analytic = Array.from({ length: 8 }, (_, ordinal) => analyticExit(probeOcclusionDirection(ordinal, 8)));
    reference.forEach((t, ray) => expect(t).toBeCloseTo(analytic[ray]!, 6)); // BVH 参考与解析几何一致（f32 方向舍入差 ≤1e-7）。
    const composed = composeProbeOcclusionEstimates(candidates, dispatched, resolved,
      analytic.map((t) => ({ t })));
    const estimate = composed.estimates[0]!;
    expect(estimate.missRatio).toBe(0);
    expect(estimate.meanDistance).toBeCloseTo(analytic.reduce((sum, t) => sum + t, 0) / 8, 12);
    expect(estimate.nearestHitDistance).toBeCloseTo(Math.min(...analytic), 12);
    expect(estimate.buried).toBe(false); // mean > 0.01：贴壳不等于埋入。
  });
  it("executor-contract composition and CPU reference composition are identical", async () => {
    const resolved = resolveProbeOcclusionRayExtensionOptions(EXTENSION);
    const candidates = collectProbeOcclusionRayExtensionCandidates([probe(0)]);
    const { dispatched } = buildProbeOcclusionRayExtensionBatch(candidates, resolved);
    const ts = Array.from({ length: 8 }, (_, ordinal) => analyticExit(probeOcclusionDirection(ordinal, 8)));
    const viaExecutor = await probeOcclusionEstimatesWithRayExtension([probe(0)],
      { ...EXTENSION, directionCount: 8 }, replay(ts));
    const viaReference = composeProbeOcclusionEstimates(candidates, dispatched, resolved, ts.map((t) => ({ t })));
    expect(JSON.stringify(viaExecutor.estimates)).toBe(JSON.stringify(viaReference.estimates));
    const estimate = viaExecutor.estimates[0] as ProbeOcclusionEstimate;
    expect(estimate.meanDistance).toBeCloseTo(ts.reduce((sum, t) => sum + t, 0) / 8, 12);
  });
});

describe("relocation & record contract integration (read-only upstream)", () => {
  it("maps plan.updates positions to probes with aligned indices", () => {
    const plan = planIrradianceProbeClipmap({ cameraPosition: [1, 1, 1],
      sceneBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      options: { levelCount: 2, gridSize: [2, 2, 2], baseSpacing: 2, updateBudget: 8 } });
    expect(plan.updates.length).toBeGreaterThan(0);
    const probes = probeOcclusionProbesFromUpdates(plan.updates);
    plan.updates.forEach((update, index) => {
      expect(probes[index]).toMatchObject({ index, x: update.position[0], y: update.position[1],
        z: update.position[2] });
    });
  });
  it("estimates feed the existing record channels through packIrradianceProbeRecord (f32 round-trip)", async () => {
    const result = await probeOcclusionEstimatesWithRayExtension([probe(0)], { ...EXTENSION, directionCount: 4 },
      replay([1, undefined, 3, undefined]));
    const patch = toIrradianceProbeRecordPatch(result.estimates[0]!);
    expect(patch).toEqual({ meanDistance: 2, distanceVariance: 1, occlusionFloor: 0.5 });
    const floats = new Float32Array(packIrradianceProbeRecord({ irradiance: [0, 0, 0], validity: 1, ...patch }));
    expect([...floats.slice(4, 8)]).toEqual([2, 1, 0.5, 0]); // meanDistance/variance/floor 通道原位。
  });
  it("exposes the buried verdict as data only (relocation solver stays authoritative)", async () => {
    const result = await probeOcclusionEstimatesWithRayExtension([probe(0)],
      { ...EXTENSION, buriedMeanDistance: 1 }, occludeAll(0.5));
    expect(result.estimates[0]!.buried).toBe(true);
    expect(result.estimates[0]).not.toHaveProperty("positionOffset"); // 不产偏移，不替代求解器。
  });
});
