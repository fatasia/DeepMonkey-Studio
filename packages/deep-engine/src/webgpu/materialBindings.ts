import type { PreparedMaterialTextures } from "../renderPacket.js";
import { DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS } from "../shaderAbi/contract.js";
import { packExtendedParameterBlock } from "../shader/materialParameterAbi.js";
import { MATERIAL_PARAMETER_ADVANCED_BAND_FLOAT_OFFSET, MATERIAL_PARAMETER_ADVANCED_FLOATS,
  MATERIAL_PARAMETER_SPECULAR_FACTOR_FLOAT_OFFSET, MATERIAL_PARAMETER_SPECULAR_TEXTURE_FLOAT_OFFSET,
  MATERIAL_PARAMETER_SPECULAR_COLOR_TEXTURE_FLOAT_OFFSET,
  packAdvancedParameterBlock } from "../shader/materialAdvancedParameters.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import type { TextureBinding } from "./textureResources.js";
import { createLayeredMaterialBinding, createLayeredNeutralTexture, type LayeredMaterialBinding } from "./pbrLayeredMaterialBindings.js";

export interface MaterialBinding {
  readonly group: GPUBindGroup;
  readonly parameters: GPUBuffer;
  readonly base?: TextureBinding;
  readonly metallicRoughness?: TextureBinding;
  readonly normal?: TextureBinding;
  readonly occlusion?: TextureBinding;
  readonly emissive?: TextureBinding;
  readonly specular?: TextureBinding;
  readonly specularColor?: TextureBinding;
  readonly key: string;
  readonly layered?: LayeredMaterialBinding;
  readonly neutral?: TextureBinding;
}

export interface MaterialLayouts { readonly material: GPUBindGroupLayout; readonly layeredMaterials?: boolean; readonly advancedMaterials?: boolean }

interface PooledMaterialBinding {
  readonly binding: MaterialBinding;
  readonly parameterKey: string;
  references: number;
}

interface PooledMaterialParameters { readonly buffer: GPUBuffer; references: number }

export interface MaterialBindingPoolStats {
  readonly bindGroups: number;
  readonly parameterBuffers: number;
  readonly parameterBytes: number;
  readonly bindGroupHits: number;
  readonly bindGroupMisses: number;
  readonly parameterHits: number;
  readonly parameterMisses: number;
}

/**
 * Packet-local material interning. Batches split by geometry and raster mode can share one
 * immutable texture uniform and bind group while retaining independent instance records.
 */
export class MaterialBindingPool {
  private readonly entries = new Map<string, PooledMaterialBinding>();
  private readonly parameters = new Map<string, PooledMaterialParameters>();
  private readonly keys = new Map<MaterialBinding, string>();
  private readonly textureIds = new WeakMap<object, number>();
  private nextTextureId = 1;
  private readonly counters = { bindGroupHits: 0, bindGroupMisses: 0, parameterHits: 0, parameterMisses: 0 };

  constructor(
    private readonly session: DeviceSession,
    private readonly layouts: MaterialLayouts | undefined,
  ) {}

  get stats(): MaterialBindingPoolStats {
    return Object.freeze({ bindGroups: this.entries.size, parameterBuffers: this.parameters.size,
      parameterBytes: this.parameters.size * (this.layouts?.advancedMaterials === true ? MATERIAL_PARAMETER_ADVANCED_FLOATS : MATERIAL_PARAMETER_FLOATS)
        * Float32Array.BYTES_PER_ELEMENT,
      ...this.counters });
  }

  acquire(textures: PreparedMaterialTextures | undefined,
    lookup: (id: string) => TextureBinding): MaterialBinding | undefined {
    if (!textures) return undefined;
    const key = this.poolKey(textures, lookup);
    const existing = this.entries.get(key);
    if (existing) {
      existing.references++; this.counters.bindGroupHits++;
      return existing.binding;
    }
    this.counters.bindGroupMisses++;
    const parameterKey = materialParameterKey(textures, this.layouts?.advancedMaterials === true);
    const parameters = this.acquireParameters(parameterKey, textures);
    let binding: MaterialBinding;
    try { binding = createMaterialBinding(this.session, this.layouts, textures, lookup, parameters)!; }
    catch (error) { this.releaseParameters(parameterKey); throw error; }
    this.entries.set(key, { binding, parameterKey, references: 1 });
    this.keys.set(binding, key);
    return binding;
  }

