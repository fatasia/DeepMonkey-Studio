import type { Primitive, Texture, TextureInfo } from "@gltf-transform/core";
import type { Transform, EmissiveStrength } from "@gltf-transform/extensions";
import { Vector3 } from "three";

export interface LightmapPixels { width: number; height: number; data: Uint8ClampedArray; }
export type SurfaceSample = (indices: readonly number[], weights: readonly number[], diffuse: Vector3, emission: Vector3) => number;
export async function decodeLightmapTexture(texture: Texture): Promise<LightmapPixels> {
  const image = texture.getImage();
  if (!image) throw new Error("光照烘焙缺少材质贴图像素");
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(image)], { type: texture.getMimeType() }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    if (bitmap.width * bitmap.height > 16 * 1024 * 1024) throw new Error("光照烘焙单张贴图超过 16M 像素预算");
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法读取光照烘焙材质");
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
  } finally { bitmap.close(); }
}

const linear = (value: number) => value <= .04045 ? value / 12.92 : Math.pow((value + .055) / 1.055, 2.4);
function wrapped(index: number, size: number, mode: number): number {
  if (mode === 33071) return Math.max(0, Math.min(size - 1, index));
  if (mode === 33648) { const value = ((index % (2 * size)) + 2 * size) % (2 * size);return value < size ? value : 2 * size - value - 1; }
  return ((index % size) + size) % size;
}
/** 颜色贴图逐 texel 转线性后双线性采样；金属度等数据贴图不做 sRGB 转换。 */
export function sampleLightmapPixels(pixels: LightmapPixels, u: number, v: number, info: TextureInfo, color: boolean, output: number[]): void {
  const x = u * pixels.width - .5, y = v * pixels.height - .5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  output.fill(0);
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const offset = (wrapped(y0 + dy, pixels.height, info.getWrapT()) * pixels.width + wrapped(x0 + dx, pixels.width, info.getWrapS())) * 4;
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    for (let channel = 0; channel < 4; channel++) {
      const value = pixels.data[offset + channel]! / 255;
      output[channel] = output[channel]! + (color && channel < 3 ? linear(value) : value) * weight;
    }
  }
}

export async function createLightmapMaterialSamplers(primitives: Primitive[], decode = decodeLightmapTexture, diffuseEnabled = true): Promise<Map<Primitive, SurfaceSample>> {
  const cache = new Map<Texture, LightmapPixels>();let bytes = 0;
  for (const primitive of primitives) {
    const material = primitive.getMaterial()!;
    for (const texture of [diffuseEnabled ? material.getBaseColorTexture() : null, diffuseEnabled ? material.getMetallicRoughnessTexture() : null, material.getEmissiveTexture()]) {
      if (!texture || cache.has(texture)) continue;
      const pixels = await decode(texture);bytes += pixels.data.byteLength;
      if (pixels.width <= 0 || pixels.height <= 0 || pixels.data.length !== pixels.width * pixels.height * 4 || bytes > 128 * 1024 * 1024) throw new Error("光照烘焙材质像素无效或超过预算");
      cache.set(texture, pixels);
    }
  }
  const result = new Map<Primitive, SurfaceSample>();
  for (const primitive of primitives) {
    const material = primitive.getMaterial()!, base = material.getBaseColorFactor(), emitted = material.getEmissiveFactor();
    const emissionStrength = material.getExtension<EmissiveStrength>("KHR_materials_emissive_strength")?.getEmissiveStrength() ?? 1;
    const scratch = [1, 1, 1, 1], value: number[] = [], color = primitive.getAttribute("COLOR_0");
    const slot = (texture: Texture | null, info: TextureInfo | null, srgb: boolean) => {
      if (!texture || !info) return (_indices: readonly number[], _weights: readonly number[]) => { scratch.fill(1); };
      const transform = info.getExtension<Transform>("KHR_texture_transform");
      const uv = primitive.getAttribute(`TEXCOORD_${transform?.getTexCoord() ?? info.getTexCoord()}`);
      if (!uv) throw new Error("光照烘焙材质缺少声明的纹理坐标");
      const scale = transform?.getScale() ?? [1, 1], offset = transform?.getOffset() ?? [0, 0], rotation = transform?.getRotation() ?? 0;
      return (indices: readonly number[], weights: readonly number[]) => {
        let u = 0, v = 0;
        for (let corner = 0; corner < 3; corner++) { uv.getElement(indices[corner]!, value);u += value[0]! * weights[corner]!;v += value[1]! * weights[corner]!; }
        u *= scale[0]!;v *= scale[1]!;
        sampleLightmapPixels(cache.get(texture)!, u * Math.cos(rotation) - v * Math.sin(rotation) + offset[0]!, u * Math.sin(rotation) + v * Math.cos(rotation) + offset[1]!, info, srgb, scratch);
      };
    };
    const sampleBase = slot(diffuseEnabled ? material.getBaseColorTexture() : null, material.getBaseColorTextureInfo(), true);
    const sampleMetal = slot(diffuseEnabled ? material.getMetallicRoughnessTexture() : null, material.getMetallicRoughnessTextureInfo(), false);
    const sampleEmission = slot(material.getEmissiveTexture(), material.getEmissiveTextureInfo(), true);
    result.set(primitive, (indices, weights, diffuse, emission) => {
      sampleBase(indices, weights);diffuse.set(base[0] * scratch[0]!, base[1] * scratch[1]!, base[2] * scratch[2]!);let alpha = base[3] * scratch[3]!;
      if (color) {
        const vertex = [0, 0, 0, 0];
        for (let corner = 0; corner < 3; corner++) { color.getElement(indices[corner]!, value);for (let channel = 0; channel < 4; channel++) vertex[channel]! += (value[channel] ?? 1) * weights[corner]!; }
        diffuse.multiply(new Vector3(vertex[0], vertex[1], vertex[2]));alpha *= vertex[3]!;
      }
      sampleMetal(indices, weights);diffuse.multiplyScalar(1 - material.getMetallicFactor() * scratch[2]!);
      sampleEmission(indices, weights);emission.set(emitted[0] * scratch[0]!, emitted[1] * scratch[1]!, emitted[2] * scratch[2]!).multiplyScalar(emissionStrength);
      return material.getAlphaMode() === "OPAQUE" ? 1 : material.getAlphaMode() === "MASK" ? Number(alpha >= material.getAlphaCutoff()) : alpha;
    });
  }
  return result;
}
