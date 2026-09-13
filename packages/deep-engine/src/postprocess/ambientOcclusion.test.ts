import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { AmbientOcclusionPass, ambientOcclusionHalfSize } from "./ambientOcclusion.js";
import { AMBIENT_OCCLUSION_BLUR_WGSL, AMBIENT_OCCLUSION_EVALUATE_WGSL } from "./ambientOcclusionWgsl.js";

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
function source(width = 13, height = 7, revision = 0) { return { depth: texture(width, height, "r32float"), normal: texture(width, height, "rgba8unorm"),
  revision, depthEncoding: "linear-view-depth-positive" as const, normalSpace: "view" as const }; }
const options = { verticalFovRadians: Math.PI / 2, radius: 2, thickness: 0.1, power: 1.5 } as const;

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("WebGPU half-resolution ambient occlusion", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga validation for AO and bilateral blur", () => {
    for (const [name, code] of [["evaluate", AMBIENT_OCCLUSION_EVALUATE_WGSL], ["blur", AMBIENT_OCCLUSION_BLUR_WGSL]] as const) {
      const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", `deep-ao-${name}.wgsl`, "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
      expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe(""); expect(validation.stdout).toContain("Validation successful");
    }
  });
  it("encodes half-resolution AO plus horizontal/vertical bilateral passes and reuses exact revisions", () => {
    const f = fixture(), encoder = encoderFixture(), input = source(), pass = new AmbientOcclusionPass(f.session);
    const first = pass.encode(encoder.encoder, input, options);
    expect(first).toMatchObject({ width: 7, height: 4, sourceWidth: 13, sourceHeight: 7, updated: true,
      format: "r32float", depthEncoding: "linear-view-depth-positive", sampleCount: 16 });
    expect(encoder.passes.map(item => [item.pipeline?.label, item.dispatch])).toEqual([
      ["Deep half-resolution ambient occlusion pipeline", [1, 1]], ["Deep ambient occlusion horizontal bilateral pipeline", [1, 1]],
      ["Deep ambient occlusion vertical bilateral pipeline", [1, 1]],
    ]);
    const bindingCount = f.device.createBindGroup.mock.calls.length, passCount = encoder.passes.length;
    const cached = pass.encode(encoder.encoder, input, options); expect(cached.updated).toBe(false); expect(cached.texture).toBe(first.texture);
    expect(encoder.passes).toHaveLength(passCount); expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
    const revised = pass.encode(encoder.encoder, { ...input, revision: 1 }, options);
    expect(revised.texture).toBe(first.texture); expect(f.outputs).toHaveLength(3); expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
  });
  it("resizes with ceil-half dimensions, releases old resources, and disposes idempotently", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionPass(f.session);
    const first = pass.encode(encoder.encoder, source(8, 8, 0), options), second = pass.encode(encoder.encoder, source(17, 9, 1), options);
    expect([second.width, second.height]).toEqual([9, 5]); expect(second.texture).not.toBe(first.texture);
    expect(f.outputs.slice(0, 3).every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0); expect(f.outputs.every(texture => texture.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("rolls back a failed resize while preserving the published output", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionPass(f.session);
    const first = pass.encode(encoder.encoder, source(8, 8, 0), options), candidateStart = f.outputs.length;
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      value.createView.mockImplementationOnce(() => { throw new Error("AO output view failed"); }); f.outputs.push(value); return value;
    });
    expect(() => pass.encode(encoder.encoder, source(17, 9, 1), options)).toThrow("AO output view failed");
    expect(pass.current?.texture).toBe(first.texture); expect((first.texture as FakeTexture).destroy).not.toHaveBeenCalled();
    expect(f.outputs.slice(candidateStart).every(texture => texture.destroy.mock.calls.length === 1)).toBe(true); pass.dispose();
  });
  it("fails closed on depth ambiguity, format, usage, size, revisions, and workgroup limits", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionPass(f.session), valid = source();
    expect(() => pass.encode(encoder.encoder, { ...valid, depthEncoding: "device-depth" as never }, options)).toThrow("linearized");
    expect(() => pass.encode(encoder.encoder, { ...valid, normalSpace: "world" as never }, options)).toThrow("view space");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "depth32float") }, options)).toThrow("r32float");
    expect(() => pass.encode(encoder.encoder, { ...valid, normal: texture(13, 7, "rgba16float") }, options)).toThrow("rgba8unorm");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "r32float", 0) }, options)).toThrow("TEXTURE_BINDING");
    expect(() => pass.encode(encoder.encoder, { ...valid, normal: texture(12, 7, "rgba8unorm") }, options)).toThrow("dimensions");
    pass.encode(encoder.encoder, valid, options); expect(() => pass.encode(encoder.encoder, { ...valid, revision: -1 }, options)).toThrow("revision");
    expect(() => pass.encode(encoder.encoder, { ...source(13, 7, 0) }, options)).toThrow("without a revision");
    f.device.limits.maxComputeWorkgroupsPerDimension = 1;
    expect(() => pass.encode(encoder.encoder, source(17, 17, 2), options)).toThrow("workgroup");
  });
  it("clears cached resources after device loss and rejects use after dispose", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionPass(f.session), result = pass.encode(encoder.encoder, source(), options);
    f.rawSession.state = "lost"; expect(() => pass.encode(encoder.encoder, source(13, 7, 1), options)).toThrow("not ready");
    expect((result.texture as FakeTexture).destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    pass.dispose(); expect(() => pass.encode(encoder.encoder, source(13, 7, 2), options)).toThrow("disposed");
  });
  it("computes safe half sizes", () => { expect(ambientOcclusionHalfSize(1, 1)).toEqual([1, 1]); expect(ambientOcclusionHalfSize(13, 8)).toEqual([7, 4]); });
});