  release(binding: MaterialBinding | undefined): void {
    if (!binding) return;
    const key = this.keys.get(binding);
    const entry = key === undefined ? undefined : this.entries.get(key);
    if (!entry || entry.binding !== binding || entry.references <= 0) {
      throw new Error("Material binding is not owned by this pool.");
    }
    entry.references--;
    if (entry.references > 0) return;
    this.entries.delete(key!);
    this.keys.delete(binding);
    if (binding.layered) this.session.release(binding.layered.uniform);
    if (binding.neutral) this.session.release(binding.neutral.texture);
    this.releaseParameters(entry.parameterKey);
  }

  private poolKey(textures: PreparedMaterialTextures, lookup: (id: string) => TextureBinding): string {
    const slots = [textures.baseColor, textures.metallicRoughness, textures.normal,
      textures.occlusion, textures.emissive, textures.specular, textures.specularColor,
      ...(textures.layered?.textures.flatMap(layer => [layer.baseColor, layer.metallicRoughness]) ?? [])];
    const identities = slots.map(slot => slot ? this.textureId(lookup(slot.texture)) : 0);
    return `${materialKey(textures)}|${identities.join(",")}`;
  }

  private textureId(binding: TextureBinding): number {
    const value = binding as object;
    const existing = this.textureIds.get(value);
    if (existing !== undefined) return existing;
    const id = this.nextTextureId++;
    this.textureIds.set(value, id);
    return id;
  }

  private acquireParameters(key: string, textures: PreparedMaterialTextures): GPUBuffer {
    const existing = this.parameters.get(key);
    if (existing) { existing.references++; this.counters.parameterHits++; return existing.buffer; }
    const buffer = uploadBuffer(this.session, "Deep material parameter pool",
      packMaterialParameters(textures, this.layouts?.advancedMaterials === true), GPUBufferUsage.UNIFORM);
    this.parameters.set(key, { buffer, references: 1 }); this.counters.parameterMisses++;
    return buffer;
  }

  private releaseParameters(key: string): void {
    const entry = this.parameters.get(key);
    if (!entry || entry.references <= 0) throw new Error("Material parameters are not owned by this pool.");
    entry.references--;
    if (entry.references > 0) return;
    this.parameters.delete(key); this.session.release(entry.buffer);
  }
}

/**
 * 一个有界的完整材质布局承载五种 glTF core 纹理。未启用槽位绑定已存在纹理作哑元，
 * WGSL 通过每槽 uniform 标志跳过采样，从而避免纹理组合造成 bind-layout/pipeline 笛卡尔积。
 */
