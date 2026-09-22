import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { createPipelines } from "./pipelines.js";

function fixture() {
  const shaders: GPUShaderModuleDescriptor[] = [];
  const layouts: GPUBindGroupLayoutDescriptor[] = [];
  const shader = { getCompilationInfo: vi.fn(async () => ({ messages: [] })) } as unknown as GPUShaderModule;
  const device = {
    createShaderModule: vi.fn((descriptor: GPUShaderModuleDescriptor) => { shaders.push(descriptor); return shader; }),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => {
      layouts.push(descriptor); return descriptor as unknown as GPUBindGroupLayout;
    }),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => descriptor as unknown as GPUPipelineLayout),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) =>
      ({ descriptor }) as unknown as GPURenderPipeline),
  };
  return { device: device as unknown as GPUDevice, shaders, layouts };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => vi.unstubAllGlobals());

describe("texture-array PBR pipeline variant", () => {
  it("keeps the default shader and material layout unchanged", async () => {
    const f = fixture();
    await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    expect(f.shaders[0]!.code).toBe(sceneShader);
    const material = f.layouts[1]!;
    expect(material.entries.find(entry => entry.binding === 0)?.texture?.viewDimension).not.toBe("2d-array");
    expect(material.entries.some(entry => entry.buffer?.hasDynamicOffset)).toBe(false);
  });

  it("compiles the static array shader against the shared indexed storage table ABI", async () => {
    const f = fixture();
    await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout,
      true, false, false, { textureArrays: true });
    const shader = String(f.shaders[0]!.code);
    expect(shader).toContain("@group(1) @binding(0) var deepArrayMap0: texture_2d_array<f32>;");
    expect(shader).toContain("@group(1) @binding(4) var deepArrayMap4: texture_2d_array<f32>;");
    expect(shader).toContain("@group(1) @binding(5) var deepArraySampler0: sampler;");
    const material = f.layouts[1]!;
    expect(material.entries.filter(entry => entry.texture).map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4]);
    expect(material.entries.filter(entry => entry.sampler).map(entry => entry.binding)).toEqual([5, 6, 7, 8, 9]);
    expect(material.entries.filter(entry => entry.buffer?.type === "read-only-storage").map(entry => entry.binding)).toEqual([10]);
    expect(material.entries.some(entry => entry.buffer?.hasDynamicOffset)).toBe(false);
    expect(shader).toContain("@location(13) @interpolate(flat) materialRow: u32");
    expect(shader).toContain("materialTable[v.materialRow]");
  });

  it("adds deformation streams beside the array table without binding collisions", async () => {
    const f = fixture();
    await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout,
      true, false, false, { textureArrays: true, deformation: true });
    const material = f.layouts[1]!;
    expect(material.entries.map(entry => entry.binding).sort((a, b) => a - b))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(material.entries.find(entry => entry.binding === 11)?.buffer?.type).toBe("read-only-storage");
    expect(material.entries.find(entry => entry.binding === 10)?.buffer?.type).toBe("read-only-storage");
    expect(String(f.shaders[0]!.code)).toContain("@group(1) @binding(12) var<storage, read> deepPreviousPose");
    expect(String(f.shaders[0]!.code)).toContain("out.dielectric = deepDielectricF0(v.normal0.w);");
  });
});
