import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuResidencyRuntime } from "./gpuResidencyRuntime.js";
import { DeviceResourceMemory } from "./deviceResourceMemory.js";

describe("GpuResidencyRuntime", () => {
  it("keeps the drawable coarse allocation when a wider device budget rejects another upload", async () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8 });
    try {
      const memory = new DeviceResourceMemory(64), owned = new Set<object>();
      const device = { lost: new Promise<void>(() => {}), limits: { maxBufferSize: 1024 },
        pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
        createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ size: d.size, destroy: vi.fn() })),
        queue: { writeBuffer: vi.fn() } };
      const session = { state: "ready", device, assertResourceAdmission: (d: object) => memory.assertCanAdd(d),
        own<T extends object>(resource: T) { memory.add(resource); owned.add(resource); return resource; },
        release(resource: { destroy(): void }) { if (owned.delete(resource)) { memory.remove(resource); resource.destroy(); } },
      } as unknown as DeviceSession;
      const runtime = new GpuResidencyRuntime(session, { maxResidentBytes: 128, maxUploadBytesPerFrame: 128 },
        request => ({ id: request.id, revision: request.revision, level: request.level,
          data: new Uint8Array(request.expectedByteLength) }));
      runtime.controller.register({ id: "coarse", revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 32 }] });
      runtime.controller.register({ id: "candidate", revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 64 }] });
      await runtime.submit(1, [{ id: "coarse", desiredLevel: 0 }]);
      const old = runtime.executor.get("coarse")!;
      const result = await runtime.submit(2, [{ id: "coarse", desiredLevel: 0, required: true }, { id: "candidate", desiredLevel: 0 }]);
      expect(result.status).toBe("applied");
      expect(runtime.executor.get("candidate")).toBeUndefined();
      expect(runtime.executor.get("coarse")!.handle).toBe(old.handle);
      expect(device.createBuffer).toHaveBeenCalledOnce();
      expect(memory.snapshot).toMatchObject({ estimatedBytes: 32, peakEstimatedBytes: 32, admission: { rejectedCount: 1 } });
      runtime.dispose(); expect(memory.snapshot.estimatedBytes).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
  it("binds scheduler, controller, uploader and device loss to one runtime", async () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8 });
    try {
      const owned = new Set<object>(), deviceLost = new Promise<void>(() => {});
      const device = { lost: deviceLost, limits: { maxBufferSize: 256 * 1024 * 1024 },
        pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
        createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
        queue: { writeBuffer: vi.fn() } };
      const session = { state: "ready", device,
        own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
        release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
      } as unknown as DeviceSession;
      const runtime = new GpuResidencyRuntime(session, { maxResidentBytes: 64, maxUploadBytesPerFrame: 64 },
        request => ({ id: request.id, revision: request.revision, level: request.level,
          data: new Uint8Array(request.expectedByteLength) }));
      runtime.controller.register({ id: "mesh", revision: 1, kind: "geometry", levels: [{ level: 0, byteLength: 4 }] });
      await expect(runtime.submit(1, [{ id: "mesh", desiredLevel: 0 }])).resolves.toMatchObject({ status: "applied" });
      expect(runtime.executor.get("mesh")?.byteLength).toBe(4);
      runtime.dispose(); expect(runtime.executor.disposed).toBe(true); expect(owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });
});
