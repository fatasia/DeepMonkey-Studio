import { describe, expect, it, vi } from "vitest";
import type { GeometryResource } from "../renderPacketTypes.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import { ResidencyDiagnosticsWindow } from "../residencyDiagnostics.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuRenderResidencyRuntime } from "./gpuRenderResidencyRuntime.js";

const geometry: GeometryResource = { id: "mesh", revision: 3,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) };

function texture(id: string, width: number): DecodedTexture {
  return { id, revision: 7, semantic: "baseColor", width, height: width,
    data: new Uint8Array(width * width * 4).fill(127) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(popErrorScope = () => Promise.resolve<GPUError | null>(null)) {
  const owned = new Set<object>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192, maxBufferSize: 1024 * 1024 }, pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(popErrorScope),
    createBuffer: vi.fn(() => destroyable() as unknown as GPUBuffer),
    createTexture: vi.fn(() => ({ ...destroyable(), createView: vi.fn(() => ({})) }) as unknown as GPUTexture),
    createSampler: vi.fn(() => ({} as GPUSampler)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, owned };
}

function installGpuGlobals(): void {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
}

describe("GPU render residency telemetry", () => {
  it("keeps disabled unified diagnostics off the resource hot path", async () => {
    installGpuGlobals();
    try {
      const f = fixture(), recorder = new ResidencyDiagnosticsWindow(8);
      const clock = { now: vi.fn(() => 1) };
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 4, maxUploadBytesPerFrame: 4 }, request => ({ kind: "texture",
          source: { level: request.level, texture: texture("albedo", 1) } }),
        { diagnostics: { recorder, clock }, deviceEpoch: "gpu-disabled" });
      runtime.register({ id: "albedo", revision: 7, kind: "texture",
        levels: [{ level: 0, byteLength: 4 }] });
      await runtime.submit(1, [{ id: "albedo", kind: "texture", desiredLevel: 0 }]);
      expect(clock.now).not.toHaveBeenCalled();
      expect(recorder.snapshot()).toMatchObject({ enabled: false, generation: null, retainedSamples: 0 });
      runtime.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("aggregates real upload commits, cache reuse, evictions, bytes, and device epoch", async () => {
    installGpuGlobals();
    try {
      const f = fixture(), recorder = new ResidencyDiagnosticsWindow(32, true);
      let now = 0;
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132, retainFrames: 0 }, request => {
          now += 5; return { kind: "geometry", source: geometry };
        }, { diagnostics: { recorder, clock: { now: () => now } }, deviceEpoch: "gpu-resource-1" });
      runtime.register({ id: "mesh", revision: 3, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      await runtime.submit(1, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);
      now = 7;
      await runtime.submit(2, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);
      now = 8;
      await runtime.submit(3, []);
      now = 8;
      await runtime.submit(4, [{ id: "mesh", kind: "geometry", desiredLevel: 0 }]);

      const snapshot = recorder.snapshot();
      expect(snapshot).toMatchObject({ generation: 0, deviceEpoch: "gpu-resource-1",
        timings: { upload: { coldMs: 5,
          warm: { samples: 1, p50Ms: 5, p95Ms: 5, p99Ms: 5 },
          outcomes: { success: 2, aborted: 0, failure: 0 } } },
        domains: { resource: {
          activity: { hit: 1, miss: 2, reuse: 1, evict: 1, commit: 4, rollback: 0, abort: 0 },
          residentBytes: 132, peakResidentBytes: 132, budgetBytes: 132,
          budgetPressure: 1, peakBudgetPressure: 1,
        } } });
      runtime.dispose();
      expect(recorder.snapshot()).toMatchObject({ generation: 1, deviceEpoch: "gpu-resource-1",
        domains: { resource: { residentBytes: 0 } } });
    } finally { vi.unstubAllGlobals(); }
  });

  it("isolates superseded upload rollback from the latest committed residency", async () => {
    installGpuGlobals();
    try {
      const validation = deferred<GPUError | null>();
      let popCalls = 0, now = 0;
      const f = fixture(() => ++popCalls <= 3 ? validation.promise : Promise.resolve(null));
      const recorder = new ResidencyDiagnosticsWindow(32, true);
      const first = { ...geometry, id: "first" }, second = { ...geometry, id: "second" };
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 132, maxUploadBytesPerFrame: 132, retainFrames: 0 }, request => {
          now = request.id === "first" ? 2 : 5;
          return { kind: "geometry", source: request.id === "first" ? first : second };
        }, { diagnostics: { recorder, clock: { now: () => now } }, deviceEpoch: "gpu-latest" });
      runtime.register({ id: "first", revision: 3, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      runtime.register({ id: "second", revision: 3, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });

      const stale = runtime.submit(1, [{ id: "first", kind: "geometry", desiredLevel: 0 }]);
      await expect.poll(() => popCalls).toBe(3);
      const latest = runtime.submit(2, [{ id: "second", kind: "geometry", desiredLevel: 0 }]);
      validation.resolve(null);
      const [staleResult, latestResult] = await Promise.all([stale, latest]);
      expect(staleResult.status).toBe("superseded");
      expect(latestResult.status).toBe("applied");
      expect(runtime.get("geometry", "first")).toBeUndefined();
      expect(runtime.get("geometry", "second")).toMatchObject({ byteLength: 132 });
      expect(recorder.snapshot()).toMatchObject({
        timings: { upload: { coldMs: 3,
          outcomes: { success: 1, aborted: 1, failure: 0 } } },
        domains: { resource: {
          activity: { miss: 2, commit: 1, rollback: 1, abort: 1 },
          residentBytes: 132, peakResidentBytes: 132,
        } },
      });
      runtime.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports immutable mixed-resource state without exposing GPU handles or sources", async () => {
    installGpuGlobals();
    try {
      const f = fixture(), albedo = texture("albedo", 1);
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 136, maxUploadBytesPerFrame: 136, maxResources: 4, retainFrames: 0 },
        request => request.kind === "geometry" ? { kind: "geometry", source: geometry }
          : { kind: "texture", source: { level: request.level, texture: albedo } });
      runtime.register({ id: "mesh", revision: 3, kind: "geometry",
        levels: [{ level: 0, byteLength: 132 }] });
      runtime.register({ id: "albedo", revision: 7, kind: "texture",
        levels: [{ level: 0, byteLength: 4 }] });
      const before = runtime.telemetrySnapshot();
      expect(before).toMatchObject({ disposed: false, residencyRevision: 0,
        registeredResourceCount: 2, residentResourceCount: 0, residentBytes: 0, retiredBytes: 0 });
      expect(before.lastAppliedFrame).toBeUndefined();

      await runtime.submit(11, [
        { id: "mesh", kind: "geometry", desiredLevel: 0, required: true },
        { id: "albedo", kind: "texture", desiredLevel: 0, required: true },
      ]);
      const snapshot = runtime.telemetrySnapshot();
      expect(snapshot).toMatchObject({ disposed: false, residencyRevision: 1,
        registeredResourceCount: 2, residentResourceCount: 2,
        residentBytes: 136, retiredBytes: 0, allocatedBytes: 136,
        geometry: { residentResourceCount: 1, residentBytes: 132 },
        texture: { residentResourceCount: 1, residentBytes: 4 },
        budgets: { maxResidentBytes: 136, maxUploadBytesPerFrame: 136,
          maxResources: 4, retainFrames: 0, residentByteUtilization: 1,
          allocatedByteUtilization: 1, registeredResourceUtilization: 0.5 },
        lastAppliedFrame: { frame: 11, generation: 1, residencyRevision: 1,
          requestedResourceCount: 2, uploadedResourceCount: 2, uploadedBytes: 136,
          evictedResourceCount: 0, failedUploadCount: 0, qualityReducedResourceCount: 0,
          uploadBudgetUtilization: 1 } });
      expect(snapshot.resources).toEqual([
        { id: "albedo", kind: "texture", revision: 7, level: 0, byteLength: 4, lastUsedFrame: 11 },
        { id: "mesh", kind: "geometry", revision: 3, level: 0, byteLength: 132, lastUsedFrame: 11 },
      ]);
      expect(Object.keys(snapshot.resources[0]!)).toEqual([
        "id", "kind", "revision", "level", "byteLength", "lastUsedFrame",
      ]);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.resources)).toBe(true);
      expect(Object.isFrozen(snapshot.resources[0])).toBe(true);
      expect(Object.isFrozen(snapshot.budgets)).toBe(true);
      expect(Object.isFrozen(snapshot.lastAppliedFrame)).toBe(true);
      expect(before.residentBytes).toBe(0);
      const meshLease = runtime.acquire("geometry", "mesh")!;
      runtime.dispose();
      expect(runtime.telemetrySnapshot()).toMatchObject({ disposed: true,
        residentResourceCount: 0, residentBytes: 0, retiredBytes: 132, allocatedBytes: 132,
        budgets: { allocatedByteUtilization: 132 / 136 },
        lastAppliedFrame: { frame: 11 } });
      expect(f.owned.size).toBe(2);
      meshLease.release();
      expect(runtime.telemetrySnapshot()).toMatchObject({ disposed: true, retiredBytes: 0, allocatedBytes: 0 });
      expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("tracks quality reduction, leased retirement, failures, and terminal state", async () => {
    installGpuGlobals();
    try {
      const f = fixture(), high = texture("albedo-high", 2), low = texture("albedo-low", 1);
      const recorder = new ResidencyDiagnosticsWindow(32, true);
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 4, maxUploadBytesPerFrame: 4, maxResources: 3, retainFrames: 0 },
        request => request.id === "broken" ? { kind: "geometry", source: geometry }
          : { kind: "texture", source: { level: request.level,
            texture: request.id === "albedo-high" ? high : low } },
        { diagnostics: { recorder, clock: { now: () => 0 } }, deviceEpoch: "gpu-failure" });
      runtime.register({ id: "albedo", revision: 7, kind: "texture", levels: [
        { level: 0, byteLength: 16, sourceId: "albedo-high" },
        { level: 1, byteLength: 4, sourceId: "albedo-low" },
      ] });
      await runtime.submit(20, [{ id: "albedo", kind: "texture", desiredLevel: 0 }]);
      expect(runtime.telemetrySnapshot()).toMatchObject({
        residentBytes: 4, resources: [{ id: "albedo", revision: 7, level: 1 }],
        lastAppliedFrame: { frame: 20, uploadedResourceCount: 1, uploadedBytes: 4,
          qualityReducedResourceCount: 1, uploadBudgetUtilization: 1 },
      });

      const lease = runtime.acquire("texture", "albedo")!;
      await runtime.submit(21, []);
      expect(runtime.telemetrySnapshot()).toMatchObject({
        residentResourceCount: 0, residentBytes: 0, retiredBytes: 4, allocatedBytes: 4,
        budgets: { residentByteUtilization: 0, allocatedByteUtilization: 1 },
        lastAppliedFrame: { frame: 21, requestedResourceCount: 0,
          uploadedResourceCount: 0, evictedResourceCount: 1, failedUploadCount: 0 },
      });
      lease.release(); expect(runtime.telemetrySnapshot().allocatedBytes).toBe(0);

      runtime.register({ id: "broken", revision: 7, kind: "texture",
        levels: [{ level: 0, byteLength: 4 }] });
      await runtime.submit(22, [{ id: "broken", kind: "texture", desiredLevel: 0 }]);
      expect(runtime.telemetrySnapshot().lastAppliedFrame).toMatchObject({
        frame: 22, uploadedResourceCount: 0, uploadedBytes: 0,
        failedUploadCount: 1, qualityReducedResourceCount: 0,
      });
      expect(recorder.snapshot().domains.resource).toMatchObject({
        activity: { commit: 3, rollback: 1 }, residentBytes: 0, peakResidentBytes: 4,
      });
      runtime.dispose();
      expect(runtime.telemetrySnapshot()).toMatchObject({ disposed: true,
        residentResourceCount: 0, residentBytes: 0, retiredBytes: 0, allocatedBytes: 0 });
      expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
