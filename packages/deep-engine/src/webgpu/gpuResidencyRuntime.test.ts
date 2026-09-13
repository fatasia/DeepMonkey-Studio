import { describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuResidencyRuntime } from "./gpuResidencyRuntime.js";

describe("GpuResidencyRuntime", () => {
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
