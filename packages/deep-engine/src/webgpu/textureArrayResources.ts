/**
 * 级 1 纹理数组化资源层（波次5 bindless）：消费 planTextureArrays 的计划，创建
 * texture_2d_array 与采样器，并把材质装进数组版 bind group。fail-closed 纪律：
 * - 计划层上限按设备 maxTextureArrayLayers（buildTextureArrayPlan 统一取值）；
 * - 计划一致性（越界 arrayIndex/layerIndex、溢出纹理残留分配、超设备上限）构造期
 *   直接抛错，绝不静默钳制；
 * - 数组内各层必须共享同一采样器、同一 mip 级数、同一未压缩格式特征；压缩层在级 1
 *   显式拒绝；
 * - 材质任一在用槽位缺少数组分配（溢出/缺失）→ 整个材质回退常规 bind group 路径并
 *   计数，绝不部分数组化。
 * 材质 ABI 纪律：160B material uniform 块原样复用（SHA-256 指纹不变）；数组索引通道
 * 是新增的独立 32B opt-in uniform（MaterialArrayIndices），默认关闭路径不创建不写入。
 */
import type { PreparedMaterialTextures } from "../renderPacket.js";
import { DEEP_PBR_MESH_V1_BYTE_SIZES } from "../shaderAbi/contract.js";
import type { DeviceSession } from "./deviceSession.js";
import { packMaterialParameters } from "./materialBindings.js";
import { uploadBuffer } from "./meshBuffers.js";
import { createAdmittedTexture } from "./resourceAdmission.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { planTextureArrays, type TextureArrayPackingEntry, type TextureArrayPlan } from "./textureArrayPacking.js";

type TextureArraySlotName = "baseColor" | "metallicRoughness" | "occlusion" | "normal" | "emissive";

/** 槽位→绑定号静态映射：0..4 数组纹理、5..9 采样器；indexOffset 是 32B 索引通道内偏移。 */
export const TEXTURE_ARRAY_SLOT_BINDINGS = Object.freeze([
  { slot: "baseColor", mapBinding: 0, samplerBinding: 5, indexOffset: 0 },
  { slot: "metallicRoughness", mapBinding: 1, samplerBinding: 6, indexOffset: 1 },
  { slot: "occlusion", mapBinding: 2, samplerBinding: 7, indexOffset: 2 },
  { slot: "normal", mapBinding: 3, samplerBinding: 8, indexOffset: 3 },
  { slot: "emissive", mapBinding: 4, samplerBinding: 9, indexOffset: 4 },
] as const satisfies readonly { slot: TextureArraySlotName; mapBinding: number; samplerBinding: number; indexOffset: number }[]);

/** MaterialArrayIndices = layerRow(vec4i) + emissiveLayerRow(vec4i)；array_index 语义是 i32。 */
export const MATERIAL_ARRAY_INDEX_FLOATS = 8;
export const MATERIAL_ARRAY_INDICES_BYTES = MATERIAL_ARRAY_INDEX_FLOATS * Int32Array.BYTES_PER_ELEMENT;

/** 上传就绪的单层数据；压缩纹理（requiredFeature）在级 1 显式拒绝入数组。 */
export interface TextureArrayLayerSource {
  readonly mipLevelCount: number;
  readonly sampler: GPUSampler;
  readonly requiredFeature?: string;
  readonly levels: readonly { readonly data: ArrayBufferView<ArrayBuffer>; readonly bytesPerRow: number;
    readonly width: number; readonly height: number }[];
}

export interface TextureArrayStats {
  readonly arrays: number;
  readonly layeredTextures: number;
  readonly overflowed: number;
  readonly materialFallbacks: number;
  readonly materialGroups: number;
}

export interface TextureArrayMaterialGroup {
  readonly group: GPUBindGroup;
  /** 32B 数组索引通道 buffer；生命周期归本资源集，调用方不得释放。 */
  readonly indices: GPUBuffer;
  readonly key: string;
}

/** 设备上限即计划上限：maxTextureArrayLayers 直接决定分箱溢出线。 */
export function buildTextureArrayPlan(entries: readonly TextureArrayPackingEntry[],
  session: DeviceSession): TextureArrayPlan {
  const maxArrayLayers = session.device.limits.maxTextureArrayLayers;
  if (!Number.isSafeInteger(maxArrayLayers) || maxArrayLayers < 1) {
    throw new Error("Device maxTextureArrayLayers is unavailable.");
  }
  return planTextureArrays({ entries, maxArrayLayers });
}

