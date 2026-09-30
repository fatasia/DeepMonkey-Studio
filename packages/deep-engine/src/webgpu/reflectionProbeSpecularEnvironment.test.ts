import { afterEach, describe, expect, it, vi } from "vitest";
import { createReflectionProbeSpecularEnvironment } from "./reflectionProbeSpecularEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";
import type { StudioEnvironment } from "./studioEnvironment.js";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, COPY_DST: 2, STORAGE_BINDING: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  const textures: { descriptor: GPUTextureDescriptor; value: GPUTexture }[] = [];
  const release = vi.fn(), writeTexture = vi.fn(), completed = vi.fn(async () => undefined);
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const device = { limits: { maxTextureDimension2D: 8192, minUniformBufferOffsetAlignment: 256 },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const value = { createView: vi.fn(() => ({})) } as unknown as GPUTexture;
      textures.push({ descriptor, value }); return value;
    }), createBuffer: vi.fn(() => ({})), createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createCommandEncoder: vi.fn(() => ({ beginComputePass: () => pass, finish: () => ({}) })),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null),
    queue: { writeTexture, writeBuffer: vi.fn(), submit: vi.fn(), onSubmittedWorkDone: completed } };
  const session = { state: "ready", device, own: (value: unknown) => value, release } as unknown as DeviceSession;
  const base = { specular: {}, diffuse: {}, brdf: {}, sampler: {}, dispose: vi.fn() } as StudioEnvironment;
  const pipeline = { getBindGroupLayout: () => ({}) } as GPUComputePipeline;
  const image = { width: 2, height: 1, data: new Float32Array([1, 2, 3, 4, 5, 6]) };
  return { session, device, base, pipeline, image, textures, release, pass, completed };
}
describe("local reflection specular ownership and budgets", () => {
  it("uploads one panorama, generates only specular mips, borrows base diffuse/LUT and releases temporaries", async () => {
    const f = fixture();
    const result = await createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, new AbortController().signal, { specularSize: 64 });
    expect(f.textures).toHaveLength(2); expect(f.device.queue.writeTexture).toHaveBeenCalledOnce();
    expect(f.textures[1]?.descriptor).toMatchObject({ size: { width: 64, height: 64, depthOrArrayLayers: 6 }, mipLevelCount: 7 });
    expect(f.pass.dispatchWorkgroups).toHaveBeenCalledTimes(7);
    expect(result.diffuse).toBe(f.base.diffuse); expect(result.brdf).toBe(f.base.brdf); expect(result.sampler).toBe(f.base.sampler);
    expect(result.specularBytes).toBe(262128); expect(result.uploadBytes).toBe(256); // Existing upload aligns rows to 256 bytes.
    expect(f.release).toHaveBeenCalledTimes(2); expect(f.release).not.toHaveBeenCalledWith(f.textures[1]?.value);
    result.dispose(); result.dispose(); expect(f.release).toHaveBeenCalledTimes(3);
    expect(f.base.dispose).not.toHaveBeenCalled();
  });
  it("releases panorama/settings/cube when the epoch changes before publication", async () => {
    const f = fixture(); f.completed.mockImplementation(async () => { (f.session as unknown as { state: string }).state = "lost"; });
    await expect(createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, new AbortController().signal)).rejects.toThrow("epoch");
    expect(f.release).toHaveBeenCalledTimes(3); expect(f.base.dispose).not.toHaveBeenCalled();
  });
  it("validates pre-abort and source/quality budgets before allocation", async () => {
    const f = fixture(), abort = new AbortController(), reason = new Error("cancel probe"); abort.abort(reason);
    await expect(createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, abort.signal)).rejects.toBe(reason);
    const run = (options = {}) => createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, new AbortController().signal, options);
    await expect(run({ maxUploadBytes: 1 })).rejects.toThrow();
    await expect(run({ specularSize: 32 } as never)).rejects.toThrow("quality");
    expect(f.device.createTexture).not.toHaveBeenCalled(); expect(f.release).not.toHaveBeenCalled();
  });
  it("rejects a replacement device even when the recovered session is already ready", async () => {
    const f = fixture();
    f.completed.mockImplementation(async () => { (f.session as unknown as { device: unknown }).device = { replacement: true }; });
    await expect(createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, new AbortController().signal)).rejects.toThrow("epoch");
    expect(f.release).toHaveBeenCalledTimes(3);
  });
  it("preserves a GPU validation failure and releases every newly created allocation", async () => {
    const f = fixture(); f.device.popErrorScope.mockResolvedValue({ message: "bad cube view" } as never);
    await expect(createReflectionProbeSpecularEnvironment(f.session, f.image, f.base, f.pipeline, new AbortController().signal)).rejects.toThrow("bad cube view");
    expect(f.release).toHaveBeenCalledTimes(3); expect(f.base.dispose).not.toHaveBeenCalled();
  });
});
