import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { HiZPyramid, HI_Z_COPY_WGSL, HI_Z_OUTPUT_FORMAT, HI_Z_REDUCE_WGSL, hiZMipLevelCount } from "./hiZPyramid.js";

interface FakeTexture extends GPUTexture {
  readonly descriptor: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}

function texture(width: number, height: number, overrides: Partial<GPUTexture> = {}): FakeTexture {
  const value = {
    width, height, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
    dimension: "2d", format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING,
    createView: vi.fn((descriptor = {}) => ({ texture: value, descriptor })), destroy: vi.fn(),
    descriptor: {}, ...overrides,
  };
  return value as unknown as FakeTexture;
}

function fixture() {
  const owned = new Set<GPUTexture>(), outputs: FakeTexture[] = [];
  const device = {
    limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535 },
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      const result = texture(size.width as number, size.height as number, {
        format: descriptor.format, usage: descriptor.usage, mipLevelCount: descriptor.mipLevelCount ?? 1,
      });
      Object.defineProperty(result, "descriptor", { value: descriptor }); outputs.push(result); return result;
    }),
    createBindGroup: vi.fn(({ label, entries }: { label: string; entries: GPUBindGroupEntry[] }) => ({ label, entries })),
  };
  const session = {
    state: "ready", device,
    own<T extends GPUTexture>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture): void { if (owned.delete(resource)) resource.destroy(); },
  };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, outputs };
}

