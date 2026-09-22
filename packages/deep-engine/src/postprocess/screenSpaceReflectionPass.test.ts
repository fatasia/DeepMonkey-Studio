import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { ScreenSpaceReflectionPass } from "./screenSpaceReflection.js";
import type { ScreenSpaceReflectionSource } from "./screenSpaceReflectionTypes.js";

const options = { verticalFovRadians: Math.PI / 3, maxDistance: 40, thickness: 0.2,
  steps: 32, refines: 4, edgeFade: 0.08, fresnelF0: 0.05 } as const;

function texture(width = 32, height = 16, format: GPUTextureFormat = "rgba16float") {
  return { width, height, depthOrArrayLayers: 1, mipLevelCount: 1, sampleCount: 1, dimension: "2d", format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    createView: vi.fn(() => ({})), destroy: vi.fn() } as unknown as GPUTexture;
}

function source(revision = 1, current?: ScreenSpaceReflectionSource): ScreenSpaceReflectionSource {
  return { color: current?.color ?? texture(), depth: current?.depth ?? texture(32, 16, "r32float"),
    normal: current?.normal ?? texture(32, 16, "rgba8unorm"), revision,
    depthEncoding: "linear-view-depth-positive", normalSpace: "view", colorEncoding: "linear-hdr" };
}

function fixture() {
  const owned = new Set<GPUTexture | GPUBuffer>(), modules: string[] = [];
  const encoded: Array<{ label: string; dispatch?: readonly [number, number] }> = [];
  const device = { limits: { maxTextureDimension2D: 16_384, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() },
    createShaderModule: vi.fn(({ code }: GPUShaderModuleDescriptor) => { modules.push(code); return {}; }),
    createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(({ label }: GPUComputePipelineDescriptor) => ({ label })),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(({ label }: GPUBindGroupDescriptor) => ({ label })),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const size = descriptor.size as GPUExtent3DDict;
      return texture(size.width as number, size.height as number, descriptor.format);
    }),
    createBuffer: vi.fn(({ label }: GPUBufferDescriptor) => ({ label, destroy: vi.fn() })),
  };
  const session = { state: "ready", device, assertResourceAdmission: vi.fn(),
    own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  const encoder = { beginComputePass: vi.fn(({ label }: GPUComputePassDescriptor) => {
    const item = { label: label! } as { label: string; dispatch?: readonly [number, number] }; encoded.push(item);
    return { setPipeline: vi.fn(), setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn((x: number, y: number) => { item.dispatch = [x, y]; }), end: vi.fn() };
  }) } as unknown as GPUCommandEncoder;
  return { session: session as unknown as DeviceSession, rawSession: session, device, modules, encoded, encoder, owned };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, STORAGE_BINDING: 2 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("SSR roughness GPU pass", () => {
  it("builds a bounded radiance hierarchy before trace→composite", () => {
    const f = fixture(), pass = new ScreenSpaceReflectionPass(f.session), input = source();
    const result = pass.encode(f.encoder, input, options);
    expect(result).toMatchObject({ width: 32, height: 16, traceWidth: 16, traceHeight: 8,
      radianceMipLevelCount: 6, passCount: 8, updated: true });
    expect(f.encoded).toEqual([
      { label: "Deep SSR radiance mip 0", dispatch: [4, 2] },
      { label: "Deep SSR radiance mip 1", dispatch: [2, 1] },
      { label: "Deep SSR radiance mip 2", dispatch: [1, 1] },
      { label: "Deep SSR radiance mip 3", dispatch: [1, 1] },
      { label: "Deep SSR radiance mip 4", dispatch: [1, 1] },
      { label: "Deep SSR radiance mip 5", dispatch: [1, 1] },
      { label: "Deep screen-space reflection trace", dispatch: [2, 1] },
      { label: "Deep screen-space reflection composite", dispatch: [4, 2] },
    ]);
    expect(f.modules[0]).toContain("ssrLoadRoughness");
    expect(f.modules[0]).toContain("ssrSampleRoughRadiance");
    expect(f.modules[2]).toContain("downsampleRadiance");
    expect(pass.encode(f.encoder, input, options)).toMatchObject({ texture: result.texture, updated: false, passCount: 8 });
    expect(f.encoded).toHaveLength(8);
    expect(pass.encode(f.encoder, input, { ...options, coneMipLevels: 3 })).toMatchObject({
      texture: result.texture, updated: true, radianceMipLevelCount: 3, passCount: 5 });
    expect(f.encoded).toHaveLength(13);
    pass.dispose(); expect(f.owned.size).toBe(0);
  });

  it("rejects unrevisioned source changes before encoding another GPU pass", () => {
    const f = fixture(), pass = new ScreenSpaceReflectionPass(f.session), initial = source();
    pass.encode(f.encoder, initial, options); const encoded = f.encoded.length;
    expect(() => pass.encode(f.encoder, { ...initial, color: texture() }, options)).toThrow(/without a revision/);
    expect(f.encoded).toHaveLength(encoded); pass.dispose();
  });
});
