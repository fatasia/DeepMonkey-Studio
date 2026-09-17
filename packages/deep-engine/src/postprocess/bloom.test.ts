import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import { BloomPass } from "./bloom.js";
import { bloomPyramidSizes, extractBloomColor } from "./bloomCpu.js";
import { BLOOM_WGSL } from "./bloomWgsl.js";

interface FakeTexture extends GPUTexture {
  readonly descriptor?: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}

const options = { threshold: 1, softKnee: 0.5, intensity: 0.8, maxLevels: 4 } as const;

function texture(width: number, height: number, format: GPUTextureFormat = "rgba16float", usage = GPUTextureUsage.TEXTURE_BINDING): FakeTexture {
  return { width, height, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format, usage,
    createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as FakeTexture;
}

function source(revision = 0, width = 32, height = 16, existing?: ReturnType<typeof source>) {
  return { color: existing?.color ?? texture(width, height), revision, colorEncoding: "linear-hdr" as const };
}

function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), outputs: FakeTexture[] = [];
  const device = {
    limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535 }, queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label, entries }: { label: string; entries: readonly GPUBindGroupLayoutEntry[] }) => ({ label, entries })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      const value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      Object.defineProperty(value, "descriptor", { value: descriptor }); outputs.push(value); return value;
    }),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => ({ label, size, usage, destroy: vi.fn() })),
    createBindGroup: vi.fn(({ label }: { label: string }) => ({ label })),
  };
  const session = { state: "ready", device,
    own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, outputs };
}

