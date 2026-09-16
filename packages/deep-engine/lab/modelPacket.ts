import { decodeGlb, decodeTexturedGlb } from "@bim-studio/deep-engine/gltf";
import type { RenderPacket } from "@bim-studio/deep-engine/webgpu";
import { browserImageDecoder } from "./browserImageDecoder.js";

export type ModelName = "Box" | "BoxInterleaved" | "BoxTextured" | "NormalTangentTest" | "TextureEncodingTest" | "TextureTransformMultiTest" | "AlphaBlendModeTest" | "MaterialModes" | "UvSets";
const decoded = new Map<ModelName, RenderPacket>();

export async function loadModelPacket(name: ModelName, count: number, signal?: AbortSignal): Promise<RenderPacket> {
  let source = decoded.get(name);
  if (!source) {
    const asset = name === "MaterialModes" || name === "UvSets" ? "BoxTextured" : name;
    const response = await fetch(`/assets/${asset}.glb`, signal ? { signal } : {});
    if (!response.ok) throw new Error(`模型加载失败 (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const optionalMaterialFallbacks = asset === "TextureTransformMultiTest"
      ? ["KHR_materials_clearcoat", "KHR_materials_unlit"] as const
      : undefined;
    source = asset === "BoxTextured" || asset === "NormalTangentTest" || asset === "TextureEncodingTest" || asset === "TextureTransformMultiTest" || asset === "AlphaBlendModeTest"
      ? await decodeTexturedGlb(bytes, browserImageDecoder, {
        resourcePrefix: name,
        ...(optionalMaterialFallbacks ? { optionalMaterialFallbacks } : {}),
        ...(signal ? { signal } : {}),
      })
      : decodeGlb(bytes, { resourcePrefix: name });
    if (name === "MaterialModes") source = materialModesPacket(source);
    if (name === "UvSets") source = uvSetsPacket(source);
    decoded.set(name, source);
  }
  if (signal?.aborted) throw new DOMException("Model load cancelled", "AbortError");
  return placeModelCopies(source, count);
}

/** 自有 UV1 合同样本：baseColor 保持 UV0，棋盘 AO 独立使用旋转后的 UV1。 */
export function uvSetsPacket(source: RenderPacket): RenderPacket {
  const texture = source.textures?.find(value => value.semantic === "baseColor");
  if (!texture || !source.materials.length) throw new Error("UV 集合同样本缺少基准纹理或材质。");
  const data = new Uint8Array(texture.data.length);
  for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
    const pixel = (y * texture.width + x) * 4;
    const checker = (Math.floor(x / Math.max(1, texture.width / 6)) + Math.floor(y / Math.max(1, texture.height / 6))) % 2;
    data.set(checker ? [255, 255, 255, 255] : [38, 38, 38, 255], pixel);
  }
  return {
    geometries: source.geometries.map(geometry => {
      if (!geometry.uv0) return geometry;
      const uv1 = new Float32Array(geometry.uv0.length);
      for (let index = 0; index < geometry.uv0.length; index += 2) {
        uv1[index] = geometry.uv0[index + 1]!;
        uv1[index + 1] = 1 - geometry.uv0[index]!;
      }
      return { ...geometry, uv1 };
    }),
    textures: [...source.textures!, { ...texture, id: "UvSets/ao", semantic: "occlusion", data }],
    materials: source.materials.map(material => ({ ...material,
      occlusionTexture: { texture: "UvSets/ao", texCoord: 1, strength: 0.82 } })),
    instances: source.instances,
  };
}

/** 自有最小材质状态样本；真实 TextureEncodingTest 现在单独验证颜色空间与缺失法线。 */
export function materialModesPacket(source: RenderPacket): RenderPacket {
  const texture = source.textures?.find(value => value.semantic === "baseColor");
  const instance = source.instances[0];
  if (!texture || !instance) throw new Error("材质合同样本缺少基准纹理或实例。");
  const emissivePixels = texture.data.slice(), alphaPixels = texture.data.slice();
  for (let pixel = 0; pixel < alphaPixels.length; pixel += 4) {
    const x = pixel / 4 % texture.width;
    alphaPixels[pixel + 3] = Math.round(x / Math.max(1, texture.width - 1) * 255);
  }
  const transform = (x: number) => {
    const matrix = Array.from(instance.transform); matrix[12]! += x; return matrix;
  };
  return {
    geometries: source.geometries,
    textures: [
      { ...texture, id: "MaterialModes/emissive", semantic: "emissive", data: emissivePixels },
      { ...texture, id: "MaterialModes/alpha", semantic: "baseColor", data: alphaPixels },
    ],
    materials: [
      { id: "MaterialModes/emissive", baseColor: [0.01, 0.01, 0.01], metallic: 0, roughness: 0.65,
        emissiveFactor: [1, 0.45, 0.12], emissiveTexture: { texture: "MaterialModes/emissive" } },
      { id: "MaterialModes/mask", baseColor: [0.2, 0.85, 0.95], metallic: 0, roughness: 0.55,
        baseColorAlpha: 1, alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true,
        baseColorTexture: { texture: "MaterialModes/alpha" } },
      { id: "MaterialModes/blend", baseColor: [0.95, 0.35, 0.18], metallic: 0, roughness: 0.4,
        baseColorAlpha: 0.42, alphaMode: "BLEND", doubleSided: true,
        baseColorTexture: { texture: "MaterialModes/alpha" } },
    ],
    instances: [
      { ...instance, id: "MaterialModes/emissive", material: "MaterialModes/emissive", transform: transform(-1.8) },
      { ...instance, id: "MaterialModes/mask", material: "MaterialModes/mask", transform: transform(0) },
      { ...instance, id: "MaterialModes/blend", material: "MaterialModes/blend", transform: transform(1.8) },
    ],
  };
}

/** 仅为展示做统一缩放与落地，保留源模型层级变换和材质，不改源文件。 */
function placeModelCopies(source: RenderPacket, count: number): RenderPacket {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const geometry = new Map(source.geometries.map(value => [value.id, value]));
  for (const instance of source.instances) {
    const m = instance.transform, vertices = geometry.get(instance.geometry)!.vertices;
    for (let i = 0; i < vertices.length; i += 6) for (let axis = 0; axis < 3; axis++) {
      const p = m[axis]! * vertices[i]! + m[4 + axis]! * vertices[i + 1]! + m[8 + axis]! * vertices[i + 2]! + m[12 + axis]!;
      min[axis] = Math.min(min[axis]!, p); max[axis] = Math.max(max[axis]!, p);
    }
  }
  const size = Math.max(...max.map((value, axis) => value - min[axis]!));
  if (!Number.isFinite(size) || size <= 0) throw new Error("模型没有可显示的非零包围盒。");
  const scale = 1.5 / size, side = Math.ceil(Math.sqrt(count));
  const center = [(min[0]! + max[0]!) / 2, min[1]!, (min[2]! + max[2]!) / 2];
  return { geometries: source.geometries, materials: source.materials, ...(source.textures ? { textures: source.textures } : {}),
    instances: Array.from({ length: count }, (_, copy) => source.instances.map(instance => {
      const m = Array.from(instance.transform);
      for (let column = 0; column < 4; column++) for (let axis = 0; axis < 3; axis++) m[column * 4 + axis]! *= scale;
      for (let axis = 0; axis < 3; axis++) m[12 + axis]! -= center[axis]! * scale;
      m[12]! += (copy % side - (side - 1) / 2) * 2.4;
      m[14]! += (Math.floor(copy / side) - (side - 1) / 2) * 2.4;
      return { ...instance, id: `${copy}/${instance.id}`, transform: m };
    })).flat() };
}
