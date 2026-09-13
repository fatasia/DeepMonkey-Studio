import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { WeightedOitPass, weightedOitColorTargets, WEIGHTED_OIT_COMPOSITE_WGSL,
  WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOit.js";
import { WEIGHTED_OIT_ACCUMULATION_FORMAT, WEIGHTED_OIT_REVEALAGE_FORMAT } from "./weightedOitTypes.js";

interface FakeTexture extends GPUTexture {
  readonly descriptor: GPUTextureDescriptor;
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly createView: ReturnType<typeof vi.fn>;
}

function fixture() {
  const owned = new Set<GPUTexture>(), textures: FakeTexture[] = [];
  const device = {
    limits: { maxTextureDimension2D: 16_384 },
    createShaderModule: vi.fn(({ label, code }: GPUShaderModuleDescriptor) => ({ label, code })),
    createBindGroupLayout: vi.fn(({ label, entries }: GPUBindGroupLayoutDescriptor) => ({ label, entries })),
    createPipelineLayout: vi.fn(({ label, bindGroupLayouts }: GPUPipelineLayoutDescriptor) => ({ label, bindGroupLayouts })),
    createRenderPipeline: vi.fn((descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label, descriptor })),
    createBindGroup: vi.fn(({ label, entries }: GPUBindGroupDescriptor) => ({ label, entries })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      const value = { width: size.width as number, height: size.height as number, depthOrArrayLayers: 1,
        mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: descriptor.format, usage: descriptor.usage,
        descriptor, destroy: vi.fn(), createView: vi.fn((viewDescriptor = {}) => ({ texture: value, viewDescriptor })) };
      textures.push(value as unknown as FakeTexture); return value;
    }),
  };
  const session = { state: "ready", device,
    own<T extends GPUTexture>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture): void { if (owned.delete(resource)) resource.destroy(); },
  };
  return { device, session: session as unknown as DeviceSession, rawSession: session, owned, textures };
}