function encoderFixture() {
  const passes: Array<{ label: string; pipeline?: { label: string }; binding?: { label: string }; dispatch?: [number, number] }> = [];
  const encoder = { beginComputePass: vi.fn(({ label }: { label: string }) => {
    const item = { label } as typeof passes[number]; passes.push(item);
    return { setPipeline: vi.fn((pipeline: { label: string }) => { item.pipeline = pipeline; }),
      setBindGroup: vi.fn((_index: number, binding: { label: string }) => { item.binding = binding; }),
      dispatchWorkgroups: vi.fn((x: number, y: number) => { item.dispatch = [x, y]; }), end: vi.fn() };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, RENDER_ATTACHMENT: 4, COPY_SRC: 8 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("HDR bloom", () => {
  it("reuses the pooled pyramid and warmed bind-group permutations across frames", () => {
    const f = fixture(), encoder = encoderFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new BloomPass(f.session, pool), initial = source();
    for (let revision = 0; revision < 3; revision += 1) {
      pool.beginFrame(); pass.encode(encoder.encoder, source(revision, 32, 16, initial), options); pool.endFrame(true);
    }
    expect(pool.stats).toMatchObject({ acquireCount: 36, hits: 24, misses: 12, freeCount: 12 });
    expect(f.outputs).toHaveLength(12); expect(f.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(32);
    const bindings = f.device.createBindGroup.mock.calls.length;
    pool.beginFrame(); pass.encode(encoder.encoder, source(3, 32, 16, initial), options); pool.endFrame(true);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindings);
    pool.invalidateAll("surface-resize"); pool.beginFrame();
    pass.encode(encoder.encoder, source(4, 64, 32), options); pool.endFrame(true);
    expect(pool.stats).toMatchObject({ epoch: 1, misses: 24, evictedCount: 12 });
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it("discards the complete pooled pyramid when binding creation fails", () => {
    const f = fixture(), encoder = encoderFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new BloomPass(f.session, pool); pool.beginFrame();
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("Bloom pooled bind failed"); });
    expect(() => pass.encode(encoder.encoder, source(), options)).toThrow("Bloom pooled bind failed");
    expect(pool.stats.pendingReturnCount).toBe(12); pool.endFrame(false);
    expect(pool.stats).toMatchObject({ discardedCount: 12, freeCount: 0 });
    expect(f.outputs.every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("is Naga-valid", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-bloom.wgsl", "--input-kind", "wgsl"], { input: BLOOM_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("uses a soft-knee extraction and safely truncates tiny pyramids", () => {
    expect(extractBloomColor([0.5, 0.25, 0.1], options)).toEqual([0, 0, 0]);
    expect(extractBloomColor([1, 1, 1], options)[0]).toBeCloseTo(0.125, 7);
    expect(extractBloomColor([2, 1, 0], options)).toEqual([1, 0.5, 0]);
    expect(bloomPyramidSizes(32, 16, 4)).toEqual([
      { width: 16, height: 8 }, { width: 8, height: 4 }, { width: 4, height: 2 }, { width: 2, height: 1 },
    ]);
    expect(bloomPyramidSizes(1, 1, 8)).toEqual([{ width: 1, height: 1 }]);
    expect(bloomPyramidSizes(3, 2, 8)).toEqual([{ width: 2, height: 1 }, { width: 1, height: 1 }]);
  });

  it("encodes extraction, four-level Gaussian pyramid, upsample, and HDR composite", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new BloomPass(f.session), firstSource = source();
    const first = pass.encode(encoder.encoder, firstSource, options);
    expect(first).toMatchObject({ width: 32, height: 16, revision: 0, format: "rgba16float", updated: true,
      colorEncoding: "linear-hdr", passCount: 16 });
    expect(first.levels).toEqual([{ width: 16, height: 8 }, { width: 8, height: 4 }, { width: 4, height: 2 }, { width: 2, height: 1 }]);
    expect(encoder.passes).toHaveLength(16);
    expect(encoder.passes.map(item => item.pipeline?.label)).toEqual([
      "Deep bloom threshold extract pipeline", ...Array(3).fill("Deep bloom downsample pipeline"),
      ...Array(4).fill(0).flatMap(() => ["Deep bloom horizontal Gaussian pipeline", "Deep bloom vertical Gaussian pipeline"]),
      ...Array(3).fill("Deep bloom progressive upsample pipeline"), "Deep bloom HDR scene composite pipeline",
    ]);
    expect(encoder.passes[0]?.dispatch).toEqual([2, 1]); expect(encoder.passes.at(-1)?.dispatch).toEqual([4, 2]);
    expect(f.outputs.at(-1)?.descriptor?.usage).toBe(
      GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
  });

  it("does not recreate pipelines or textures on stable size and level count", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new BloomPass(f.session), firstSource = source();
    const first = pass.encode(encoder.encoder, firstSource, options), textureCount = f.device.createTexture.mock.calls.length;
    const pipelineCount = f.device.createComputePipeline.mock.calls.length, bindingCount = f.device.createBindGroup.mock.calls.length;
    expect(pass.encode(encoder.encoder, firstSource, options)).toMatchObject({ texture: first.texture, updated: false });
    expect(pass.encode(encoder.encoder, source(1, 32, 16, firstSource), options).texture).toBe(first.texture);
    expect(pass.encode(encoder.encoder, source(2, 32, 16, firstSource), { ...options, intensity: 1 }).texture).toBe(first.texture);
    expect(f.device.createTexture).toHaveBeenCalledTimes(textureCount);
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(pipelineCount);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
  });

  it("rolls back resize failure, replaces resources transactionally, and disposes", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new BloomPass(f.session);
    const first = pass.encode(encoder.encoder, source(), options);
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      value.createView.mockImplementationOnce(() => { throw new Error("Bloom view failed"); }); f.outputs.push(value); return value;
    });
    expect(() => pass.encode(encoder.encoder, source(1, 64, 32), options)).toThrow("Bloom view failed");
    expect(pass.current?.texture).toBe(first.texture); expect(first.texture.destroy).not.toHaveBeenCalled();
    const resized = pass.encode(encoder.encoder, source(1, 64, 32), options);
    expect(resized.texture).not.toBe(first.texture); expect(first.texture.destroy).toHaveBeenCalledOnce();
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0);
  });

  it("fails closed on source contracts, revisions, parameters, limits, loss, and dispose", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new BloomPass(f.session), valid = source();
    expect(() => pass.encode(encoder.encoder, { ...valid, colorEncoding: "srgb" as never }, options)).toThrow("linear HDR");
    expect(() => pass.encode(encoder.encoder, { ...valid, color: texture(32, 16, "rgba8unorm") }, options)).toThrow("rgba16float");
    expect(() => pass.encode(encoder.encoder, { ...valid, color: texture(32, 16, "rgba16float", 0) }, options)).toThrow("TEXTURE_BINDING");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, threshold: -1 })).toThrow("threshold");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, softKnee: 2 })).toThrow("softKnee");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, intensity: Number.NaN })).toThrow("intensity");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, maxLevels: 3 })).toThrow("maxLevels");
    pass.encode(encoder.encoder, valid, options);
    expect(() => pass.encode(encoder.encoder, source(0), options)).toThrow("without a revision");
    expect(() => pass.encode(encoder.encoder, { ...valid, revision: -1 }, options)).toThrow("revision");
    f.rawSession.state = "lost"; expect(pass.current).toBeUndefined(); expect(f.owned.size).toBe(0);
    expect(() => pass.encode(encoder.encoder, source(1), options)).toThrow("not ready");
    pass.dispose(); expect(() => pass.encode(encoder.encoder, source(2), options)).toThrow("disposed");
  });
});
