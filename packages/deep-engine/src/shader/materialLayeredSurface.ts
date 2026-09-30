import { normalizeLayeredMaterialParameters, type LayeredMaterialOverrides,
  type LayeredMaterialParameters, type MaterialLayerOverrideInput } from "./materialLayeredParameters.js";
import { packExtendedParameterBlock } from "./materialParameterAbi.js";
import type { StandardSurfaceInputs, Vec3 } from "./materialEvaluate.js";
import type { PreparedTextureSlot, TextureSlot } from "../renderPacketTypes.js";

export interface MaterialLayerSurfaceOverride {
  readonly baseColor?: Vec3;
  readonly metallic?: number;
  readonly roughness?: number;
  readonly baseColorTexture?: TextureSlot;
  readonly metallicRoughnessTexture?: TextureSlot;
}
export type LayeredSurfaceOverrides = Omit<LayeredMaterialOverrides, "layers"> & {
  readonly layers?: readonly (MaterialLayerOverrideInput & { readonly surface?: MaterialLayerSurfaceOverride })[];
};
export interface LayeredSurfaceParameters extends LayeredMaterialParameters {
  readonly surfaces: readonly (MaterialLayerSurfaceOverride | undefined)[];
}
export interface LayeredSurfaceTextureBinding {
  readonly baseColor?: { readonly slot: PreparedTextureSlot; readonly arrayLayer: number };
  readonly metallicRoughness?: { readonly slot: PreparedTextureSlot; readonly arrayLayer: number };
}
/** Separate storage ABI; the existing 22-float scalar schema, 192B material and 224B array row remain intact. */
export const LAYERED_SURFACE_BLOCK_BYTES = 304;
export const LAYERED_SURFACE_ROW_BYTES = 144;
export const LAYERED_SURFACE_ABI_VERSION = 1;
function unit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`Layer surface ${field} must be in 0..1.`);
  return Math.fround(value);
}
function snapshotSlot(slot: TextureSlot | undefined): TextureSlot | undefined {
  if (!slot) return undefined;
  if (typeof slot.texture !== "string" || !slot.texture.length || ![0, 1].includes(slot.texCoord ?? 0)) throw new RangeError("Layer texture identity and UV set are invalid.");
  const vector = (raw: readonly [number, number] | undefined) => {
    if (!raw) return undefined;
    if (raw.length !== 2 || raw.some(value => !Number.isFinite(Math.fround(value)))) throw new RangeError("Layer texture transform must be finite float32.");
    return Object.freeze([Math.fround(raw[0]), Math.fround(raw[1])] as const);
  };
  const offset = vector(slot.offset), scale = vector(slot.scale);
  if (slot.rotation !== undefined && !Number.isFinite(Math.fround(slot.rotation))) throw new RangeError("Layer texture rotation must be finite float32.");
  return Object.freeze({ texture: slot.texture, ...(slot.texCoord === undefined ? {} : { texCoord: slot.texCoord }),
    ...(offset ? { offset } : {}), ...(scale ? { scale } : {}), ...(slot.rotation === undefined ? {} : { rotation: Math.fround(slot.rotation) }) });
}
export function normalizeLayeredSurfaceParameters(input: LayeredSurfaceOverrides): LayeredSurfaceParameters {
  const normalized = normalizeLayeredMaterialParameters(input);
  const surfaces = (input.layers ?? []).map(layer => {
    const surface = layer.surface;
    if (!surface) return undefined;
    const color = surface.baseColor;
    if (color && color.length !== 3) throw new RangeError("Layer surface color must have three channels.");
    const baseColor = color ? Object.freeze(color.map(value => unit(value, "baseColor"))) as Vec3 : undefined;
    const baseColorTexture = snapshotSlot(surface.baseColorTexture), metallicRoughnessTexture = snapshotSlot(surface.metallicRoughnessTexture);
    return Object.freeze({ ...(baseColor ? { baseColor } : {}),
      ...(surface.metallic === undefined ? {} : { metallic: unit(surface.metallic, "metallic") }),
      ...(surface.roughness === undefined ? {} : { roughness: unit(surface.roughness, "roughness") }),
      ...(baseColorTexture ? { baseColorTexture } : {}), ...(metallicRoughnessTexture ? { metallicRoughnessTexture } : {}) });
  });
  return Object.freeze({ ...normalized, surfaces: Object.freeze(surfaces) });
}
export function resolveLayerSurface(base: StandardSurfaceInputs, surface: MaterialLayerSurfaceOverride | undefined): StandardSurfaceInputs {
  if (!surface || (surface.baseColor === undefined && surface.metallic === undefined && surface.roughness === undefined)) return base;
  return { baseColor: surface.baseColor ?? base.baseColor, metallic: surface.metallic ?? base.metallic, roughness: surface.roughness ?? base.roughness };
}
/** Caller resolves existing texture semantic/UV contracts before assigning per-array indices. */
export function packLayeredSurfaceBlock(input: LayeredSurfaceParameters,
  bindings: readonly LayeredSurfaceTextureBinding[] = []): Float32Array<ArrayBuffer> {
  const block = new Float32Array(LAYERED_SURFACE_BLOCK_BYTES / 4), codes = new Uint32Array(block.buffer);
  let activeCount = 0;
  for (let index = 0; index < input.layers.length; index++) {
    const layer = input.layers[index]!; if (layer.coverage === 0) continue;
    const surface = input.surfaces[index], binding = bindings[index], base = 4 + activeCount++ * (LAYERED_SURFACE_ROW_BYTES / 4);
    block.set(packExtendedParameterBlock(layer.params), base);
    block.set([...(surface?.baseColor ?? [1, 1, 1]), layer.coverage], base + 8);
    const flags = Number(surface?.baseColor !== undefined) | (Number(surface?.metallic !== undefined) << 1) | (Number(surface?.roughness !== undefined) << 2);
    block.set([surface?.metallic ?? 0, surface?.roughness ?? 0, layer.mode === "overlay" ? 1 : 0, flags], base + 12);
    for (const [semantic, offset, codeOffset] of [["baseColor", 16, 32], ["metallicRoughness", 24, 33]] as const) {
      const texture = binding?.[semantic], transform = texture?.slot.uvTransform ?? [1, 0, 0, 0, 1, 0];
      if (transform.length !== 6 || transform.some(value => !Number.isFinite(Math.fround(value)))) throw new RangeError("Prepared layer UV transform is invalid.");
      const uv = texture?.slot.texCoord ?? 0, arrayLayer = texture?.arrayLayer ?? 0;
      if (![0, 1].includes(uv) || !Number.isSafeInteger(arrayLayer) || arrayLayer < 0 || arrayLayer > 0xffff_ffff) throw new RangeError("Prepared layer texture array index or UV set is invalid.");
      block.set([transform[0]!, transform[1]!, transform[2]!, texture ? uv + 1 : 0, transform[3]!, transform[4]!, transform[5]!, 0], base + offset);
      codes[base + codeOffset] = arrayLayer;
    }
  }
  codes[0] = activeCount; codes[1] = LAYERED_SURFACE_ABI_VERSION;
  return block;
}
