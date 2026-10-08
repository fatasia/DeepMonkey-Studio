import type { RenderPacket } from "@bim-studio/deep-engine";

type Texture = NonNullable<RenderPacket["textures"]>[number];
const prepared = new WeakMap<Texture, Texture>();
/** Preserve source pixels and object identity across transform-only scene compilations. */
export function studioTextureMips(texture: Texture): Texture {
  if (texture.compression || texture.mipmaps?.length || texture.generateMipmaps !== undefined
    || texture.width === 1 && texture.height === 1
    || texture.sampler?.minFilter === "nearest" || texture.sampler?.mipmapFilter === "nearest") return texture;
  let result = prepared.get(texture);
  if (!result) {
    result = { ...texture, generateMipmaps: true };
    prepared.set(texture, result);
  }
  return result;
}
