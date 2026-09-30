import type { PreparedMaterialTextures } from "../renderPacketTypes.js";
import { LAYERED_SURFACE_BLOCK_BYTES, packLayeredSurfaceBlock } from "../shader/materialLayeredSurface.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { createAdmittedTexture } from "./resourceAdmission.js";
import type { TextureBinding } from "./textureResources.js";

export const LAYERED_MATERIAL_UNIFORM_BINDING = 13;
export const LAYERED_MATERIAL_REQUIRED_TEXTURES = 19;
export interface LayeredMaterialBinding {
  readonly uniform: GPUBuffer;
  readonly textures: readonly (TextureBinding | undefined)[];
  readonly entries: readonly GPUBindGroupEntry[];
}
export function layeredMaterialLayoutEntries(): GPUBindGroupLayoutEntry[] {
  return [{ binding: LAYERED_MATERIAL_UNIFORM_BINDING, visibility: GPUShaderStage.FRAGMENT,
    buffer: { type: "uniform", minBindingSize: LAYERED_SURFACE_BLOCK_BYTES } },
    ...Array.from({ length: 4 }, (_, index) => [
      { binding: 14 + index * 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 15 + index * 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ]).flat()];
}
/** All layer maps borrow the packet's existing texture allocations and samplers. */
export function createLayeredMaterialBinding(session: DeviceSession, textures: PreparedMaterialTextures,
  lookup: (id: string) => TextureBinding, fallback: TextureBinding): LayeredMaterialBinding {
  const source = textures.layered;
  const active = source?.parameters.layers.map((layer, index) => ({ layer, index })).filter(value => value.layer.coverage > 0) ?? [];
  const bindings = active.flatMap(({ index }) => {
    const slot = source!.textures[index];
    return [slot?.baseColor ? lookup(slot.baseColor.texture) : undefined,
      slot?.metallicRoughness ? lookup(slot.metallicRoughness.texture) : undefined];
  });
  while (bindings.length < 4) bindings.push(undefined);
  const packed = source ? packLayeredSurfaceBlock(source.parameters, source.textures.map(layer => ({
    ...(layer.baseColor ? { baseColor: { slot: layer.baseColor, arrayLayer: 0 } } : {}),
    ...(layer.metallicRoughness ? { metallicRoughness: { slot: layer.metallicRoughness, arrayLayer: 0 } } : {}),
  }))) : new Float32Array(LAYERED_SURFACE_BLOCK_BYTES / 4);
  const uniform = uploadBuffer(session, "Deep layered material 304B", packed, GPUBufferUsage.UNIFORM);
  const entries: GPUBindGroupEntry[] = [{ binding: LAYERED_MATERIAL_UNIFORM_BINDING, resource: { buffer: uniform } }];
  bindings.forEach((texture, index) => {
    entries.push({ binding: 14 + index * 2, resource: (texture ?? fallback).view },
      { binding: 15 + index * 2, resource: (texture ?? fallback).sampler });
  });
  return { uniform, textures: bindings, entries };
}
/** Only untextured layered materials need a neutral borrowed-slot backing texture. */
export function createLayeredNeutralTexture(session: DeviceSession): TextureBinding {
  const texture = createAdmittedTexture(session, { label: "Deep untextured layered neutral", size: [1, 1],
    format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  try {
    session.device.queue.writeTexture({ texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    return { texture, view: texture.createView(), sampler: session.device.createSampler(), format: "rgba8unorm",
      width: 1, height: 1, mipLevelCount: 1 };
  } catch (error) { session.release(texture); throw error; }
}
