import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuBufferResidencyUploader, type GpuBufferResidencySource } from "./gpuBufferResidencyUploader.js";

function source(changes: Partial<GpuBufferResidencySource> = {}): GpuBufferResidencySource {
  return { id: "mesh", revision: 1, level: 0, data: new Uint8Array([1, 2, 3, 4]), ...changes };
}

function request(changes: Partial<Parameters<GpuBufferResidencyUploader["upload"]>[0]> = {}) {
  return { id: "mesh", kind: "geometry" as const, revision: 1, level: 0, expectedByteLength: 4,
    signal: new AbortController().signal, ...changes };
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture() {
  const owned = new Set<object>(), buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { descriptor, destroy: vi.fn() };
      buffers.push(buffer); return buffer as unknown as GPUBuffer;
    }),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as GPUError | null),
    queue: { writeBuffer: vi.fn() },
  };
  const session = {
    state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); },
  } as unknown as DeviceSession;
  return { session, device, owned, buffers };
}

describe("GpuBufferResidencyUploader", () => {
  beforeEach(() => vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, COPY_DST: 8 }));
  afterEach(() => vi.unstubAllGlobals());

  it("charges five source bytes as eight aligned GPU budget bytes", async () => {
    const f = fixture(), uploader = new GpuBufferResidencyUploader(f.session, () => source({
      revision: 2, level: 1, data: new Uint8Array([1, 2, 3, 4, 5]), label: "streamed geometry", usage: 32,
    }));
    const result = await uploader.upload(request({ revision: 2, level: 1, expectedByteLength: 8 }));
    expect(result.byteLength).toBe(8);
    expect(f.device.createBuffer).toHaveBeenCalledWith({ label: "streamed geometry", size: 8, usage: 40 });
    expect(f.device.queue.writeBuffer).toHaveBeenCalledWith(result.handle, 0, expect.any(Uint8Array));
    const uploaded = f.device.queue.writeBuffer.mock.calls[0]![2] as Uint8Array;
    expect(Array.from(uploaded)).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
    expect(f.device.pushErrorScope.mock.calls.map(call => call[0]))
      .toEqual(["validation", "out-of-memory", "internal"]);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3); expect(f.owned.has(result.handle)).toBe(true);
    uploader.release(result.handle); uploader.release(result.handle);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    ["resource id", { id: "other" }, "identity differs"],
    ["revision", { revision: 0 }, "identity differs"],
    ["LOD", { level: 1 }, "level differs"],
  ] as const)("rejects a same-sized source with the wrong %s", async (_label, changes, message) => {
    const f = fixture(), uploader = new GpuBufferResidencyUploader(f.session, async () => source(changes));
    await expect(uploader.upload(request())).rejects.toThrow(message);
    expect(f.device.createBuffer).not.toHaveBeenCalled(); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
  });

  it("rejects texture work before consulting the geometry source provider", async () => {
    const f = fixture(), provider = vi.fn(() => source());
    const uploader = new GpuBufferResidencyUploader(f.session, provider);
    await expect(uploader.upload(request({ kind: "texture" }))).rejects.toThrow("only accepts geometry");
    expect(provider).not.toHaveBeenCalled(); expect(f.device.createBuffer).not.toHaveBeenCalled();
  });

  it("rejects an aligned allocation beyond maxBufferSize before GPU work", async () => {
    const f = fixture(); f.device.limits.maxBufferSize = 7;
    const uploader = new GpuBufferResidencyUploader(f.session,
      () => source({ data: new Uint8Array([1, 2, 3, 4, 5]) }));
    await expect(uploader.upload(request({ expectedByteLength: 8 }))).rejects.toThrow("maxBufferSize");
    expect(f.device.createBuffer).not.toHaveBeenCalled(); expect(f.device.pushErrorScope).not.toHaveBeenCalled();
  });

  it("releases a buffer if cancellation arrives after the queue write", async () => {
    const f = fixture(), controller = new AbortController();
    f.device.queue.writeBuffer.mockImplementation(() => controller.abort());
    const uploader = new GpuBufferResidencyUploader(f.session, () => source());
    await expect(uploader.upload(request({ signal: controller.signal })))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });

  it("releases a buffer after a synchronous write failure", async () => {
    const f = fixture(); f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(new GpuBufferResidencyUploader(f.session, () => source()).upload(request()))
      .rejects.toThrow("write failed");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });

  it.each([
    ["internal", 0], ["out-of-memory", 1], ["validation", 2],
  ] as const)("releases a buffer rejected by the %s GPU scope", async (scope, failureIndex) => {
    const f = fixture(); let popIndex = 0;
    f.device.popErrorScope.mockImplementation(async () => popIndex++ === failureIndex
      ? ({ message: `${scope} rejected` } as GPUError) : null);
    await expect(new GpuBufferResidencyUploader(f.session, () => source()).upload(request()))
      .rejects.toThrow(`GPU buffer residency upload failed: ${scope} rejected`);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });

  it.each(["throws", "rejects"] as const)("releases a buffer when scope inspection %s", async failure => {
    const f = fixture();
    if (failure === "throws") {
      f.device.popErrorScope.mockImplementationOnce(() => { throw new Error("scope inspection failed"); });
    } else f.device.popErrorScope.mockRejectedValueOnce(new Error("scope inspection failed"));
    await expect(new GpuBufferResidencyUploader(f.session, () => source()).upload(request()))
      .rejects.toThrow("scope inspection failed");
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
  });

  it("drains previously opened scopes if scope setup throws", async () => {
    const f = fixture();
    f.device.pushErrorScope.mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error("scope setup failed"); });
    await expect(new GpuBufferResidencyUploader(f.session, () => source()).upload(request()))
      .rejects.toThrow("scope setup failed");
    expect(f.device.popErrorScope).toHaveBeenCalledOnce(); expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.owned.size).toBe(0);
  });

  it("cancels promptly while GPU validation is pending and releases the buffer", async () => {
    const f = fixture(), pending = deferred<GPUError | null>(), controller = new AbortController();
    f.device.popErrorScope.mockReturnValueOnce(pending.promise);
    const active = new GpuBufferResidencyUploader(f.session, () => source())
      .upload(request({ signal: controller.signal }));
    await vi.waitFor(() => expect(f.device.popErrorScope).toHaveBeenCalledTimes(3));
    controller.abort();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(f.buffers[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    pending.resolve(null);
  });
});
