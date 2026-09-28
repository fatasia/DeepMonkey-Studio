import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { applyResponseFeedback } from "./temporalResponseMask.js";
import { reactiveCoverageFromAlphas, TemporalReactiveMaskPass } from "./temporalReactiveMask.js";
import { resolveTemporalAaCpu } from "./temporalAaCpu.js";
import { TEMPORAL_REACTIVE_MASK_FORMAT } from "./temporalAaTypes.js";
import { TEMPORAL_REACTIVE_MASK_WGSL } from "./temporalReactiveMask.js";

const options = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.02 } as const;

function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>();
  const device = { limits: { maxTextureDimension2D: 16384, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn((d: GPUTextureDescriptor) => ({ width: (d.size as GPUExtent3DDict).width, height: (d.size as GPUExtent3DDict).height, format: d.format,
      dimension: "2d", depthOrArrayLayers: 1, sampleCount: 1, usage: d.usage, createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ size: d.size, destroy: vi.fn() })) };
  const session = { state: "ready", device,
    own: <T extends GPUTexture | GPUBuffer>(resource: T): T => { owned.add(resource); return resource; },
    release: (resource: GPUTexture | GPUBuffer) => { owned.delete(resource); } };
  return { device, session: session as unknown as DeviceSession, raw: session, owned };
}
function texture(width: number, height: number, format: GPUTextureFormat) {
  return { width, height, format, dimension: "2d", depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1,
    usage: GPUTextureUsage.TEXTURE_BINDING, createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture & { createView: ReturnType<typeof vi.fn> };
}
function colorTexture(width = 2, height = 1) { return texture(width, height, "rgba16float"); }

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2, COPY_SRC: 4 }); vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("temporal reactive mask", () => {
  it("derives coverage from the weighted-OIT composite alpha algebra", () => {
    expect(reactiveCoverageFromAlphas(1, 0)).toBe(1);
    expect(reactiveCoverageFromAlphas(0.5, 0)).toBeCloseTo(0.5, 12);
    expect(reactiveCoverageFromAlphas(0.75, 0.5)).toBeCloseTo(0.5, 12);
    expect(reactiveCoverageFromAlphas(0.25, 0.25)).toBe(0);
    expect(reactiveCoverageFromAlphas(1, 1)).toBe(0);
    expect(() => reactiveCoverageFromAlphas(-0.1, 0)).toThrow("invalid");
    expect(() => reactiveCoverageFromAlphas(1.2, 0)).toThrow("invalid");
    expect(() => reactiveCoverageFromAlphas(NaN, 0)).toThrow("invalid");
  });

  it("scales CPU TAA feedback per pixel exactly like applyResponseFeedback and stays bit-identical without a mask", () => {
    const frame = { width: 2, height: 1, color: [1, 0, 0, 1, 0.25, 0, 0, 1], depth: [4, 4], motion: [0, 0, -0.5, 0],
      previousColor: [1, 0, 0, 1, 0, 0, 0, 1], previousDepth: [4, 4],
      currentJitter: [0, 0] as const, previousJitter: [0, 0] as const, historyValid: true };
    const baseline = resolveTemporalAaCpu(frame, options);
    const clamped = (baseline[4]! - 0.25 * (1 - options.feedback)) / options.feedback;
    const masked = resolveTemporalAaCpu({ ...frame, reactiveMask: [0, 128] }, options);
    const dropped = resolveTemporalAaCpu({ ...frame, reactiveMask: [0, 255] }, options);
    expect(Array.from(resolveTemporalAaCpu({ ...frame, reactiveMask: [0, 0] }, options))).toEqual(Array.from(baseline));
    const half = applyResponseFeedback(options.feedback, 128);
    expect(masked[4]).toBeCloseTo(0.25 * (1 - half) + clamped * half, 6);
    expect(dropped[4]).toBe(0.25);
    expect(() => resolveTemporalAaCpu({ ...frame, reactiveMask: [0] }, options)).toThrow("reactive mask");
    expect(() => resolveTemporalAaCpu({ ...frame, reactiveMask: [0, 256] }, options)).toThrow("reactive mask");
  });

  it("encodes the extraction pass, resizes, and disposes", () => {
    const f = fixture(), pass = new TemporalReactiveMaskPass(f.session);
    const encoder = { beginComputePass: vi.fn(() => ({ setPipeline() { /* noop */ }, setBindGroup() { /* noop */ }, dispatchWorkgroups() { /* noop */ }, end() { /* noop */ } })) } as unknown as GPUCommandEncoder;
    const first = pass.encode(encoder, { compositedColor: colorTexture(4, 2), opaqueColor: colorTexture(4, 2) });
    expect(first).toMatchObject({ format: TEMPORAL_REACTIVE_MASK_FORMAT, width: 4, height: 2 });
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(1);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledWith(expect.anything(), 0, new Uint32Array([4, 2, 0, 0]));
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(1);
    const resized = pass.encode(encoder, { compositedColor: colorTexture(8, 4), opaqueColor: colorTexture(8, 4) });
    expect(resized.width).toBe(8);
    expect(f.owned.size).toBe(1);
    pass.dispose(); pass.dispose();
    expect(f.owned.size).toBe(0);
  });

  it("rejects mismatched dimensions and unusable textures", () => {
    const f = fixture(), pass = new TemporalReactiveMaskPass(f.session);
    const encoder = { beginComputePass: vi.fn() } as unknown as GPUCommandEncoder;
    expect(() => pass.encode(encoder, { compositedColor: colorTexture(4, 2), opaqueColor: colorTexture(2, 1) })).toThrow("dimensions must match");
    const unusable = { ...texture(2, 1, "rgba16float"), usage: 0 } as unknown as GPUTexture;
    expect(() => pass.encode(encoder, { compositedColor: unusable, opaqueColor: colorTexture(2, 1) })).toThrow("TEXTURE_BINDING");
    pass.dispose();
    expect(() => pass.encode(encoder, { compositedColor: colorTexture(), opaqueColor: colorTexture() })).toThrow("disposed");
  });

  it("keeps the extraction WGSL contract stable", () => {
    expect(TEMPORAL_REACTIVE_MASK_WGSL).toContain("fn extractReactiveMask");
    expect(TEMPORAL_REACTIVE_MASK_WGSL).toContain("r8unorm");
    expect(TEMPORAL_REACTIVE_MASK_WGSL).toContain("max(1.0 - opaqueAlpha, 1e-3)");
  });
});
