import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { VolumetricFogPass } from "./volumetricFogPass.js";
import { VOLUMETRIC_FOG_MARCH_WGSL } from "./volumetricFogPassWgsl.js";
import { VOLUMETRIC_FOG_DEPTH_FORMAT, VOLUMETRIC_FOG_SCATTER_FORMAT } from "./volumetricFogPassTypes.js";

interface FakeTexture extends GPUTexture { readonly descriptor?: GPUTextureDescriptor; readonly destroy: ReturnType<typeof vi.fn>; readonly createView: ReturnType<typeof vi.fn> }
function texture(width: number, height: number, format: GPUTextureFormat, usage = GPUTextureUsage.TEXTURE_BINDING, overrides: Partial<GPUTexture> = {}): FakeTexture {
  const value = { width, height, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format, usage,
    createView: vi.fn(() => ({})), destroy: vi.fn(), ...overrides };
  return value as unknown as FakeTexture;
}
function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), outputs: FakeTexture[] = [], buffers: Array<GPUBuffer & { destroy: ReturnType<typeof vi.fn> }> = [];
  const device = { limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535 }, queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })), createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })), createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => { const size = descriptor.size as GPUExtent3DDict;
      const value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage); Object.defineProperty(value, "descriptor", { value: descriptor }); outputs.push(value); return value; }),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => { const value = { label, size, usage, destroy: vi.fn() } as unknown as GPUBuffer & { destroy: ReturnType<typeof vi.fn> }; buffers.push(value); return value; }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device, own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, outputs, buffers };
}
function encoderFixture() {
  const passes: Array<{ label: string; pipeline?: { label: string }; dispatch?: [number, number] }> = [];
  const encoder = { beginComputePass: vi.fn(({ label }: { label: string }) => { const item = { label } as typeof passes[number]; passes.push(item);
    return { setPipeline: vi.fn((pipeline: { label: string }) => { item.pipeline = pipeline; }), setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn((x: number, y: number) => { item.dispatch = [x, y]; }), end: vi.fn() }; }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes };
}
function source(width = 13, height = 7, revision = 0) {
  return { depth: texture(width, height, "r32float"), revision, depthEncoding: "linear-view-depth-positive" as const };
}
const options = { verticalFovRadians: Math.PI / 3, steps: 48, maxDistance: 120,
  medium: { baseExtinction: 0.02, scaleHeight: 8, anisotropy: 0.3, albedo: 0.8 },
  light: { direction: [0.3, -0.8, 0.2] as const, radiance: [1, 0.95, 0.9] as const } };

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WebGPU half-resolution volumetric fog march", () => {
  it("reuses pooled scatter textures across frames without per-frame allocation", () => {
    const f = fixture(), encoder = encoderFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new VolumetricFogPass(f.session, pool), input = source();
    for (let revision = 0; revision < 3; revision += 1) {
      pool.beginFrame(); pass.encode(encoder.encoder, { ...input, revision }, options); pool.endFrame(true);
    }
    expect(pool.stats).toMatchObject({ acquireCount: 3, hits: 2, misses: 1, freeCount: 1 });
    expect(f.outputs).toHaveLength(1); expect(f.buffers).toHaveLength(1);
    const bindingCount = f.device.createBindGroup.mock.calls.length;
    pool.beginFrame(); pass.encode(encoder.encoder, { ...input, revision: 3 }, options); pool.endFrame(true);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
    pool.invalidateAll("surface-resize"); pool.beginFrame();
    pass.encode(encoder.encoder, source(17, 9, 4), options); pool.endFrame(true);
    expect(pool.stats).toMatchObject({ epoch: 1, misses: 2, evictedCount: 1 });
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it("discards the pooled scatter texture when binding construction fails", () => {
    const f = fixture(), encoder = encoderFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new VolumetricFogPass(f.session, pool); pool.beginFrame();
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("fog pooled bind failed"); });
    expect(() => pass.encode(encoder.encoder, source(), options)).toThrow("fog pooled bind failed");
    expect(pool.stats.pendingReturnCount).toBe(1); pool.endFrame(false);
    expect(pool.stats).toMatchObject({ discardedCount: 1, freeCount: 0 });
    expect(f.outputs.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it("encodes the half-resolution march dispatch and reuses exact revisions", () => {
    const f = fixture(), encoder = encoderFixture(), input = source(), pass = new VolumetricFogPass(f.session);
    const first = pass.encode(encoder.encoder, input, options);
    expect(first).toMatchObject({ width: 7, height: 4, sourceWidth: 13, sourceHeight: 7, updated: true,
      format: "rgba16float", passCount: 1, revision: 0 });
    expect(encoder.passes.map(item => [item.pipeline?.label, item.dispatch])).toEqual([
      ["Deep volumetric fog half-resolution march pipeline", [1, 1]],
    ]);
    const bindingCount = f.device.createBindGroup.mock.calls.length, passCount = encoder.passes.length;
    const cached = pass.encode(encoder.encoder, input, options); expect(cached.updated).toBe(false); expect(cached.texture).toBe(first.texture);
    expect(encoder.passes).toHaveLength(passCount); expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
    const revised = pass.encode(encoder.encoder, { ...input, revision: 1 }, options);
    expect(revised.texture).toBe(first.texture); expect(f.outputs).toHaveLength(1);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
    pass.dispose(); expect(f.owned.size).toBe(0);
  });
  it("resizes with ceil-half dimensions, releases old resources, and disposes idempotently", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new VolumetricFogPass(f.session);
    const first = pass.encode(encoder.encoder, source(8, 8, 0), options), second = pass.encode(encoder.encoder, source(17, 9, 1), options);
    expect([second.width, second.height]).toEqual([9, 5]); expect(second.texture).not.toBe(first.texture);
    expect(f.outputs.slice(0, 1).every(item => item.destroy.mock.calls.length === 1)).toBe(true);
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0);
    expect(f.outputs.every(item => item.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("rolls back a failed resize while preserving the published output", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new VolumetricFogPass(f.session);
    const first = pass.encode(encoder.encoder, source(8, 8, 0), options), candidateStart = f.outputs.length;
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      value.createView.mockImplementationOnce(() => { throw new Error("fog scatter view failed"); }); f.outputs.push(value); return value;
    });
    expect(() => pass.encode(encoder.encoder, source(17, 9, 1), options)).toThrow("fog scatter view failed");
    expect(first.texture.destroy).not.toHaveBeenCalled();
    expect(f.outputs.slice(candidateStart).every(item => item.destroy.mock.calls.length === 1)).toBe(true); pass.dispose();
  });
  it("fails closed on depth ambiguity, format, usage, revisions, options, and workgroup limits", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new VolumetricFogPass(f.session), valid = source();
    expect(() => pass.encode(encoder.encoder, { ...valid, depthEncoding: "device-depth" as never }, options)).toThrow("linearized");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "depth32float") }, options)).toThrow("r32float");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "r32float", 0) }, options)).toThrow("TEXTURE_BINDING");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "r32float", GPUTextureUsage.TEXTURE_BINDING, { sampleCount: 2 }) }, options)).toThrow("multisampled");
    expect(() => pass.encode(encoder.encoder, { ...valid, revision: -1 }, options)).toThrow("revision");
    pass.encode(encoder.encoder, valid, options);
    expect(() => pass.encode(encoder.encoder, { ...source(13, 7, 0) }, options)).toThrow("without a revision");
    expect(() => pass.encode(encoder.encoder, source(13, 7, 2), { ...options, steps: 31 })).toThrow(/steps/);
    f.device.limits.maxComputeWorkgroupsPerDimension = 1;
    expect(() => pass.encode(encoder.encoder, source(17, 17, 2), options)).toThrow("workgroup");
  });
  it("clears cached resources after device loss and rejects use after dispose", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new VolumetricFogPass(f.session), result = pass.encode(encoder.encoder, source(), options);
    f.rawSession.state = "lost"; expect(() => pass.encode(encoder.encoder, source(13, 7, 1), options)).toThrow("not ready");
    expect((result.texture as FakeTexture).destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    pass.dispose(); expect(() => pass.encode(encoder.encoder, source(13, 7, 2), options)).toThrow("disposed");
  });
  it("binds the declared formats and kernel entry point", () => {
    expect(VOLUMETRIC_FOG_SCATTER_FORMAT).toBe("rgba16float");
    expect(VOLUMETRIC_FOG_DEPTH_FORMAT).toBe("r32float");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toMatch(/fn marchVolumetricFog\(/);
  });
});