function validatePlan(plan: TextureArrayPlan, maxArrayLayers: number): void {
  plan.arrays.forEach((array, index) => {
    if (array.arrayIndex !== index) throw new Error(`Texture array index diverged from position: ${array.arrayIndex}.`);
    if (array.layers.length > maxArrayLayers) {
      throw new Error(`Texture array ${index} exceeds device maxTextureArrayLayers (${array.layers.length} > ${maxArrayLayers}).`);
    }
  });
  for (const [textureId, assignment] of plan.assignments) {
    const array = plan.arrays[assignment.arrayIndex];
    if (!array || array.layers[assignment.layerIndex] !== textureId) {
      throw new Error(`Texture array assignment is out of bounds: ${textureId}.`);
    }
  }
  for (const textureId of plan.overflowed) {
    if (plan.assignments.has(textureId)) {
      throw new Error(`Overflowed texture must not keep an array assignment: ${textureId}.`);
    }
  }
}

interface ArrayBinding { readonly view: GPUTextureView; readonly sampler: GPUSampler }

/** 计划→texture_2d_array 资源→数组材质 bind group；生命周期统一归 dispose。 */
export class TextureArrayResources {
  readonly materialLayout: GPUBindGroupLayout;
  private readonly arrayBindings = new Map<number, ArrayBinding>();
  private readonly createdTextures: GPUTexture[] = [];
  private readonly ownedIndexBuffers: GPUBuffer[] = [];
  private readonly ownedParameters: GPUBuffer[] = [];
  private readonly counters = { materialFallbacks: 0, materialGroups: 0 };
  private readonly dummyView: GPUTextureView;
  private readonly dummySampler: GPUSampler;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly plan: TextureArrayPlan,
    private readonly resolve: (textureId: string) => TextureArrayLayerSource) {
    const maxArrayLayers = session.device.limits.maxTextureArrayLayers;
    if (!Number.isSafeInteger(maxArrayLayers) || maxArrayLayers < 1) {
      throw new Error("Device maxTextureArrayLayers is unavailable.");
    }
    validatePlan(plan, maxArrayLayers);
    const created: GPUTexture[] = [];
    try {
      for (const array of plan.arrays) created.push(this.stageArray(array));
      const dummy = createAdmittedTexture(session, { label: "Deep texture array dummy",
        size: { width: 1, height: 1, depthOrArrayLayers: 1 }, format: "rgba8unorm", mipLevelCount: 1,
        dimension: "2d", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      created.push(dummy);
      this.createdTextures.push(...created);
      this.dummyView = dummy.createView({ label: "Deep texture array dummy", dimension: "2d-array" });
      this.dummySampler = session.device.createSampler({ label: "Deep texture array dummy sampler" });
      const fragment = GPUShaderStage.FRAGMENT;
      this.materialLayout = session.device.createBindGroupLayout({ label: "Deep material texture arrays", entries: [
        ...TEXTURE_ARRAY_SLOT_BINDINGS.flatMap(config => ([
          { binding: config.mapBinding, visibility: fragment,
            texture: { sampleType: "float" as const, viewDimension: "2d-array" as const } },
          { binding: config.samplerBinding, visibility: fragment, sampler: {} },
        ])),
        { binding: 10, visibility: fragment, buffer: { type: "uniform", minBindingSize: DEEP_PBR_MESH_V1_BYTE_SIZES.material } },
        { binding: 11, visibility: fragment, buffer: { type: "uniform", minBindingSize: MATERIAL_ARRAY_INDICES_BYTES } },
      ] });
    } catch (error) {
      runResourceCleanup("Texture array staging rollback failed.",
        created.map(texture => () => session.release(texture)));
      throw error;
    }
  }

  get stats(): TextureArrayStats {
    return Object.freeze({ arrays: this.plan.arrays.length, layeredTextures: this.plan.assignments.size,
      overflowed: this.plan.overflowed.length, ...this.counters });
  }

  /** 材质数组 bind group；任一在用槽位无法数组化时返回 undefined（调用方回退常规路径）。 */
  materialGroup(textures: PreparedMaterialTextures, parameters?: GPUBuffer): TextureArrayMaterialGroup | undefined {
    this.assertReady();
    const slots = TEXTURE_ARRAY_SLOT_BINDINGS.map(config => {
      const slot = textures[config.slot];
      const assignment = slot ? this.plan.assignments.get(slot.texture) : undefined;
      return { config, slot, assignment, missing: slot !== undefined && assignment === undefined };
    });
    if (slots.every(entry => entry.slot === undefined)) return undefined;
    if (slots.some(entry => entry.missing)) { this.counters.materialFallbacks++; return undefined; }
    const indices = new Uint32Array(MATERIAL_ARRAY_INDEX_FLOATS);
    const textureEntries: GPUBindGroupEntry[] = [];
    for (const entry of slots) {
      const array = entry.assignment === undefined ? undefined : this.arrayBindings.get(entry.assignment.arrayIndex);
      if (entry.assignment !== undefined && !array) {
        throw new Error(`Texture array binding is unavailable: ${entry.slot?.texture}`);
      }
      indices[entry.config.indexOffset] = entry.assignment?.layerIndex ?? 0;
      textureEntries.push({ binding: entry.config.mapBinding, resource: array?.view ?? this.dummyView });
      textureEntries.push({ binding: entry.config.samplerBinding, resource: array?.sampler ?? this.dummySampler });
    }
    const ownParameters = parameters === undefined;
    const parameterBuffer = parameters
      ?? uploadBuffer(this.session, "Deep material textures", packMaterialParameters(textures), GPUBufferUsage.UNIFORM);
    const indexBuffer = uploadBuffer(this.session, "Deep material array indices", indices, GPUBufferUsage.UNIFORM);
    try {
      const group = this.session.device.createBindGroup({ label: "Deep material texture arrays",
        layout: this.materialLayout, entries: [...textureEntries,
          { binding: 10, resource: { buffer: parameterBuffer } },
          { binding: 11, resource: { buffer: indexBuffer } }] });
      this.ownedIndexBuffers.push(indexBuffer);
      if (ownParameters) this.ownedParameters.push(parameterBuffer);
      this.counters.materialGroups++;
      return { group, indices: indexBuffer, key: slots.map(entry => entry.slot?.texture ?? "-").join("|") };
    } catch (error) {
      this.session.release(indexBuffer);
      if (ownParameters) this.session.release(parameterBuffer);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    runResourceCleanup("Texture array disposal failed.", [
      ...this.createdTextures.map(texture => () => this.session.release(texture)),
      ...this.ownedIndexBuffers.map(buffer => () => this.session.release(buffer)),
      ...this.ownedParameters.map(buffer => () => this.session.release(buffer)),
    ]);
  }

  private stageArray(array: TextureArrayPlan["arrays"][number]): GPUTexture {
    const sources = array.layers.map(id => this.resolve(id));
    const mipLevelCount = sources[0]?.mipLevelCount;
    if (!sources.length || sources.some(source => source.mipLevelCount !== mipLevelCount)) {
      throw new Error(`Texture array ${array.arrayIndex} requires uniform mip level counts.`);
    }
    if (new Set(sources.map(source => source.sampler)).size !== 1) {
      throw new Error(`Texture array ${array.arrayIndex} requires one shared sampler across layers.`);
    }
    const texture = createAdmittedTexture(this.session, { label: `Deep texture array ${array.arrayIndex}`,
      size: { width: array.width, height: array.height, depthOrArrayLayers: array.layers.length },
      format: array.format as GPUTextureFormat, mipLevelCount: mipLevelCount!, dimension: "2d",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    try {
      array.layers.forEach((textureId, layerIndex) => {
        const source = sources[layerIndex]!;
        if (source.requiredFeature) {
          throw new Error(`Texture ${textureId} requires ${source.requiredFeature}; compressed layers are not admitted into arrays at level 1.`);
        }
        if (source.levels.length !== mipLevelCount) throw new Error(`Texture ${textureId} level count diverged from its array.`);
        source.levels.forEach((level, mipLevel) => {
          if (level.width !== Math.max(1, array.width >> mipLevel) || level.height !== Math.max(1, array.height >> mipLevel)) {
            throw new Error(`Texture ${textureId} mip ${mipLevel} does not match the array extent.`);
          }
          this.session.device.queue.writeTexture({ texture, mipLevel, origin: { x: 0, y: 0, z: layerIndex } },
            level.data, { bytesPerRow: level.bytesPerRow, rowsPerImage: level.height },
            { width: level.width, height: level.height, depthOrArrayLayers: 1 });
        });
      });
    } catch (error) { this.session.release(texture); throw error; }
    this.arrayBindings.set(array.arrayIndex,
      { view: texture.createView({ label: `Deep texture array ${array.arrayIndex}`, dimension: "2d-array" }),
        sampler: sources[0]!.sampler });
    return texture;
  }

  private assertReady(): void {
    if (this.disposed || this.session.state !== "ready") throw new Error("Texture array resources are not ready.");
  }
}