function encoderFixture() {
  const passes: Array<{ descriptor: GPURenderPassDescriptor; pipeline?: GPURenderPipeline; binding?: GPUBindGroup;
    draws: number; ended: boolean }> = [];
  const encoder = { beginRenderPass: vi.fn((descriptor: GPURenderPassDescriptor) => {
    const record = { descriptor, draws: 0, ended: false } as typeof passes[number]; passes.push(record);
    return { setPipeline: (pipeline: GPURenderPipeline) => { record.pipeline = pipeline; },
      setBindGroup: (_index: number, binding: GPUBindGroup) => { record.binding = binding; },
      draw: (count: number) => { record.draws = count; }, end: () => { record.ended = true; } };
  }) };
  return { encoder: encoder as unknown as GPUCommandEncoder, passes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { FRAGMENT: 2 });
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("weighted blended order-independent transparency", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    for (const [name, code] of [["fragment", WEIGHTED_OIT_FRAGMENT_WGSL], ["composite", WEIGHTED_OIT_COMPOSITE_WGSL]] as const) {
      const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `deep-weighted-oit-${name}.wgsl`, "--input-kind", "wgsl"], { input: code, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe(""); expect(result.stdout).toContain("Validation successful");
    }
  });

  it("freezes the additive accumulation and multiplicative revealage contract", () => {
    const targets = weightedOitColorTargets();
    expect(targets).toEqual([
      { format: WEIGHTED_OIT_ACCUMULATION_FORMAT, blend: { color: { operation: "add", srcFactor: "one", dstFactor: "one" },
        alpha: { operation: "add", srcFactor: "one", dstFactor: "one" } }, writeMask: GPUColorWrite.ALL },
      { format: WEIGHTED_OIT_REVEALAGE_FORMAT, blend: { color: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src" },
        alpha: { operation: "add", srcFactor: "zero", dstFactor: "one-minus-src" } }, writeMask: GPUColorWrite.RED },
    ]);
    expect(Object.isFrozen(targets)).toBe(true); expect(Object.isFrozen(targets[0])).toBe(true);
  });

  it("allocates both linear targets transactionally, reuses size, and retires them on resize", () => {
    const f = fixture(), oit = new WeightedOitPass(f.session);
    const first = oit.resize(64, 32), same = oit.resize(64, 32);
    expect(same).toBe(first); expect(first.generation).toBe(1); expect(f.textures).toHaveLength(2);
    expect(f.textures.map(value => value.descriptor.format)).toEqual(["rgba16float", "r16float"]);
    expect(f.textures.every(value => value.descriptor.usage === (GPUTextureUsage.RENDER_ATTACHMENT
      | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC))).toBe(true);
    const second = oit.resize(32, 16);
    expect(second.generation).toBe(2); expect(second.accumulationTexture).not.toBe(first.accumulationTexture);
    expect(f.textures.slice(0, 2).every(value => value.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.owned.size).toBe(2);
  });

  it("provides correct clears and encodes a cached full-screen linear composite", () => {
    const f = fixture(), oit = new WeightedOitPass(f.session), encoder = encoderFixture();
    const targets = oit.resize(8, 4), attachments = oit.accumulationAttachments();
    expect(attachments[0]).toMatchObject({ view: targets.accumulationView, loadOp: "clear", storeOp: "store",
      clearValue: { r: 0, g: 0, b: 0, a: 0 } });
    expect(attachments[1]).toMatchObject({ view: targets.revealageView, loadOp: "clear", storeOp: "store",
      clearValue: { r: 1, g: 1, b: 1, a: 1 } });
    const opaque = {} as GPUTextureView, destination = {} as GPUTextureView;
    const first = oit.encodeComposite(encoder.encoder, opaque, destination, { outputFormat: "rgba16float" });
    const second = oit.encodeComposite(encoder.encoder, opaque, destination, { outputFormat: "rgba16float", loadOp: "load" });
    expect(first).toEqual({ width: 8, height: 4, generation: 1, outputFormat: "rgba16float" }); expect(second).toEqual(first);
    expect(f.device.createRenderPipeline).toHaveBeenCalledOnce(); expect(f.device.createBindGroup).toHaveBeenCalledTimes(2);
    expect(encoder.passes.map(pass => [pass.draws, pass.ended])).toEqual([[3, true], [3, true]]);
    expect(encoder.passes[0]!.descriptor.colorAttachments[0]).toMatchObject({ view: destination, loadOp: "clear", storeOp: "store" });
    expect(encoder.passes[1]!.descriptor.colorAttachments[0]).toMatchObject({ view: destination, loadOp: "load", storeOp: "store" });
  });

  it("fails closed before encoding invalid dimensions, formats, or missing targets", () => {
    const f = fixture(), oit = new WeightedOitPass(f.session), encoder = encoderFixture();
    expect(() => oit.resize(0, 8)).toThrow("dimensions"); expect(() => oit.resize(20_000, 8)).toThrow("dimensions");
    expect(() => oit.accumulationAttachments()).toThrow("resized");
    oit.resize(8, 8);
    expect(() => oit.encodeComposite(encoder.encoder, {} as GPUTextureView, {} as GPUTextureView,
      { outputFormat: "depth32float" })).toThrow("color format");
    expect(encoder.passes).toHaveLength(0);
  });

  it("rolls back partial allocation and releases resources on device loss or idempotent disposal", () => {
    const f = fixture(), oit = new WeightedOitPass(f.session), first = oit.resize(8, 8);
    f.device.createTexture.mockImplementationOnce((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict, value = { width: size.width as number, height: size.height as number,
        depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format: descriptor.format, usage: descriptor.usage,
        descriptor, destroy: vi.fn(), createView: vi.fn(() => { throw new Error("view failed"); }) };
      f.textures.push(value as unknown as FakeTexture); return value;
    });
    expect(() => oit.resize(16, 16)).toThrow("view failed"); expect(oit.current).toBe(first);
    expect(f.textures[2]!.destroy).toHaveBeenCalledOnce(); expect((first.accumulationTexture as FakeTexture).destroy).not.toHaveBeenCalled();
    f.rawSession.state = "lost";
    expect(() => oit.resize(8, 8)).toThrow("not ready");
    expect((first.accumulationTexture as FakeTexture).destroy).toHaveBeenCalledOnce();
    expect((first.revealageTexture as FakeTexture).destroy).toHaveBeenCalledOnce();
    oit.dispose(); oit.dispose(); expect(f.owned.size).toBe(0);
    expect(() => oit.resize(8, 8)).toThrow("disposed");
  });
});