export function createMaterialBinding(session: DeviceSession, layouts: MaterialLayouts | undefined,
  textures: PreparedMaterialTextures | undefined, lookup: (id: string) => TextureBinding,
  pooledParameters?: GPUBuffer): MaterialBinding | undefined {
  if (!textures) return undefined;
  if (!layouts) throw new Error("Material bind group layout is unavailable.");
  if (textures.layered && !layouts.layeredMaterials) throw new Error("PBR capability layered-materials/not-enabled.");
  if ((textures.advanced || textures.specularFactor !== undefined) && !layouts.advancedMaterials)
    throw new Error("PBR capability advanced-materials/not-enabled.");
  const fallbackSlot = textures.baseColor ?? textures.metallicRoughness ?? textures.normal ?? textures.occlusion ?? textures.emissive
    ?? textures.specular ?? textures.specularColor
    ?? textures.layered?.textures.flatMap(layer => [layer.baseColor, layer.metallicRoughness]).find(Boolean);
  const neutral = fallbackSlot ? undefined
    : layouts.layeredMaterials || layouts.advancedMaterials ? createLayeredNeutralTexture(session) : undefined;
  if (!fallbackSlot && !neutral) throw new Error("Material has no texture backing.");
  const fallback = fallbackSlot ? lookup(fallbackSlot.texture) : neutral!;
  const base = textures.baseColor ? lookup(textures.baseColor.texture) : undefined;
  const metallicRoughness = textures.metallicRoughness ? lookup(textures.metallicRoughness.texture) : undefined;
  const normal = textures.normal ? lookup(textures.normal.texture) : undefined;
  const occlusion = textures.occlusion ? lookup(textures.occlusion.texture) : undefined;
  const emissive = textures.emissive ? lookup(textures.emissive.texture) : undefined;
  const specular = textures.specular ? lookup(textures.specular.texture) : undefined;
  const specularColor = textures.specularColor ? lookup(textures.specularColor.texture) : undefined;
  let parameters: GPUBuffer;
  try { parameters = pooledParameters
    ?? uploadBuffer(session, "Deep material textures", packMaterialParameters(textures, layouts.advancedMaterials === true), GPUBufferUsage.UNIFORM); }
  catch (error) { if (neutral) session.release(neutral.texture); throw error; }
  let layered: LayeredMaterialBinding | undefined;
  try {
    layered = layouts.layeredMaterials ? createLayeredMaterialBinding(session, textures, lookup, fallback) : undefined;
    const actual = (binding: TextureBinding | undefined) => binding ?? fallback;
    const b = actual(base), mr = actual(metallicRoughness), ao = actual(occlusion), n = actual(normal), e = actual(emissive);
    const group = session.device.createBindGroup({ label: "Deep material textures", layout: layouts.material, entries: [
      { binding: 0, resource: b.view }, { binding: 1, resource: b.sampler },
      { binding: 2, resource: mr.view }, { binding: 3, resource: mr.sampler },
      { binding: 4, resource: { buffer: parameters } },
      { binding: 5, resource: ao.view }, { binding: 6, resource: ao.sampler },
      { binding: 7, resource: n.view }, { binding: 8, resource: n.sampler },
      { binding: 9, resource: e.view }, { binding: 10, resource: e.sampler },
      ...(layouts.advancedMaterials ? [
        { binding: 16, resource: actual(specular).view }, { binding: 17, resource: actual(specular).sampler },
        { binding: 18, resource: actual(specularColor).view }, { binding: 19, resource: actual(specularColor).sampler },
      ] : []),
      ...(layered?.entries ?? []),
    ] });
    return { group, parameters, ...(base ? { base } : {}), ...(metallicRoughness ? { metallicRoughness } : {}),
      ...(normal ? { normal } : {}), ...(occlusion ? { occlusion } : {}), ...(emissive ? { emissive } : {}),
      ...(specular ? { specular } : {}), ...(specularColor ? { specularColor } : {}),
      ...(layered ? { layered } : {}), ...(neutral ? { neutral } : {}), key: materialKey(textures) };
  } catch (error) {
    if (layered) session.release(layered.uniform);
    if (neutral) session.release(neutral.texture);
    if (!pooledParameters) session.release(parameters); throw error;
  }
}

export function materialBindingMatches(binding: MaterialBinding | undefined, textures: PreparedMaterialTextures | undefined,
  lookup: (id: string) => TextureBinding): boolean {
  if (!textures) return binding === undefined;
  if (!binding) return false;
  const actual = (slot: { readonly texture: string } | undefined) => slot ? lookup(slot.texture) : undefined;
  return binding.base === actual(textures.baseColor) && binding.metallicRoughness === actual(textures.metallicRoughness)
    && binding.normal === actual(textures.normal) && binding.occlusion === actual(textures.occlusion)
    && binding.emissive === actual(textures.emissive) && binding.key === materialKey(textures)
    && binding.specular === actual(textures.specular) && binding.specularColor === actual(textures.specularColor)
    && (!textures.layered || textures.layered.parameters.layers.map((layer, index) => ({ layer, index }))
      .filter(value => value.layer.coverage > 0)
      .flatMap(({ index }) => [textures.layered!.textures[index]?.baseColor, textures.layered!.textures[index]?.metallicRoughness])
      .every((slot, index) => binding.layered?.textures[index] === actual(slot)));
}

export function releaseMaterialBinding(session: DeviceSession, binding: MaterialBinding | undefined): void {
  if (binding) {
    if (binding.layered) session.release(binding.layered.uniform);
    if (binding.neutral) session.release(binding.neutral.texture);
    session.release(binding.parameters);
  }
}

