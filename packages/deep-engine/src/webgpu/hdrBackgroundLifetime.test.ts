import { afterEach, describe, expect, it, vi } from "vitest";
import { createHdrEnvironment } from "./hdrEnvironment.js";
import type { DeviceSession } from "./deviceSession.js";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal("GPUTextureUsage", { COPY_DST: 1, TEXTURE_BINDING: 2, STORAGE_BINDING: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 1, COPY_DST: 2 });
  const owned = new Set<object>(), textures: Array<{ label: string; destroy: ReturnType<typeof vi.fn> }> = [];
  const pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 }, pushErrorScope() {}, popErrorScope: vi.fn(async () => null),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: (descriptor: GPUTextureDescriptor) => {
      const resource = { label: descriptor.label!, destroy: vi.fn(), createView: () => ({ label: descriptor.label }) };
      textures.push(resource); return resource;
    },
    createBuffer: () => ({ destroy: vi.fn() }), createSampler: () => ({}), createBindGroup: () => ({}),
    createCommandEncoder: () => ({ beginComputePass: () => pass, finish: () => ({}) }),
    queue: { writeTexture: vi.fn(), writeBuffer() {}, submit() {}, onSubmittedWorkDone: async () => {} },
  };
  const session = { state: "ready", device, own: (r: object) => { owned.add(r); return r; },
    release: (r: { destroy(): void }) => { if (owned.delete(r)) r.destroy(); } } as unknown as DeviceSession;
  return { session, owned, textures, device };
}
const image = { width: 1, height: 1, data: new Float32Array([1, 0.5, 0.25]) };
describe("HDR background lifetime", () => {
  it("retains the panorama after IBL prefilter and destroys it exactly once with the environment", async () => {
    const f = fixture(), environment = await createHdrEnvironment(f.session, image);
    expect(environment.panorama?.view).toEqual({ label: "Deep HDR panorama" });
    expect(f.owned.size).toBe(4);
    expect(f.textures[0]!.destroy).not.toHaveBeenCalled();
    environment.dispose(); environment.dispose();
    expect(f.owned.size).toBe(0);
    f.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledOnce());
  });
  it("keeps an independent background while retiring the IBL-only source", async () => {
    const f = fixture(), environment = await createHdrEnvironment(f.session, image, {}, undefined,
      { width: 1, height: 1, data: new Float32Array([0, 2, 4]) });
    expect(f.device.queue.writeTexture).toHaveBeenCalledTimes(2);
    expect(environment.panorama?.view).toEqual({ label: "Deep HDR background" });
    expect(f.textures[0]!.destroy).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(4);
    environment.dispose(); expect(f.owned.size).toBe(0);
  });
  it("releases both images and derived textures on GPU validation failure", async () => {
    const f = fixture(); f.device.popErrorScope.mockResolvedValueOnce({ message: "invalid" } as never);
    await expect(createHdrEnvironment(f.session, image, {}, undefined,
      { width: 1, height: 1, data: new Float32Array([1, 2, 3]) })).rejects.toThrow("validation failed");
    expect(f.owned.size).toBe(0);
    f.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledOnce());
  });
  it("rejects malformed independent background before allocating", async () => {
    const f = fixture();
    await expect(createHdrEnvironment(f.session, image, {}, undefined,
      { width: 1, height: 1, data: new Float32Array([NaN, 0, 0]) })).rejects.toThrow("invalid radiance");
    expect(f.owned.size).toBe(0); expect(f.textures).toHaveLength(0);
  });
});
