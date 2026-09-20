import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { packMaterialParameters } from "./materialBindings.js";
import { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { sceneShader } from "./pbrShader.js";
import { buildTextureArrayPlan, MATERIAL_ARRAY_INDICES_BYTES, TextureArrayResources,
  type TextureArrayLayerSource } from "./textureArrayResources.js";
import { composeTextureArraySceneShader } from "./textureArrayWgsl.js";
import { planTextureArrays } from "./textureArrayPacking.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES } from "../shaderAbi/contract.js";

interface OwnedResource { destroy?: () => void }

function fixture(maxArrayLayers = 4) {
  const owned = new Set<OwnedResource>();
  const samplers: GPUSampler[] = [];
  const device = {
    limits: { maxTextureArrayLayers: maxArrayLayers },
    features: new Set<GPUFeatureName>(),
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const texture: GPUTexture = { descriptor, destroy: vi.fn(),
        createView: vi.fn((viewDescriptor: GPUTextureViewDescriptor) => ({ viewDescriptor, texture })),
      } as unknown as GPUTexture;
      return texture;
    }),
    createSampler: vi.fn(() => { const sampler = {} as GPUSampler; samplers.push(sampler); return sampler; }),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroupLayout: vi.fn((descriptor: GPUBindGroupLayoutDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends OwnedResource>(resource: T): T { owned.add(resource); return resource; },
    release(resource: OwnedResource): void { if (owned.delete(resource)) resource.destroy?.(); } };
  return { session: session as unknown as DeviceSession, device, owned, samplers };
}

const sampler = {} as GPUSampler;
const layer = (width: number, overrides: Partial<TextureArrayLayerSource> = {}): TextureArrayLayerSource => ({
  mipLevelCount: 1, sampler,
  levels: [{ data: new Uint8Array(width * width * 4), bytesPerRow: width * 4, width, height: width }],
  ...overrides,
});
const slot = (texture: string) => ({ texture, texCoord: 0 as const, uvTransform: [1, 0, 0, 0, 1, 0] as const });

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("texture array level 1 (wave 5 bindless)", () => {
  it("keeps the default path byte-identical: no array tokens on group(1), feature off, 160B ABI untouched", () => {
    expect(sceneShader).toContain("@group(1) @binding(0) var baseColorMap: texture_2d<f32>;");
    expect(sceneShader).not.toContain("deepArrayMap");
    expect(sceneShader).not.toContain("materialArrayIndices");
    expect(sceneShader).not.toContain("MaterialArrayIndices");
    expect(DEFAULT_PBR_RENDERER_FEATURES.textureArrays).toBe(false);
    expect(resolvePbrRendererFeatures({}).textureArrays).toBe(false);
    expect(resolvePbrRendererFeatures({ textureArrays: true }).textureArrays).toBe(true);
    expect(() => resolvePbrRendererFeatures({ textureArrays: "yes" as unknown as boolean })).toThrow(TypeError);
    // 默认关闭路径不写入索引通道：材质 ABI 块保持 40 float = 160B 指纹（emissiveStrength 在 offset 39）。
    const packed = packMaterialParameters({ emissiveStrength: 1 });
    expect(packed.length).toBe(40);
    expect(packed.byteLength).toBe(DEEP_PBR_MESH_V1_BYTE_SIZES.material);
    expect(packed[39]).toBe(1);
  });

  it("composes the texture_2d_array variant only for group(1) and fails closed on anchor drift", () => {
    const composed = composeTextureArraySceneShader(sceneShader);
    expect(composed.match(/@group\(1\) @binding\(\d+\) var deepArrayMap\d: texture_2d_array<f32>;/g)).toHaveLength(5);
    expect(composed.match(/@group\(1\) @binding\(\d+\) var deepArraySampler\d: sampler;/g)).toHaveLength(5);
    expect(composed).toContain("@group(1) @binding(10) var<uniform> materialTextures: MaterialTextures;");
    expect(composed).toContain("struct MaterialArrayIndices { layerRow: vec4i, emissiveLayerRow: vec4i };");
    expect(composed.match(/materialArrayIndices\./g)).toHaveLength(6);
    for (const legacy of ["baseColorMap", "metallicRoughnessMap", "occlusionMap", "normalMap", "emissiveMap"]) {
      expect(composed).not.toContain(legacy);
    }
    expect(composed).toContain("@fragment fn fragmentMaterial(");
    // group(2) 级联阴影与 group(3) 探针 GI 的既有数组绑定不受改写影响。
    expect(composed).toContain("deepShadowMap: texture_depth_2d_array");
    expect(composed).toContain("deepGiVolume: texture_2d_array<f32>");
    const tampered = sceneShader.replace("baseColorMap: texture_2d<f32>;", "baseColorMap: texture_2d<f32>; // drift");
    expect(() => composeTextureArraySceneShader(tampered)).toThrow(/exactly once.*found 0/);
    expect(() => composeTextureArraySceneShader(sceneShader + sceneShader)).toThrow(/found 2/);
  });

  it("runs plan → arrays → material bind group end to end on a stub device", () => {
    const f = fixture();
    const plan = buildTextureArrayPlan([
      { textureId: "t-a", format: "rgba8unorm", width: 4, height: 4 },
      { textureId: "t-b", format: "rgba8unorm", width: 4, height: 4 },
      { textureId: "t-c", format: "rgba8unorm", width: 8, height: 8 },
    ], f.session);
    const resources = new TextureArrayResources(f.session, plan, id => layer(id === "t-c" ? 8 : 4));
    expect(f.device.createTexture.mock.calls[0]![0]).toMatchObject({
      size: { width: 4, height: 4, depthOrArrayLayers: 2 }, format: "rgba8unorm", mipLevelCount: 1, dimension: "2d" });
    expect(f.device.queue.writeTexture.mock.calls.map(call => (call[0] as GPUTextureCopyView).origin?.z)).toEqual([0, 1, 0]);
    const pooled = { destroy: vi.fn() } as unknown as GPUBuffer;
    const material = { emissiveStrength: 1, baseColor: slot("t-b"), normal: { ...slot("t-c"), normalScale: 1 } };
    const group = resources.materialGroup(material, pooled)!;
    expect(group.key).toBe("t-b|-|-|t-c|-");
    const entries = (f.device.createBindGroup.mock.calls[0]![0] as GPUBindGroupDescriptor).entries;
    const resourceOf = (binding: number) => entries.find(entry => entry.binding === binding)!.resource;
    expect((resourceOf(0) as { viewDescriptor?: object }).viewDescriptor).toMatchObject({ dimension: "2d-array" });
    expect(resourceOf(0)).not.toBe(resourceOf(3)); // baseColor 与 normal 落在不同数组
    expect((resourceOf(2) as { viewDescriptor?: object }).viewDescriptor).toMatchObject({ dimension: "2d-array" });
    expect(resourceOf(2)).not.toBe(resourceOf(0)); // 未用槽位（occlusion）纹理绑哑元数组
    expect(resourceOf(7)).toBe(f.samplers[0]); // 哑元采样器是首个也是唯一 createSampler
    expect(resourceOf(5)).toBe(sampler);
    expect(resourceOf(10)).toEqual({ buffer: pooled });
    const indices = f.device.queue.writeBuffer.mock.calls[0]![2] as Uint32Array;
    expect([...indices]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]); // baseColor=t-b → array0 层 1
    expect(indices.byteLength).toBe(MATERIAL_ARRAY_INDICES_BYTES);
    expect(resources.stats).toMatchObject({ arrays: 2, layeredTextures: 3, overflowed: 0,
      materialFallbacks: 0, materialGroups: 1 });
    resources.dispose();
    expect(pooled.destroy).not.toHaveBeenCalled(); // 外部池化参数不归本资源集释放
    expect(f.owned.size).toBe(0);
    expect(() => resources.materialGroup(material, pooled)).toThrow(/not ready/);
  });

  it("falls back the whole material when any used slot overflowed, and counts it", () => {
    const f = fixture(1);
    const plan = buildTextureArrayPlan([
      { textureId: "a", format: "rgba8unorm", width: 4, height: 4 },
      { textureId: "b", format: "rgba8unorm", width: 4, height: 4 },
    ], f.session);
    expect(plan.overflowed).toEqual(["b"]);
    const resources = new TextureArrayResources(f.session, plan, () => layer(4));
    expect(resources.materialGroup({ emissiveStrength: 1, baseColor: slot("b"),
      normal: { ...slot("a"), normalScale: 1 } })).toBeUndefined();
    expect(resources.stats.materialFallbacks).toBe(1);
    expect(resources.materialGroup({ emissiveStrength: 1, baseColor: slot("a") })).toBeDefined();
    expect(resources.materialGroup({ emissiveStrength: 1 })).toBeUndefined(); // 无纹理槽位走 plain 路径，不计数
    expect(resources.stats.materialFallbacks).toBe(1);
    expect(resources.stats.materialGroups).toBe(1);
  });

  it("rejects plans that exceed device layers or carry incoherent assignments", () => {
    const f = fixture(4);
    const oversized = planTextureArrays({ maxArrayLayers: 8,
      entries: [1, 2, 3, 4, 5].map(id => ({ textureId: `t${id}`, format: "rgba8unorm", width: 4, height: 4 })) });
    expect(() => new TextureArrayResources(f.session, oversized, () => layer(4)))
      .toThrow(/exceeds device maxTextureArrayLayers/);
    const plan = buildTextureArrayPlan([{ textureId: "a", format: "rgba8unorm", width: 4, height: 4 }], f.session);
    const mutable = plan.assignments as Map<string, { arrayIndex: number; layerIndex: number }>;
    mutable.set("ghost", { arrayIndex: 9, layerIndex: 0 });
    expect(() => new TextureArrayResources(f.session, plan, () => layer(4))).toThrow(/out of bounds/);
    mutable.clear();
    mutable.set("a", { arrayIndex: 0, layerIndex: 5 });
    expect(() => new TextureArrayResources(f.session, plan, () => layer(4))).toThrow(/out of bounds/);
    mutable.clear();
    expect(() => new TextureArrayResources(f.session, { arrays: [{ format: "rgba8unorm", width: 4, height: 4,
      arrayIndex: 0, layers: ["a"] }], assignments: new Map([["a", { arrayIndex: 0, layerIndex: 0 }]]),
      overflowed: ["a"] }, () => layer(4))).toThrow(/must not keep an array assignment/);
  });

  it("admits only uniform-sampler, uncompressed, extent-consistent layers into one array", () => {
    const f = fixture();
    const entry = { textureId: "a", format: "rgba8unorm", width: 4, height: 4 };
    const plan = buildTextureArrayPlan([entry, { ...entry, textureId: "b" }], f.session);
    const cases: [string, (id: string) => TextureArrayLayerSource, RegExp][] = [
      ["one shared sampler", id => ({ ...layer(4), sampler: ({ id } as object) as GPUSampler }), /one shared sampler/],
      ["uniform mip counts", id => layer(4, { mipLevelCount: id === "b" ? 2 : 1 }), /uniform mip level counts/],
      ["no compressed layers", id => (id === "b"
        ? { ...layer(4), requiredFeature: "texture-compression-bc" } : layer(4)), /not admitted into arrays/],
      ["extent consistency", id => (id === "b"
        ? { ...layer(4), levels: [{ data: new Uint8Array(4), bytesPerRow: 4, width: 1, height: 1 }] } : layer(4)),
        /does not match the array extent/],
    ];
    for (const [name, resolve, message] of cases) {
      try {
        new TextureArrayResources(f.session, plan, resolve);
        expect.unreachable(`${name} must fail closed.`);
      } catch (error) {
        expect((error as Error).message).toMatch(message);
      }
      expect(f.owned.size, name).toBe(0); // 失败路径不遗留 GPU 资源
    }
  });

  it("pins the array bind group layout to the 160B material ABI plus the 32B opt-in index channel", () => {
    const f = fixture();
    const plan = buildTextureArrayPlan([{ textureId: "a", format: "rgba8unorm", width: 4, height: 4 }], f.session);
    const resources = new TextureArrayResources(f.session, plan, () => layer(4));
    const entries = (f.device.createBindGroupLayout.mock.calls[0]![0] as GPUBindGroupLayoutDescriptor).entries;
    expect(entries).toHaveLength(12);
    expect(entries.find(entry => entry.binding === 0))
      .toMatchObject({ visibility: 2, texture: { sampleType: "float", viewDimension: "2d-array" } });
    expect(entries.find(entry => entry.binding === 10))
      .toMatchObject({ buffer: { type: "uniform", minBindingSize: DEEP_PBR_MESH_V1_BYTE_SIZES.material } });
    expect(entries.find(entry => entry.binding === 11))
      .toMatchObject({ buffer: { type: "uniform", minBindingSize: MATERIAL_ARRAY_INDICES_BYTES } });
    resources.dispose(); resources.dispose(); // 幂等
    expect(f.owned.size).toBe(0);
  });
});