function writeTransform(target: Float32Array, offset: number,
  slot: { readonly uvTransform: readonly number[]; readonly texCoord: 0 | 1 } | undefined, enabled: boolean): void {
  const value = slot?.uvTransform ?? [1, 0, 0, 0, 1, 0];
  // 0=disabled, 1=UV0, 2=UV1；复用 enable 标量，保持 40-float 基础块 ABI 与变体数不变。
  target.set([value[0]!, value[1]!, value[2]!, enabled ? (slot?.texCoord ?? 0) + 1 : 0,
    value[3]!, value[4]!, value[5]!, 0], offset);
}

function materialKey(textures: PreparedMaterialTextures): string { return JSON.stringify(textures); }

/** 材质参数块总 float 数（G-1 修复）：与 pbrShader.ts 的 WGSL `MaterialTextures`
 * （12 vec4，1e07cdaf 起含 extended0/extended1）逐位对齐，即 forward PBR 管线对
 * group(1) 材质 uniform 的最小绑定尺寸要求（192B）。Rust 侧基础块为
 * deep-engine-native mesh_abi::MATERIAL_UNIFORM_FLOATS=40，其 160B 块语义等价于
 * 本布局的零填充扩展带（WGSL extendedShade 对全零带回退标准 shade）。 */
export const MATERIAL_PARAMETER_FLOATS = 48;
/** 基础块 float 数：与 Rust mesh_abi::MATERIAL_UNIFORM_FLOATS 及
 * DEEP_PBR_MESH_V1_BYTE_SIZES.material（160B）同源。 */
export const MATERIAL_PARAMETER_CORE_FLOATS = 40;
/** 扩展参数带起始 float 偏移：packExtendedParameterBlock 的 6 float 写入 40..46，
 * 46..48 保持零（WGSL 侧 extended1.zw 未消费）。 */
export const MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET = 40;

/** 导出给纹理数组索引通道复用：192B 材质 ABI 块的唯一打包实现，禁止旁路复制。
 * 恒定输出 48 float——无扩展参数时扩展带零填充（语义=无扩展材质，WGSL 走标准
 * shade 分支），有扩展参数时在偏移 40 写入 6-float 参数块。恒定尺寸同时满足
 * uniform 池（binding 4 最小绑定 192B）与纹理数组共享表行
 * （rowStride 224B = 192B 材质块 + 32B 索引）两条消费路径。 */
export function packMaterialParameters(textures: PreparedMaterialTextures, advancedLayout = false): Float32Array<ArrayBuffer> {
  const data = new Float32Array(advancedLayout ? MATERIAL_PARAMETER_ADVANCED_FLOATS : MATERIAL_PARAMETER_FLOATS);
  writeTransform(data, 0, textures.baseColor, textures.baseColor !== undefined);
  writeTransform(data, 8, textures.metallicRoughness, textures.metallicRoughness !== undefined);
  writeTransform(data, 16, textures.occlusion, textures.occlusion !== undefined);
  data[23] = textures.occlusion?.strength ?? 1;
  writeTransform(data, 24, textures.normal, textures.normal !== undefined);
  data[31] = textures.normal?.normalScale ?? 1;
  writeTransform(data, 32, textures.emissive, textures.emissive !== undefined);
  data[DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.emissiveStrength.floatOffset] = textures.emissiveStrength;
  if (textures.extendedParameters) {
    data.set(packExtendedParameterBlock(textures.extendedParameters), MATERIAL_PARAMETER_EXTENDED_BAND_FLOAT_OFFSET);
  }
  if (advancedLayout && textures.advanced) data.set(packAdvancedParameterBlock(textures.advanced), MATERIAL_PARAMETER_ADVANCED_BAND_FLOAT_OFFSET);
  if (advancedLayout) {
    data.set([...(textures.specularColorFactor ?? [1, 1, 1]), textures.specularFactor ?? 1], MATERIAL_PARAMETER_SPECULAR_FACTOR_FLOAT_OFFSET);
    writeTransform(data, MATERIAL_PARAMETER_SPECULAR_TEXTURE_FLOAT_OFFSET, textures.specular, textures.specular !== undefined);
    writeTransform(data, MATERIAL_PARAMETER_SPECULAR_COLOR_TEXTURE_FLOAT_OFFSET, textures.specularColor, textures.specularColor !== undefined);
  }
  return data;
}

function materialParameterKey(textures: PreparedMaterialTextures, advancedLayout: boolean): string {
  return JSON.stringify(Array.from(packMaterialParameters(textures, advancedLayout)));
}
