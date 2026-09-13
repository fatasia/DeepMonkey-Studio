import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { AmbientOcclusionCompositePass } from "./ambientOcclusionComposite.js";
import { compositeAmbientOcclusionCpu } from "./ambientOcclusionCompositeCpu.js";
import type { AmbientOcclusionResult } from "./ambientOcclusionTypes.js";
import { AMBIENT_OCCLUSION_COMPOSITE_WGSL } from "./ambientOcclusionCompositeWgsl.js";

interface FakeTexture extends GPUTexture {
  readonly descriptor?: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}

const options = { depthSigma: 0.1, strength: 1 } as const;

function texture(width: number, height: number, format: GPUTextureFormat, usage = GPUTextureUsage.TEXTURE_BINDING): FakeTexture {
  return { width, height, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format, usage,
    createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as FakeTexture;
}

function aoResult(textureValue: GPUTexture, sourceWidth: number, sourceHeight: number, revision: number): AmbientOcclusionResult {
  return { texture: textureValue, format: "r32float", width: textureValue.width, height: textureValue.height,
    sourceWidth, sourceHeight, revision, updated: true, depthEncoding: "linear-view-depth-positive", sampleCount: 16 };
}

function source(revision = 0, width = 13, height = 7, existing?: ReturnType<typeof source>) {
  const color = existing?.color ?? texture(width, height, "rgba16float");
  const depth = existing?.depth ?? texture(width, height, "r32float");
  const aoTexture = existing?.ambientOcclusion.texture ?? texture(Math.ceil(width / 2), Math.ceil(height / 2), "r32float");
  return { color, depth, ambientOcclusion: aoResult(aoTexture, width, height, revision), revision,
    colorEncoding: "linear-hdr" as const, depthEncoding: "linear-view-depth-positive" as const };
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
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: readonly GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, outputs };
}

