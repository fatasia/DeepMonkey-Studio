import { describe, expect, it, vi } from "vitest";
import type { GeometryResource } from "../renderPacketTypes.js";
import type { DecodedTexture } from "../textures/decodedTexture.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuRenderResidencyRuntime } from "./gpuRenderResidencyRuntime.js";

const geometry: GeometryResource = { id: "mesh", revision: 3,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) };

function texture(id: string, width: number): DecodedTexture {
  return { id, revision: 7, semantic: "baseColor", width, height: width,
    data: new Uint8Array(width * width * 4).fill(127) };
}

function fixture() {
  const owned = new Set<object>();
  const destroyable = () => ({ destroy: vi.fn() });
  const device = { lost: new Promise<void>(() => {}), features: new Set<GPUFeatureName>(),
    limits: { maxTextureDimension2D: 8192 }, pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
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
      const runtime = new GpuRenderResidencyRuntime(f.session,
        { maxResidentBytes: 4, maxUploadBytesPerFrame: 4, maxResources: 3, retainFrames: 0 },
        request => request.id === "broken" ? { kind: "geometry", source: geometry }
          : { kind: "texture", source: { level: request.level,
            texture: request.id === "albedo-high" ? high : low } });
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
      runtime.dispose();
      expect(runtime.telemetrySnapshot()).toMatchObject({ disposed: true,
        residentResourceCount: 0, residentBytes: 0, retiredBytes: 0, allocatedBytes: 0 });
      expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
