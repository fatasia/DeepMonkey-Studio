import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { VolumetricFogCompositePass } from "./volumetricFogComposite.js";
import { VOLUMETRIC_FOG_COMPOSITE_WGSL } from "./volumetricFogCompositeWgsl.js";

function texture(width: number, height: number, format: GPUTextureFormat, usage = GPUTextureUsage.TEXTURE_BINDING) {
  return { width, height, depthOrArrayLayers: 1, sampleCount: 1, dimension: "2d", format, usage,
    createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
}
function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), outputs: GPUTexture[] = [];
  const device = { limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({ label: "composite" })),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => { const size = descriptor.size as GPUExtent3DDict;
      const result = texture(size.width as number, size.height as number, descriptor.format, descriptor.usage);
      outputs.push(result); return result; }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
  };
  const session = { state: "ready", device, own<T extends GPUTexture | GPUBuffer>(value: T): T { owned.add(value); return value; },
    release(value: GPUTexture | GPUBuffer) { if (owned.delete(value)) value.destroy(); } };
  const passes: { dispatch?: [number, number] }[] = [];
  const encoder = { beginComputePass: vi.fn(() => { const record: { dispatch?: [number, number] } = {}; passes.push(record);
    return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn((x: number, y: number) => { record.dispatch = [x, y]; }), end: vi.fn() }; }) };
  return { session: session as unknown as DeviceSession, encoder: encoder as unknown as GPUCommandEncoder,
    device, owned, outputs, passes };
}
function source(revision = 1) {
  const color = texture(13, 7, "rgba16float");
  return { color, revision, colorEncoding: "linear-hdr" as const, scatter: {
    texture: texture(7, 4, "rgba16float"), format: "rgba16float" as const, width: 7, height: 4,
    sourceWidth: 13, sourceHeight: 7, revision, updated: true, passCount: 1 as const,
  } };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("volumetric fog HDR composite", () => {
  it("encodes one full-resolution Beer-Lambert composite and reuses stable resources", () => {
    const f = fixture(), pass = new VolumetricFogCompositePass(f.session), input = source();
    const first = pass.encode(f.encoder, input);
    expect(first).toMatchObject({ width: 13, height: 7, revision: 1, passCount: 1, updated: true });
    expect(f.passes[0]?.dispatch).toEqual([2, 1]);
    expect(pass.encode(f.encoder, input)).toMatchObject({ texture: first.texture, updated: false });
    expect(f.passes).toHaveLength(1); expect(f.outputs).toHaveLength(1);
    pass.dispose(); pass.dispose(); expect(f.owned.size).toBe(0);
  });
  it("rejects mismatched half-resolution results and revision ambiguity", () => {
    const f = fixture(), pass = new VolumetricFogCompositePass(f.session), input = source();
    expect(() => pass.encode(f.encoder, { ...input, scatter: { ...input.scatter, width: 6 } })).toThrow("ceil-half");
    expect(() => pass.encode(f.encoder, { ...input, revision: 2 })).toThrow("revision");
    pass.dispose();
  });
  it("locks the linear HDR composition equation", () => {
    expect(VOLUMETRIC_FOG_COMPOSITE_WGSL).toMatch(/source\.rgb \* transmittance \+ max\(fog\.rgb/);
    expect(VOLUMETRIC_FOG_COMPOSITE_WGSL).toMatch(/textureSampleLevel/);
  });
});
