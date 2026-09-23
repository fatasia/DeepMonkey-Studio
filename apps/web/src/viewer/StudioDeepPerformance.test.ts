import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPbrFrameExecutionPlan, createPbrFrameReceipt, EnginePerformanceTelemetry, type FrameMetrics } from "@bim-studio/deep-engine/webgpu";
import { StudioDeepPerformance } from "./StudioDeepPerformance";
import { bindPresentationPerformance, enablePresentationGpuTiming, getPresentationBenchmarkSampleWindow,
  getPresentationPerformance } from "./viewerPresentationPerformance";

let callbacks: Map<number, FrameRequestCallback>;
beforeEach(() => {
  callbacks = new Map(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
function tick(timestamp: number): void { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(timestamp)); }
function submit(source: StudioDeepPerformance, id: number, timestamp: number, visible = true): void {
  source.record(frame(id), 800, visible); tick(timestamp);
}

function frame(id = 1): FrameMetrics {
  return { frame: id, cpuSubmitMs: 2, drawCalls: 12, triangles: 321, width: 1000, height: 800,
    resources: 42, shadowUpdated: false, cameraCut: false, postProcessPasses: 3, weightedOit: true,
    hiZMipLevels: 4, occlusionCulling: true, frustumCulledBatches: 2, hiZOccludedBatches: 1,
    lodSelectionBatches: 0, lodIndirectDraws: 0, lightCount: 2, lightClusters: 4,
    shadowTier: "exact", shadowDepthBytes: 4194304, shadowMapSize: 1024, shadowCascadeCount: 1 };
}

describe("Deep presentation performance", () => {
  it("uses actual Deep counts and leaves unknown texture/geometry counts absent", () => {
    const source = new StudioDeepPerformance({}); const submitted = frame();
    source.record(submitted, 800, true); tick(0); submit(source, 2, 16);
    Object.assign(submitted, { drawCalls: 9000 });
    const result = source.snapshot();
    expect(result).toMatchObject({ sampleCount: 1, fps: 62.5, renderer: {
      backend: "webgpu", drawCalls: 12, triangles: 321, pixelRatio: 1.25, viewportPixels: 800000 },
      deep: { frame: { resources: 42, shadowMapSize: 1024 } } });
    expect(result.renderer).not.toHaveProperty("textures"); expect(result.renderer).not.toHaveProperty("geometries");
    expect(result.renderer).not.toHaveProperty("pipelineWarmup");
    expect(result).not.toHaveProperty("gpuFrameTime"); source.dispose();
  });
  it("excludes idle demand gaps and invisible frame intervals", () => {
    const source = new StudioDeepPerformance({});
    submit(source, 1, 0); submit(source, 2, 16);
    source.pause(); submit(source, 3, 300); submit(source, 4, 316);
    submit(source, 5, 400, false); submit(source, 6, 600); submit(source, 7, 616);
    expect(source.snapshot()).toMatchObject({ sampleCount: 3, frameTimeMs: { p95: 16 } }); source.dispose();
  });
  it("resets the frame sample window after quality changes without clearing the last resource evidence", () => {
    const source = new StudioDeepPerformance({});
    submit(source, 1, 0); submit(source, 2, 16);
    source.reset(); expect(source.snapshot()).toMatchObject({ sampleCount: 0, renderer: { drawCalls: 12 } });
    submit(source, 3, 400); submit(source, 4, 420);
    expect(source.snapshot()).toMatchObject({ sampleCount: 1, frameTimeMs: { p95: 20 } }); source.dispose();
  });
  it("reports late GPU quantiles from Deep timing records and resets only when enabling", () => {
    const telemetry = new EnginePerformanceTelemetry(16, true), setDiagnosticsSampling = vi.fn();
    const source = new StudioDeepPerformance({ performanceTelemetry: telemetry, gpuTimer: { supported: true }, setDiagnosticsSampling });
    source.setGpuTimingEnabled(true); submit(source, 1, 0);
    expect(source.snapshot().gpuFrameTime).toMatchObject({ sampleCount: 0 });
    telemetry.record({ frame: 1, timings: { "frame-encode": 2, "gpu-frame": 8 } });
    source.setGpuTimingEnabled(true);
    expect(source.snapshot()).toMatchObject({ gpuFrameTime: { sampleCount: 1, p95Ms: 8 },
      deep: { timings: { stages: { "frame-encode": { p95Ms: 2 }, "gpu-frame": { samples: 1 } } } } });
    source.setGpuTimingEnabled(false); source.setGpuTimingEnabled(true);
    expect(source.snapshot().gpuFrameTime?.sampleCount).toBe(0);
    source.dispose(); expect(setDiagnosticsSampling).toHaveBeenLastCalledWith(false);
  });
  it("carries the bounded frame graph receipt into exported Deep diagnostics without inventing pass timings", () => {
    const source = new StudioDeepPerformance({});
    const plan = buildPbrFrameExecutionPlan({ width: 1000, height: 800 }, { transparency: false });
    const receipt = createPbrFrameReceipt(9, plan, [], 10, 16);
    source.record({ ...frame(9), frameGraphReceipt: receipt }, 800, true); tick(0);
    expect(source.snapshot().deep?.frame.frameGraphReceipt).toEqual(receipt);
    expect(receipt.samples.every(sample => sample.availability === "unavailable" && sample.samplesMs.length === 0)).toBe(true);
    source.dispose();
  });
  it("binds only the active source and preserves an already-open diagnostics preference", () => {
    const owner = {}, first = new StudioDeepPerformance({}), second = new StudioDeepPerformance({});
    const firstToggle = vi.spyOn(first, "setGpuTimingEnabled"), secondToggle = vi.spyOn(second, "setGpuTimingEnabled");
    enablePresentationGpuTiming(owner, true); bindPresentationPerformance(owner, first);
    expect(firstToggle).toHaveBeenLastCalledWith(true); expect(getPresentationPerformance(owner)).toBe(first);
    bindPresentationPerformance(owner, second);
    expect(firstToggle).toHaveBeenLastCalledWith(false); expect(secondToggle).toHaveBeenLastCalledWith(true);
    bindPresentationPerformance(owner, undefined);
    expect(secondToggle).toHaveBeenLastCalledWith(false); expect(getPresentationPerformance(owner)).toBeUndefined();
    first.dispose(); second.dispose();
  });
  it("counts one presentation per animation frame while retaining the last submitted counters", () => {
    const source = new StudioDeepPerformance({});
    source.record(frame(1), 800, true); source.record(frame(2), 800, true); tick(0);
    source.record(frame(3), 800, true); source.record(frame(4), 800, true); tick(16);
    source.record(frame(5), 800, true); source.record(frame(6), 800, true); tick(32);
    expect(source.snapshot()).toMatchObject({ sampleCount: 2, fps: 62.5, deep: { frame: { frame: 6 } } });
    source.dispose();
  });
  it("cancels pending display samples on idle and ignores late callbacks after disposal", () => {
    const source = new StudioDeepPerformance({}); submit(source, 1, 0);
    source.record(frame(2), 800, true); const late = [...callbacks.values()][0]!;
    source.pause(); late(16); expect(source.snapshot().sampleCount).toBe(0);
    submit(source, 3, 400); submit(source, 4, 416); expect(source.snapshot().frameTimeMs.p95).toBe(16);
    source.record(frame(5), 800, true); source.dispose(); tick(432);
    expect(source.snapshot().sampleCount).toBe(1); expect(callbacks.size).toBe(0);
  });
  it("publishes the shared A03 window and keeps missing GPU raw samples unavailable", () => {
    const owner = {}, source = new StudioDeepPerformance({});
    bindPresentationPerformance(owner, source); submit(source, 1, 0); submit(source, 2, 16);
    const sample = getPresentationBenchmarkSampleWindow(owner, "studio-test")!;
    expect(sample.channels).toHaveLength(8);
    expect(sample.channels.find(entry => entry.channel === "cpu-submit")).toMatchObject({ availability: "measured", samplesMs: [2, 2] });
    expect(sample.channels.find(entry => entry.channel === "gpu-timestamp")).toMatchObject({
      availability: "unavailable", samplesMs: [], sampleCount: 0, unavailableReason: "timestamp_query_not_supported" });
    bindPresentationPerformance(owner, undefined); source.dispose();
  });
});