function encoderFixture() {
  const passes: Array<{ label: string; pipeline?: { label: string }; binding?: unknown; dispatch?: [number, number] }> = [];
  const encoder = { beginComputePass: vi.fn(({ label }: { label: string }) => {
    const item = { label } as typeof passes[number]; passes.push(item);
    return { setPipeline: vi.fn((pipeline: { label: string }) => { item.pipeline = pipeline; }),
      setBindGroup: vi.fn((_index: number, binding: unknown) => { item.binding = binding; }),
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

describe("ambient occlusion HDR composite", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("is Naga-valid", () => {
    const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-ao-composite.wgsl", "--input-kind", "wgsl"],
      { input: AMBIENT_OCCLUSION_COMPOSITE_WGSL, encoding: "utf8" });
    expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("Validation successful");
  });

  it("bilaterally rejects cross-depth AO while preserving alpha and background", () => {
    const input = { width: 4, height: 1, color: [1, 2, 3, .5, 1, 2, 3, .6, 1, 2, 3, .7, 1, 2, 3, .8],
      depth: [0, 1, 10, 10], ambientOcclusionWidth: 2, ambientOcclusionHeight: 1, ambientOcclusion: [.2, .8] };
    const output = compositeAmbientOcclusionCpu(input, { depthSigma: .01, strength: 1 });
    expect(Array.from(output.slice(0, 4))).toEqual([1, 2, 3, .5]);
    expect(output[4]).toBeCloseTo(.2, 6); expect(output[8]).toBeCloseTo(.8, 6);
    expect(output[7]).toBeCloseTo(.6, 6); expect(output[11]).toBeCloseTo(.7, 6);
  });

  it("encodes full-resolution HDR output and reuses stable resources and bindings", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionCompositePass(f.session), firstSource = source();
    const first = pass.encode(encoder.encoder, firstSource, options);
    expect(first).toMatchObject({ width: 13, height: 7, format: "rgba16float", revision: 0, updated: true, colorEncoding: "linear-hdr" });
    expect(encoder.passes[0]).toMatchObject({ pipeline: { label: "Deep ambient occlusion HDR composite pipeline" }, dispatch: [2, 1] });
    const descriptor = f.outputs[0]!.descriptor!;
    expect(descriptor.usage).toBe(GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const bindingCount = f.device.createBindGroup.mock.calls.length;
    expect(pass.encode(encoder.encoder, firstSource, options)).toMatchObject({ texture: first.texture, updated: false });
    const revised = source(1, 13, 7, firstSource);
    expect(pass.encode(encoder.encoder, revised, options).texture).toBe(first.texture);
    expect(f.outputs).toHaveLength(1); expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindingCount);
    const packed = f.device.queue.writeBuffer.mock.calls.at(-1)?.[2] as ArrayBuffer;
    expect(Array.from(new Uint32Array(packed).slice(0, 4))).toEqual([13, 7, 7, 4]);
    const tuning = new Float32Array(packed).slice(4, 6);
    expect(tuning[0]).toBeCloseTo(options.depthSigma, 7); expect(tuning[1]).toBe(options.strength);
  });

  it("rolls back resize failures, releases replaced resources, and disposes idempotently", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionCompositePass(f.session);
    const first = pass.encode(encoder.encoder, source(), options);
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      value.createView.mockImplementationOnce(() => { throw new Error("AO composite view failed"); }); f.outputs.push(value); return value;
    });
    expect(() => pass.encode(encoder.encoder, source(1, 17, 9), options)).toThrow("AO composite view failed");
    expect(pass.current?.texture).toBe(first.texture); expect(first.texture.destroy).not.toHaveBeenCalled();
    const resized = pass.encode(encoder.encoder, source(1, 17, 9), options);
    expect(resized.texture).not.toBe(first.texture); expect(first.texture.destroy).toHaveBeenCalledOnce();
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0);
  });

  it("fails closed on encodings, formats, usages, dimensions, revisions, and parameters", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionCompositePass(f.session), valid = source();
    expect(() => pass.encode(encoder.encoder, { ...valid, colorEncoding: "srgb" as never }, options)).toThrow("linear HDR");
    expect(() => pass.encode(encoder.encoder, { ...valid, depthEncoding: "device" as never }, options)).toThrow("positive linear");
    expect(() => pass.encode(encoder.encoder, { ...valid, color: texture(13, 7, "rgba8unorm") }, options)).toThrow("rgba16float");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(13, 7, "r32float", 0) }, options)).toThrow("TEXTURE_BINDING");
    expect(() => pass.encode(encoder.encoder, { ...valid, depth: texture(12, 7, "r32float") }, options)).toThrow("dimensions");
    expect(() => pass.encode(encoder.encoder, { ...valid, ambientOcclusion: aoResult(texture(6, 4, "r32float"), 13, 7, 0) }, options)).toThrow("ceil-half");
    expect(() => pass.encode(encoder.encoder, { ...valid, ambientOcclusion: { ...valid.ambientOcclusion, revision: 1 } }, options)).toThrow("revision");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, depthSigma: 0 })).toThrow("depthSigma");
    expect(() => pass.encode(encoder.encoder, valid, { ...options, strength: Number.NaN })).toThrow("strength");
    pass.encode(encoder.encoder, valid, options);
    expect(() => pass.encode(encoder.encoder, source(0), options)).toThrow("without a revision");
    expect(() => pass.encode(encoder.encoder, { ...valid, revision: -1, ambientOcclusion: { ...valid.ambientOcclusion, revision: -1 } }, options)).toThrow("revision");
  });

  it("clears owned resources after device loss and rejects use after dispose", () => {
    const f = fixture(), encoder = encoderFixture(), pass = new AmbientOcclusionCompositePass(f.session);
    const result = pass.encode(encoder.encoder, source(), options); f.rawSession.state = "lost";
    expect(pass.current).toBeUndefined(); expect(result.texture.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(0);
    expect(() => pass.encode(encoder.encoder, source(1), options)).toThrow("not ready");
    pass.dispose(); expect(() => pass.encode(encoder.encoder, source(2), options)).toThrow("disposed");
  });
});