function encoderFixture() {
  const passes: Array<{ label: string; pipeline?: { label: string }; binding?: GPUBindGroup; dispatch?: [number, number]; end: ReturnType<typeof vi.fn> }> = [];
  const encoder = { beginComputePass: vi.fn(({ label }: { label: string }) => {
    const pass = { label, setPipeline: vi.fn((pipeline: { label: string }) => { pass.pipeline = pipeline; }),
      setBindGroup: vi.fn((_index: number, binding: GPUBindGroup) => { pass.binding = binding; }),
      dispatchWorkgroups: vi.fn((x: number, y: number) => { pass.dispatch = [x, y]; }), end: vi.fn(),
    } as unknown as typeof passes[number] & { setPipeline: ReturnType<typeof vi.fn>; setBindGroup: ReturnType<typeof vi.fn>; dispatchWorkgroups: ReturnType<typeof vi.fn> };
    passes.push(pass); return pass;
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, begin: encoder.beginComputePass, passes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4, RENDER_ATTACHMENT: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Hi-Z depth pyramid", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    for (const [name, code] of [["copy", HI_Z_COPY_WGSL], ["reduce", HI_Z_REDUCE_WGSL]] as const) {
      const validation = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `deep-hiz-${name}.wgsl`, "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
      expect(validation.status, validation.stderr).toBe(0); expect(validation.stderr).toBe("");
      expect(validation.stdout).toContain("Validation successful");
    }
  });
  it("computes complete NPOT mip dimensions and dispatches conservative reversed-Z min reduction", () => {
    expect(hiZMipLevelCount(13, 7)).toBe(4);
    expect(() => hiZMipLevelCount(0, 7)).toThrow("positive");
    const f = fixture(), encoder = encoderFixture(), source = texture(13, 7);
    const pyramid = new HiZPyramid(f.session), result = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: true });
    expect(result.updated).toBe(true); expect(result.reduction).toBe("min"); expect(result.reversedZ).toBe(true);
    expect(result.levels.map(level => [level.width, level.height])).toEqual([[13, 7], [6, 3], [3, 1], [1, 1]]);
    expect(encoder.passes.map(pass => pass.dispatch)).toEqual([[2, 1], [1, 1], [1, 1], [1, 1]]);
    expect(encoder.passes[0]!.pipeline?.label).toBe("Deep Hi-Z depth copy pipeline");
    expect(encoder.passes.slice(1).every(pass => pass.pipeline?.label === "Deep Hi-Z min pipeline")).toBe(true);
    expect(f.outputs[0]!.descriptor).toMatchObject({ format: HI_Z_OUTPUT_FORMAT, mipLevelCount: 4,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  });

  it("maps conservative standard Z to max and honors explicit reduction", () => {
    const f = fixture(), encoder = encoderFixture(), source = texture(8, 8), pyramid = new HiZPyramid(f.session);
    const standard = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: false });
    expect(standard.reduction).toBe("max");
    expect(encoder.passes.slice(1).every(pass => pass.pipeline?.label === "Deep Hi-Z max pipeline")).toBe(true);
    encoder.passes.length = 0;
    const explicit = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: false, reduction: "min" });
    expect(explicit.reduction).toBe("min");
    expect(encoder.passes.slice(1).every(pass => pass.pipeline?.label === "Deep Hi-Z min pipeline")).toBe(true);
  });

  it("reuses pipelines, allocation, mip views, and bind groups across source revisions", () => {
    const f = fixture(), encoder = encoderFixture(), source = texture(32, 16), pyramid = new HiZPyramid(f.session);
    const first = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: true });
    const outputViews = f.outputs[0]!.createView.mock.calls.length, bindings = f.device.createBindGroup.mock.calls.length;
    const passCount = encoder.begin.mock.calls.length;
    const cached = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: true });
    expect(cached.updated).toBe(false); expect(cached.texture).toBe(first.texture); expect(encoder.begin).toHaveBeenCalledTimes(passCount);
    const next = pyramid.encode(encoder.encoder, { texture: source, revision: 1 }, { reversedZ: true });
    expect(next.texture).toBe(first.texture); expect(f.outputs).toHaveLength(1);
    expect(f.outputs[0]!.createView).toHaveBeenCalledTimes(outputViews);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(bindings);
    expect(f.device.createShaderModule).toHaveBeenCalledTimes(2);
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(3);
  });

  it("rebuilds on resize, publishes only after success, and rejects invalid revision transitions", () => {
    const f = fixture(), encoder = encoderFixture(), pyramid = new HiZPyramid(f.session);
    const sourceA = texture(16, 16), first = pyramid.encode(encoder.encoder, { texture: sourceA, revision: 2 }, { reversedZ: true });
    expect(() => pyramid.encode(encoder.encoder, { texture: sourceA, revision: 1 }, { reversedZ: true })).toThrow("Stale");
    expect(() => pyramid.encode(encoder.encoder, { texture: texture(16, 16), revision: 2 }, { reversedZ: true })).toThrow("without a revision");
    const sourceB = texture(31, 9), second = pyramid.encode(encoder.encoder, { texture: sourceB, revision: 3 }, { reversedZ: true });
    expect(second.texture).not.toBe(first.texture); expect(second.levels.map(level => [level.width, level.height]))
      .toEqual([[31, 9], [15, 4], [7, 2], [3, 1], [1, 1]]);
    expect(f.outputs[0]!.destroy).toHaveBeenCalledOnce(); expect(f.owned.size).toBe(1);
  });

  it("fails closed on source, mip, and dispatch limits before allocating output or encoding", () => {
    const f = fixture(), encoder = encoderFixture(), pyramid = new HiZPyramid(f.session);
    const invalid = [
      { source: texture(8, 8, { format: "depth24plus" }), options: { reversedZ: true } },
      { source: texture(8, 8, { usage: GPUTextureUsage.RENDER_ATTACHMENT }), options: { reversedZ: true } },
      { source: texture(8, 8, { sampleCount: 4 }), options: { reversedZ: true } },
      { source: texture(8, 8, { depthOrArrayLayers: 2 }), options: { reversedZ: true } },
      { source: texture(8, 8), options: { reversedZ: true, mipLevelCount: 5 } },
    ];
    for (const [index, item] of invalid.entries()) expect(() => pyramid.encode(encoder.encoder,
      { texture: item.source, revision: index }, item.options)).toThrow();
    expect(() => pyramid.encode(encoder.encoder, { texture: texture(8, 8), revision: -1 }, { reversedZ: true })).toThrow("revision");
    expect(() => pyramid.encode(encoder.encoder, { texture: texture(8, 8), revision: 5 }, {} as never)).toThrow("explicitly");
    f.device.limits.maxComputeWorkgroupsPerDimension = 1;
    expect(() => pyramid.encode(encoder.encoder, { texture: texture(9, 8), revision: 6 }, { reversedZ: true })).toThrow("workgroup");
    expect(f.device.createTexture).not.toHaveBeenCalled(); expect(encoder.begin).not.toHaveBeenCalled();
  });

  it("rolls back resize allocation and preserves the prior pyramid when view creation fails", () => {
    const f = fixture(), encoder = encoderFixture(), pyramid = new HiZPyramid(f.session);
    const first = pyramid.encode(encoder.encoder, { texture: texture(8, 8), revision: 0 }, { reversedZ: true });
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, output = texture(size.width as number, size.height as number, {
        format: descriptor.format, usage: descriptor.usage, mipLevelCount: descriptor.mipLevelCount ?? 1,
      });
      output.createView.mockImplementationOnce(() => { throw new Error("mip view failed"); });
      Object.defineProperty(output, "descriptor", { value: descriptor }); f.outputs.push(output); return output;
    });
    expect(() => pyramid.encode(encoder.encoder, { texture: texture(16, 8), revision: 1 }, { reversedZ: true })).toThrow("mip view failed");
    expect(f.outputs[1]!.destroy).toHaveBeenCalledOnce(); expect(f.outputs[0]!.destroy).not.toHaveBeenCalled();
    expect(pyramid.current?.texture).toBe(first.texture); expect(f.owned).toEqual(new Set([first.texture]));
  });

  it("releases invalid device resources and disposes idempotently without owning the source", () => {
    const f = fixture(), encoder = encoderFixture(), source = texture(8, 8), pyramid = new HiZPyramid(f.session);
    const result = pyramid.encode(encoder.encoder, { texture: source, revision: 0 }, { reversedZ: true });
    f.rawSession.state = "lost";
    expect(() => pyramid.encode(encoder.encoder, { texture: source, revision: 1 }, { reversedZ: true })).toThrow("not ready");
    expect((result.texture as FakeTexture).destroy).toHaveBeenCalledOnce(); expect(source.destroy).not.toHaveBeenCalled();
    pyramid.dispose(); pyramid.dispose(); expect((result.texture as FakeTexture).destroy).toHaveBeenCalledOnce();
    expect(() => pyramid.encode(encoder.encoder, { texture: source, revision: 2 }, { reversedZ: true })).toThrow("disposed");
  });
});
