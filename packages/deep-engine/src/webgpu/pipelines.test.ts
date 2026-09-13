import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import { createPipelines, PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_BYTES, PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT } from "./pipelines.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUColorWrite", { RED: 1, ALL: 15 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(messages: readonly GPUCompilationMessage[] = []) {
  const descriptors: GPURenderPipelineDescriptor[] = [], layouts: GPUBindGroupLayoutDescriptor[] = [];
  const pipelineLayouts: GPUPipelineLayoutDescriptor[] = [];
  const shader = { getCompilationInfo: vi.fn(async () => ({ messages })) } as unknown as GPUShaderModule;
  const device = {
    createShaderModule: vi.fn(() => shader),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => { layouts.push(descriptor); return descriptor as unknown as GPUBindGroupLayout; }),
    createPipelineLayout: vi.fn((descriptor: GPUPipelineLayoutDescriptor) => {
      pipelineLayouts.push(descriptor); return descriptor as unknown as GPUPipelineLayout;
    }),
    createRenderPipelineAsync: vi.fn(async (descriptor: GPURenderPipelineDescriptor) => {
      descriptors.push(descriptor); return { descriptor } as unknown as GPURenderPipeline;
    }),
  };
  return { device: device as unknown as GPUDevice, descriptors, layouts, pipelineLayouts };
}

describe("PBR pipeline texture variants", () => {
  it("bounds material variants while separating transparent depth/blend and masked shadows", async () => {
    const f = fixture(), result = await createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout);
    expect(f.descriptors).toHaveLength(28);
    expect(result.mainPipelines.size).toBe(18); expect(result.shadowPipelines.size).toBe(9);
    expect(f.descriptors.slice(0, 18).map(value => value.fragment && value.fragment.entryPoint)).toEqual([
      ...Array(3).fill("fragmentMain"), ...Array(3).fill("fragmentMainTransparent"),
      ...Array(3).fill("fragmentMaterial"), ...Array(3).fill("fragmentMaterialTransparent"),
      ...Array(3).fill("fragmentMaterial"), ...Array(3).fill("fragmentMaterialTransparent"),
    ]);
    const vertex = f.descriptors[0]!.vertex.buffers![0]!;
    expect(vertex.arrayStride).toBe(40);
    expect(vertex.attributes).toContainEqual({ shaderLocation: 10, offset: 24, format: "float32x4" });
    expect(f.descriptors[0]!.vertex.buffers![1]).toMatchObject({ arrayStride: 144,
      attributes: expect.arrayContaining([{ shaderLocation: 12, offset: 128, format: "float32x4" }]) });
    expect(f.descriptors[0]!.vertex.buffers![2]).toEqual(PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT);
    expect(f.descriptors[12]!.vertex.entryPoint).toBe("vertexNormalMapped");
    expect(f.descriptors[12]!.vertex.buffers![3]).toEqual({ arrayStride: 16,
      attributes: [{ shaderLocation: 11, offset: 0, format: "float32x4" }] });
    expect(f.descriptors[0]!.primitive?.cullMode).toBe("back");
    expect(f.descriptors[2]!.primitive?.cullMode).toBe("none");
    expect(f.descriptors[3]!.depthStencil?.depthWriteEnabled).toBe(false);
    expect(f.descriptors[0]!.multisample?.count).toBe(1);
    expect(f.descriptors[0]!.fragment!.targets.map(target => target!.format)).toEqual([
      "rgba16float", "r32float", "rgba8unorm", "rg16float",
    ]);
    expect(f.descriptors[3]!.fragment!.targets).toHaveLength(2);
    expect(f.descriptors[3]!.fragment!.targets.map(target => target!.format)).toEqual(["rgba16float", "r16float"]);
    expect(f.descriptors[3]!.fragment!.targets[0]!.blend).toEqual({
      color: { operation: "add", srcFactor: "one", dstFactor: "one" },
      alpha: { operation: "add", srcFactor: "one", dstFactor: "one" },
    });
    expect(f.descriptors[20]!.primitive?.cullMode).toBe("none");
    expect(f.descriptors[21]!.fragment?.entryPoint).toBe("shadowMaskPlain");
    expect(f.descriptors[24]!.fragment?.entryPoint).toBe("shadowMaskTextured");
    expect(f.layouts[1]!.entries.map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(f.layouts[3]).toMatchObject({ label: "Deep cascaded shadow group 2", entries: [
      { binding: 0, buffer: { type: "uniform", minBindingSize: CASCADED_SHADOW_UNIFORM_BYTES } },
      { binding: 1, texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, sampler: { type: "comparison" } },
    ] });
    expect(Array.from(f.pipelineLayouts[0]!.bindGroupLayouts)[2]).toBe(f.layouts[3]);
    expect(Array.from(f.pipelineLayouts[1]!.bindGroupLayouts)[2]).toBe(f.layouts[3]);
    expect(f.layouts[0]!.entries[0]!.buffer?.minBindingSize).toBe(PBR_FRAME_UNIFORM_BYTES);
    expect(f.pipelineLayouts.slice(0, 2).map(layout => Array.from(layout.bindGroupLayouts).length)).toEqual([4, 4]);
    expect(Array.from(f.pipelineLayouts[0]!.bindGroupLayouts)[3]).toEqual({});
    expect(PBR_FRAME_UNIFORM_BYTES).toBe(352);
    expect(PBR_FRAME_FLOAT_OFFSETS).toEqual({ currentViewProjection: 0, previousViewProjection: 16, worldToView: 32,
      lightViewProjection: 48, eye: 64, background: 68, floor: 72, lightDirection: 76, tuning: 80, sunColor: 84 });
    expect(PBR_PREVIOUS_INSTANCE_BUFFER_LAYOUT).toMatchObject({ arrayStride: 48, stepMode: "instance",
      attributes: [{ shaderLocation: 13, offset: 0 }, { shaderLocation: 14, offset: 16 }, { shaderLocation: 15, offset: 32 }] });
  });

  it("rejects shader compilation errors before allocating pipelines", async () => {
    const error = { type: "error", lineNum: 17, message: "bad shader" } as GPUCompilationMessage;
    const f = fixture([error]);
    await expect(createPipelines(f.device, "bgra8unorm", {} as GPUBindGroupLayout)).rejects.toThrow("WGSL 17: bad shader");
    expect(f.descriptors).toHaveLength(0);
  });
});
