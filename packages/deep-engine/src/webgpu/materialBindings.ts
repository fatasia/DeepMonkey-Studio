import type { PreparedMaterialTextures } from "../renderPacket.js";
import { DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS } from "../shaderAbi/contract.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import type { TextureBinding } from "./textureResources.js";

export interface MaterialBinding {
  readonly group: GPUBindGroup;
  readonly parameters: GPUBuffer;
  readonly base?: TextureBinding;
  readonly metallicRoughness?: TextureBinding;
  readonly normal?: TextureBinding;
  readonly occlusion?: TextureBinding;
  readonly emissive?: TextureBinding;
  readonly key: string;
}

export interface MaterialLayouts { readonly material: GPUBindGroupLayout }

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
      parameterBytes: this.parameters.size * 40 * Float32Array.BYTES_PER_ELEMENT,
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
    const parameterKey = materialParameterKey(textures);
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
    this.releaseParameters(entry.parameterKey);
  }

  private poolKey(textures: PreparedMaterialTextures, lookup: (id: string) => TextureBinding): string {
    const slots = [textures.baseColor, textures.metallicRoughness, textures.normal,
      textures.occlusion, textures.emissive];
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
    const buffer = uploadBuffer(this.session, "Deep material parameter pool", packMaterialParameters(textures), GPUBufferUsage.UNIFORM);
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
  const fallbackSlot = textures.baseColor ?? textures.metallicRoughness ?? textures.normal ?? textures.occlusion ?? textures.emissive!;
  const fallback = lookup(fallbackSlot.texture);
  const base = textures.baseColor ? lookup(textures.baseColor.texture) : undefined;
  const metallicRoughness = textures.metallicRoughness ? lookup(textures.metallicRoughness.texture) : undefined;
  const normal = textures.normal ? lookup(textures.normal.texture) : undefined;
  const occlusion = textures.occlusion ? lookup(textures.occlusion.texture) : undefined;
  const emissive = textures.emissive ? lookup(textures.emissive.texture) : undefined;
  const parameters = pooledParameters
    ?? uploadBuffer(session, "Deep material textures", packMaterialParameters(textures), GPUBufferUsage.UNIFORM);
  try {
    const actual = (binding: TextureBinding | undefined) => binding ?? fallback;
    const b = actual(base), mr = actual(metallicRoughness), ao = actual(occlusion), n = actual(normal), e = actual(emissive);
    const group = session.device.createBindGroup({ label: "Deep material textures", layout: layouts.material, entries: [
      { binding: 0, resource: b.view }, { binding: 1, resource: b.sampler },
      { binding: 2, resource: mr.view }, { binding: 3, resource: mr.sampler },
      { binding: 4, resource: { buffer: parameters } },
      { binding: 5, resource: ao.view }, { binding: 6, resource: ao.sampler },
      { binding: 7, resource: n.view }, { binding: 8, resource: n.sampler },
      { binding: 9, resource: e.view }, { binding: 10, resource: e.sampler },
    ] });
    return { group, parameters, ...(base ? { base } : {}), ...(metallicRoughness ? { metallicRoughness } : {}),
      ...(normal ? { normal } : {}), ...(occlusion ? { occlusion } : {}), ...(emissive ? { emissive } : {}), key: materialKey(textures) };
  } catch (error) { if (!pooledParameters) session.release(parameters); throw error; }
}

export function materialBindingMatches(binding: MaterialBinding | undefined, textures: PreparedMaterialTextures | undefined,
  lookup: (id: string) => TextureBinding): boolean {
  if (!textures) return binding === undefined;
  if (!binding) return false;
  const actual = (slot: { readonly texture: string } | undefined) => slot ? lookup(slot.texture) : undefined;
  return binding.base === actual(textures.baseColor) && binding.metallicRoughness === actual(textures.metallicRoughness)
    && binding.normal === actual(textures.normal) && binding.occlusion === actual(textures.occlusion)
    && binding.emissive === actual(textures.emissive) && binding.key === materialKey(textures);
}

export function releaseMaterialBinding(session: DeviceSession, binding: MaterialBinding | undefined): void {
  if (binding) session.release(binding.parameters);
}

function writeTransform(target: Float32Array, offset: number,
  slot: { readonly uvTransform: readonly number[]; readonly texCoord: 0 | 1 } | undefined, enabled: boolean): void {
  const value = slot?.uvTransform ?? [1, 0, 0, 0, 1, 0];
  // 0=disabled, 1=UV0, 2=UV1；复用 enable 标量，保持 40-float 材质 ABI 与变体数不变。
  target.set([value[0]!, value[1]!, value[2]!, enabled ? (slot?.texCoord ?? 0) + 1 : 0,
    value[3]!, value[4]!, value[5]!, 0], offset);
}

function materialKey(textures: PreparedMaterialTextures): string { return JSON.stringify(textures); }

/** 导出给纹理数组索引通道复用：160B 材质 ABI 块的唯一打包实现，禁止旁路复制。 */
export function packMaterialParameters(textures: PreparedMaterialTextures): Float32Array<ArrayBuffer> {
  const data = new Float32Array(40);
  writeTransform(data, 0, textures.baseColor, textures.baseColor !== undefined);
  writeTransform(data, 8, textures.metallicRoughness, textures.metallicRoughness !== undefined);
  writeTransform(data, 16, textures.occlusion, textures.occlusion !== undefined);
  data[23] = textures.occlusion?.strength ?? 1;
  writeTransform(data, 24, textures.normal, textures.normal !== undefined);
  data[31] = textures.normal?.normalScale ?? 1;
  writeTransform(data, 32, textures.emissive, textures.emissive !== undefined);
  data[DEEP_PBR_MESH_V1_MATERIAL_PARAMETER_SEMANTICS.emissiveStrength.floatOffset] = textures.emissiveStrength;
  return data;
}

function materialParameterKey(textures: PreparedMaterialTextures): string {
  return JSON.stringify(Array.from(packMaterialParameters(textures)));
}
