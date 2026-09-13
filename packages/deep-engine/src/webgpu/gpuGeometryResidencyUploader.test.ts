import { describe, expect, it, vi } from "vitest";
import type { GeometryResource } from "../renderPacketTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuGeometryResidencyUploader } from "./gpuGeometryResidencyUploader.js";

const geometry = (revision = 2, id = "asset"): GeometryResource => ({ id, revision,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });

function fixture() {
  const owned = new Set<object>(), buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const device = { createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
    const buffer = { descriptor, destroy: vi.fn() }; buffers.push(buffer); return buffer as unknown as GPUBuffer;
  }), pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    queue: { writeBuffer: vi.fn() } };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, device, owned, buffers };
}

const request = (changes: Partial<Parameters<GpuGeometryResidencyUploader["upload"]>[0]> = {}) => ({
  id: "asset", kind: "geometry" as const, revision: 2, level: 1, expectedByteLength: 132,
  signal: new AbortController().signal, ...changes,
});

describe("GpuGeometryResidencyUploader", () => {
  it("uploads a complete indexed mesh with the exact draw-ready byte count", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    try {
      const f = fixture(), uploader = new GpuGeometryResidencyUploader(f.session, () => geometry());
      const result = await uploader.upload(request());
      expect(result.byteLength).toBe(132); expect(result.handle.mesh.indexCount).toBe(3);
      expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(2); expect(f.owned.size).toBe(2);
      uploader.release(result.handle); expect(f.owned.size).toBe(0);
      for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([
    ["texture kind", { kind: "texture" as const }, "only accepts geometry"],
    ["stale revision", {}, "revision differs"],
    ["wrong identity", {}, "identity differs"],
    ["wrong byte plan", { expectedByteLength: 131 }, "byte count differs"],
  ])("rejects %s before publishing a handle", async (_label, changes, message) => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    try {
      const f = fixture(), source = _label === "wrong identity" ? geometry(2, "other")
        : changes.kind ? geometry() : geometry(1);
      const uploader = new GpuGeometryResidencyUploader(f.session, () => source);
      const actual = message === "byte count differs" ? request({ ...changes, revision: 1 })
        : _label === "wrong identity" ? request() : request(changes);
      await expect(uploader.upload(actual)).rejects.toThrow(message);
      expect(f.owned.size).toBe(0);
    } finally { vi.unstubAllGlobals(); }
  });

  it("releases every mesh buffer when cancellation arrives during upload", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    try {
      const f = fixture(), abort = new AbortController();
      f.device.queue.writeBuffer.mockImplementationOnce(() => abort.abort());
      const uploader = new GpuGeometryResidencyUploader(f.session, () => geometry());
      await expect(uploader.upload(request({ signal: abort.signal }))).rejects.toMatchObject({ name: "AbortError" });
      expect(f.owned.size).toBe(0);
      for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("waits for GPU validation and releases a rejected mesh", async () => {
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
    try {
      const f = fixture();
      f.device.popErrorScope.mockResolvedValueOnce({ message: "driver rejected geometry" } as GPUError);
      const uploader = new GpuGeometryResidencyUploader(f.session, () => geometry());
      await expect(uploader.upload(request())).rejects.toThrow("driver rejected geometry");
      expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3);
      expect(f.device.popErrorScope).toHaveBeenCalledTimes(3); expect(f.owned.size).toBe(0);
      for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});
