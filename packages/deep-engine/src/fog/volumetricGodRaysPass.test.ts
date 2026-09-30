import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { VolumetricGodRaysPass, packGodRaysHostParameters } from "./volumetricGodRaysPass.js";
import { VOLUMETRIC_GOD_RAYS_CSM_WGSL, GOD_RAYS_HOST_PARAMETER_BYTES } from "./volumetricGodRaysPassWgsl.js";
import { VOLUMETRIC_GOD_RAYS_MARCH_WGSL } from "../lighting/volumetricGodRaysWgsl.js";
import type { GodRaysShadowSource } from "./volumetricGodRaysPassTypes.js";
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const options = { verticalFovRadians: 1, steps: 48, maxDistance: 100, strength: 2, viewToWorld: identity,
  medium: { baseExtinction: .02, scaleHeight: 20, anisotropy: .3, albedo: .8 }, light: { direction: [0, 0, -1] as const, radiance: [2, 2, 2] as const } };
function texture(width = 1920, height = 1080, overrides: Record<string, unknown> = {}) {
  return { width, height, format: "r32float", dimension: "2d", depthOrArrayLayers: 1, sampleCount: 1, usage: 1,
    createView: vi.fn(() => ({})), destroy: vi.fn(), ...overrides } as unknown as GPUTexture;
}
function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>();
  const device = { limits: { maxTextureDimension2D: 16384, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn((spec: GPUTextureDescriptor) => { const size = spec.size as GPUExtent3DDict;
      return texture(size.width, size.height as number, { format: spec.format, usage: spec.usage }); }),
    createBuffer: vi.fn((spec: GPUBufferDescriptor) => ({ ...spec, destroy: vi.fn() })),
  };
  const raw = { device, state: "ready", own<T extends GPUTexture | GPUBuffer>(item: T) { owned.add(item); return item; },
    release(item: GPUTexture | GPUBuffer) { if (owned.delete(item)) item.destroy(); } };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  const shadow = { uniform: { destroy: vi.fn() }, view: {}, sampler: {}, enabled: true } as unknown as GodRaysShadowSource;
  const source = { depth: texture(), revision: 1, depthEncoding: "linear-view-depth-positive" as const };
  return { owned, device, raw, session: raw as unknown as DeviceSession, pass, encoder, shadow, source };
}
beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 }); });
afterEach(() => vi.unstubAllGlobals());
describe("production god rays owner", () => {
  it("preserves the exact canonical march while adapting only the CSM shadow hook", () => {
    const entry = "@compute @workgroup_size(8, 8)";
    expect(VOLUMETRIC_GOD_RAYS_CSM_WGSL.slice(VOLUMETRIC_GOD_RAYS_CSM_WGSL.indexOf(entry)))
      .toBe(VOLUMETRIC_GOD_RAYS_MARCH_WGSL.slice(VOLUMETRIC_GOD_RAYS_MARCH_WGSL.indexOf(entry)));
    expect(GOD_RAYS_HOST_PARAMETER_BYTES).toBe(208);
    const parameters = packGodRaysHostParameters(1920, 1080, options, false);
    expect(new Uint32Array(parameters).slice(0, 4)).toEqual(new Uint32Array([1920, 1080, 960, 540]));
    expect(new Float32Array(parameters).slice(36)).toEqual(new Float32Array(identity));
    expect(new Uint32Array(parameters)[33]).toBe(0); expect(new Float32Array(parameters)[19]).toBe(2);
  });
  it("reuses one parameter/scatter pair and borrows the existing CSM without releasing it", () => {
    const f = fixture(), owner = new VolumetricGodRaysPass(f.session);
    expect(f.owned.size).toBe(0);
    const first = owner.encode(f.encoder, f.source, f.shadow, options);
    const second = owner.encode(f.encoder, { ...f.source, revision: 2 }, { ...f.shadow, enabled: false }, options);
    expect(second.texture).toBe(first.texture); expect(first.width).toBe(960); expect(first.height).toBe(540);
    expect(f.pass.dispatchWorkgroups).toHaveBeenLastCalledWith(120, 68);
    expect(f.device.createTexture).toHaveBeenCalledOnce(); expect(f.device.createBuffer).toHaveBeenCalledOnce();
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(2);
    owner.dispose(); owner.dispose(); expect(f.owned.size).toBe(0);
    expect(f.shadow.uniform.destroy).not.toHaveBeenCalled(); expect(f.source.depth.destroy).not.toHaveBeenCalled();
  });
  it("rejects invalid budgets/depth/matrix before allocating or encoding", () => {
    const f = fixture(), owner = new VolumetricGodRaysPass(f.session);
    for (const invalid of [{ ...options, strength: 9 }, { ...options, maxDistance: 1001 }, { ...options, steps: 31 },
      { ...options, viewToWorld: [] }, { ...options, viewToWorld: [...identity.slice(0, 15), Infinity] }])
      expect(() => owner.encode(f.encoder, f.source, f.shadow, invalid)).toThrow();
    expect(() => owner.encode(f.encoder, { ...f.source, depth: texture(1920, 1080, { sampleCount: 4 }) }, f.shadow, options)).toThrow();
    expect(f.owned.size).toBe(0); expect(f.encoder.beginComputePass).not.toHaveBeenCalled(); owner.dispose();
  });
  it("releases an unpublished resized target on upload failure and retains the valid target", () => {
    const f = fixture(), owner = new VolumetricGodRaysPass(f.session);
    const valid = owner.encode(f.encoder, f.source, f.shadow, options);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw Error("upload rejected"); });
    expect(() => owner.encode(f.encoder, { ...f.source, depth: texture(640, 360), revision: 2 }, f.shadow, options)).toThrow("upload rejected");
    expect(f.owned.size).toBe(2); expect(valid.texture.destroy).not.toHaveBeenCalled();
    expect(owner.encode(f.encoder, { ...f.source, revision: 3 }, f.shadow, options).texture).toBe(valid.texture);
    owner.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rejects ready replacement devices and loss before touching old GPU state", () => {
    const f = fixture(), owner = new VolumetricGodRaysPass(f.session);
    owner.encode(f.encoder, f.source, f.shadow, options); const count = f.pass.setPipeline.mock.calls.length;
    f.raw.device = { ...f.device };
    expect(() => owner.encode(f.encoder, f.source, f.shadow, options)).toThrow("GPU device changed");
    expect(f.pass.setPipeline).toHaveBeenCalledTimes(count);
    f.raw.device = f.device; f.raw.state = "lost";
    expect(() => owner.encode(f.encoder, f.source, f.shadow, options)).toThrow("not ready");
    owner.dispose(); expect(f.owned.size).toBe(0);
    expect(() => owner.encode(f.encoder, f.source, f.shadow, options)).toThrow("disposed");
  });
});
