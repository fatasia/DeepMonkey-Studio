import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { AuthorBloomPass } from "./authorBloom.js";
import { AUTHOR_BLOOM_WGSL } from "./authorBloomWgsl.js";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../webgpu/pbrTransientTexturePool.js";
import type { BloomSource } from "./bloomTypes.js";
import { authorBloomCoefficients, authorBloomSizes, extractAuthorBloomColor, validateAuthorBloomOptions } from "./authorBloomCpu.js";
const options = { strength: 0.35, threshold: 0.9 };
function authorBloomFixture() {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
  const owned = new Set<GPUTexture | GPUBuffer>();
  const texture = (width = 32, height = 16, usage = 1) => ({ width, height, usage, format: "rgba16float", dimension: "2d",
    depthOrArrayLayers: 1, sampleCount: 1, destroy: vi.fn(), createView: vi.fn(function(this: GPUTexture) { return { texture: this }; }) }) as unknown as GPUTexture;
  const device = {
    limits: { maxTextureDimension2D: 16384, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn((descriptor: unknown) => descriptor),
    createBindGroupLayout: vi.fn((descriptor: unknown) => descriptor),
    createPipelineLayout: vi.fn((descriptor: unknown) => descriptor),
    createComputePipeline: vi.fn((descriptor: unknown) => descriptor),
    createBindGroup: vi.fn((descriptor: unknown) => descriptor),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() } as unknown as GPUBuffer)),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict; return texture(size.width, size.height, descriptor.usage);
    }),
  };
  const rawSession = { state: "ready", device,
    own<T extends GPUBuffer | GPUTexture>(value: T): T { owned.add(value); return value; },
    release(value: GPUBuffer | GPUTexture) { if (owned.delete(value)) value.destroy(); },
  };
  const passes: { pipeline?: GPUComputePipeline; binding?: GPUBindGroup; dispatch?: number[]; end: ReturnType<typeof vi.fn> }[] = [];
  const encoder = { beginComputePass: vi.fn(() => {
    const entry: typeof passes[number] = { end: vi.fn() }; passes.push(entry);
    return { setPipeline: (value: GPUComputePipeline) => { entry.pipeline = value; },
      setBindGroup: (_: number, value: GPUBindGroup) => { entry.binding = value; },
      dispatchWorkgroups: (...value: number[]) => { entry.dispatch = value; }, end: entry.end };
  }) };
  const source: BloomSource = { color: texture(), revision: 0, colorEncoding: "linear-hdr" };
  return { device, rawSession, session: rawSession as unknown as DeviceSession, owned, passes,
    encoder: encoder as unknown as GPUCommandEncoder, rawEncoder: encoder, texture, source };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("author bloom r185", () => {
  it("reuses the pooled fixed pyramid without per-frame buffer or bind-group churn", () => {
    const f = authorBloomFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new AuthorBloomPass(f.session, pool);
    for (let revision = 0; revision < 3; revision += 1) {
      pool.beginFrame(); pass.encode(f.encoder, { ...f.source, revision }, options); pool.endFrame(true);
    }
    expect(pool.stats).toMatchObject({ acquireCount: 39, hits: 26, misses: 13, freeCount: 13 });
    expect(f.device.createTexture).toHaveBeenCalledTimes(13); expect(f.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(26);
    const bindings = f.device.createBindGroup.mock.calls.length;
    pool.beginFrame(); pass.encode(f.encoder, { ...f.source, revision: 3 }, options); pool.endFrame(true);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindings);
    pool.invalidateAll("device-lost"); pool.beginFrame();
    pass.encode(f.encoder, { ...f.source, color: f.texture(64, 32), revision: 4 }, options); pool.endFrame(true);
    expect(pool.stats).toMatchObject({ epoch: 1, misses: 26, evictedCount: 13 });
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it("discards every pooled author bloom texture after an encode failure", () => {
    const f = authorBloomFixture(), pool = new PbrTransientTexturePool(f.session);
    const pass = new AuthorBloomPass(f.session, pool); pool.beginFrame();
    f.rawEncoder.beginComputePass.mockImplementationOnce(() => { throw new Error("Author bloom pooled encode failed"); });
    expect(() => pass.encode(f.encoder, f.source, options)).toThrow("Author bloom pooled encode failed");
    expect(pool.stats.pendingReturnCount).toBe(13); pool.endFrame(false);
    expect(pool.stats).toMatchObject({ discardedCount: 13, freeCount: 0 });
    pass.dispose(); pool.dispose(); expect(f.owned.size).toBe(0);
  });
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("validates all WGSL entrypoints with Naga", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!, ["--stdin-file-path", "author-bloom.wgsl", "--input-kind", "wgsl"],
      { input: AUTHOR_BLOOM_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
  });
  it("matches luminance threshold, fixed five tiny mips and unnormalized Gaussian coefficients", () => {
    expect(extractAuthorBloomColor([1, 0, 0], 0.9)).toEqual([0, 0, 0]);
    expect(extractAuthorBloomColor([0.905, 0.905, 0.905], 0.9)[0]).toBeCloseTo(0.4525, 10);
    expect(extractAuthorBloomColor([2, 2, 2], 0.9)).toEqual([2, 2, 2]);
    expect(authorBloomSizes(1, 1)).toEqual(Array(5).fill({ width: 1, height: 1 }));
    expect(authorBloomSizes(5, 3)).toEqual([{ width: 3, height: 2 }, { width: 2, height: 1 }, ...Array(3).fill({ width: 1, height: 1 })]);
    const kernel = authorBloomCoefficients(6);
    expect(kernel[0]).toBe(0.39894 / 2);
    expect(kernel[0]! + 2 * kernel.slice(1).reduce((sum, value) => sum + value, 0)).toBeLessThan(1);
  });
  it("matches installed Three r185 Gaussian uniforms and composite semantics", () => {
    const reference = new UnrealBloomPass(new Vector2(32, 16), options.strength, 0.25, options.threshold);
    const internals = reference as unknown as {
      separableBlurMaterials: { defines: { KERNEL_RADIUS: number }; uniforms: { gaussianCoefficients: { value: number[] } }; fragmentShader: string }[];
      compositeMaterial: { fragmentShader: string }; highPassUniforms: { smoothWidth: { value: number } };
    };
    for (const material of internals.separableBlurMaterials) {
      expect(authorBloomCoefficients(material.defines.KERNEL_RADIUS)).toEqual(material.uniforms.gaussianCoefficients.value);
      expect(material.fragmentShader).not.toContain("diffuseSum / weightSum");
    }
    expect(internals.highPassUniforms.smoothWidth.value).toBe(0.01);
    expect(internals.compositeMaterial.fragmentShader).toContain("3.0 * bloomStrength");
    expect(internals.compositeMaterial.fragmentShader).toContain("1.2 - factor");
    reference.dispose();
  });
  it.each([null, {}, [], { ...options, radius: 0.25 }, { ...options, strength: NaN }, { ...options, strength: -1 },
    { ...options, strength: 3.01 }, { ...options, threshold: Infinity }, { ...options, threshold: 1.01 }])("rejects malformed options %j", value => {
    expect(() => validateAuthorBloomOptions(value as never)).toThrow();
  });
  it("uses progressive blur bindings, a half-size combine then full-size additive composite", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session), result = pass.encode(f.encoder, f.source, options);
    expect(result.passCount).toBe(13); expect(f.passes).toHaveLength(13);
    const binding = (index: number) => (f.passes[index]!.binding as unknown as GPUBindGroupDescriptor).entries as { binding: number; resource: { texture?: GPUTexture; buffer?: GPUBuffer } }[];
    const target = (index: number) => binding(index).find(entry => entry.binding === 7)!.resource.texture!;
    const source = (index: number) => binding(index).find(entry => entry.binding === 0)!.resource.texture!;
    for (let index = 1; index <= 10; index++) expect(source(index)).toBe(target(index - 1));
    expect(target(11).width).toBe(16); expect(target(12).width).toBe(32);
    expect(binding(12).find(entry => entry.binding === 1)!.resource.texture).toBe(target(11));
    expect(source(12)).toBe(f.source.color);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(1);
    expect(f.passes[3]!.pipeline).toMatchObject({ compute: { entryPoint: "horizontal1" } });
    expect(f.passes[4]!.pipeline).toMatchObject({ compute: { entryPoint: "vertical1" } });
    pass.dispose(); expect(f.owned.size).toBe(0);
  });
  it("reuses resources but reencodes cancelled/unsubmitted revisions and hot parameter changes", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session);
    const first = pass.encode(f.encoder, f.source, options), count = f.device.createTexture.mock.calls.length;
    expect(pass.encode(f.encoder, f.source, options)).toMatchObject({ texture: first.texture, updated: true });
    pass.encode(f.encoder, { ...f.source, revision: 1 }, { strength: 3, threshold: 0 });
    expect(f.device.createTexture).toHaveBeenCalledTimes(count);
    expect(f.device.queue.writeBuffer.mock.calls.at(-1)![2]).toEqual(new Float32Array([0, 3, 0, 0]));
    expect(f.passes).toHaveLength(39);
    expect(f.passes[26]!.binding).toBe(f.passes[0]!.binding);
    pass.dispose();
  });
  it("retains prior resources after allocation/encode failure and cleans resize/disposal", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session), first = pass.encode(f.encoder, f.source, options);
    const baseline = f.owned.size;
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    const resized = { ...f.source, color: f.texture(64, 32), revision: 1 };
    expect(() => pass.encode(f.encoder, resized, options)).toThrow("binding failed");
    expect(f.owned.size).toBe(baseline); expect(pass.current!.texture).toBe(first.texture);
    f.rawEncoder.beginComputePass.mockImplementationOnce(() => { throw new Error("encoder failed"); });
    expect(() => pass.encode(f.encoder, resized, options)).toThrow("encoder failed");
    expect(f.owned.size).toBe(baseline);
    expect(pass.encode(f.encoder, resized, options).texture).not.toBe(first.texture);
    expect(first.texture.destroy).toHaveBeenCalledOnce();
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0);
    expect(() => pass.encode(f.encoder, resized, options)).toThrow("disposed");
  });
  it("rejects invalid source/revision/device limits and releases on loss", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session);
    expect(() => pass.encode(f.encoder, { ...f.source, revision: -1 }, options)).toThrow("revision");
    expect(() => pass.encode(f.encoder, { ...f.source, colorEncoding: "srgb" as never }, options)).toThrow("linear HDR");
    expect(() => pass.encode(f.encoder, { ...f.source, color: f.texture(2, 2, 0) }, options)).toThrow("TEXTURE_BINDING");
    expect(() => pass.encode(f.encoder, { ...f.source, color: f.texture(16385, 2) }, options)).toThrow("limits");
    pass.encode(f.encoder, { ...f.source, revision: 2 }, options);
    expect(() => pass.encode(f.encoder, f.source, options)).toThrow("Stale");
    expect(() => pass.encode(f.encoder, { ...f.source, color: f.texture(), revision: 2 }, options)).toThrow("without a revision");
    f.rawSession.state = "lost"; expect(pass.current).toBeUndefined(); expect(f.owned.size).toBe(0);
    expect(() => pass.encode(f.encoder, f.source, options)).toThrow("not ready");
  });
  it("encodes all fixed mips at 1px and ends a failing compute pass", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session), tiny = { ...f.source, color: f.texture(1, 1) };
    pass.encode(f.encoder, tiny, { strength: 0, threshold: 0 });
    expect(f.passes.every(entry => entry.dispatch?.[0] === 1 && entry.dispatch[1] === 1)).toBe(true);
    const end = vi.fn();
    f.rawEncoder.beginComputePass.mockImplementationOnce(() => ({ setPipeline: () => { throw new Error("encode failure"); },
      setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end }));
    expect(() => pass.encode(f.encoder, { ...tiny, revision: 1 }, options)).toThrow("encode failure");
    expect(end).toHaveBeenCalledOnce();
    expect(pass.encode(f.encoder, { ...tiny, revision: 1 }, options).revision).toBe(1);
    pass.dispose(); expect(f.owned.size).toBe(0);
  });
  it("detaches cache and attempts every release even when a destructor throws", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session);
    pass.encode(f.encoder, f.source, options);
    const owned = [...f.owned], first = owned[0]!;
    vi.mocked(first.destroy).mockImplementationOnce(() => { throw new Error("destroy failed"); });
    expect(() => pass.dispose()).toThrow("cleanup failed");
    expect(f.owned.size).toBe(0); expect(pass.current).toBeUndefined();
    for (const resource of owned) expect(resource.destroy).toHaveBeenCalledOnce();
    expect(() => pass.dispose()).not.toThrow();
  });
  it("preserves allocation failure alongside cleanup errors", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session);
    f.device.createBindGroup.mockImplementationOnce(() => {
      vi.mocked([...f.owned][0]!.destroy).mockImplementationOnce(() => { throw new Error("cleanup failed"); });
      throw new Error("binding failed");
    });
    let observed: unknown;
    try { pass.encode(f.encoder, f.source, options); } catch (error) { observed = error; }
    expect(observed).toBeInstanceOf(AggregateError);
    expect((observed as AggregateError).errors[0].message).toBe("binding failed");
    expect(f.owned.size).toBe(0); expect(pass.current).toBeUndefined();
  });
  it("keeps the replacement alive when retiring the old allocation fails", () => {
    const f = authorBloomFixture(), pass = new AuthorBloomPass(f.session);
    const old = pass.encode(f.encoder, f.source, options), baseline = f.owned.size;
    vi.mocked(old.texture.destroy).mockImplementationOnce(() => { throw new Error("retire failed"); });
    const resized = { ...f.source, color: f.texture(64, 32), revision: 1 };
    expect(() => pass.encode(f.encoder, resized, options)).toThrow("cleanup failed");
    expect(pass.current?.width).toBe(64); expect(pass.current?.texture).not.toBe(old.texture);
    expect(pass.current?.texture.destroy).not.toHaveBeenCalled(); expect(f.owned.size).toBe(baseline);
    expect(pass.encode(f.encoder, resized, options).width).toBe(64);
    pass.dispose(); expect(f.owned.size).toBe(0);
  });
});
