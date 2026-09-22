import type { RuntimeStaticLightmapDescriptor } from "../runtimePackage/environmentTypes.js";
import type { RuntimeContentHash } from "../runtimePackage/types.js";
import { runtimeContentSha256 } from "../runtimePackage/hash.js";

/** bimStudioLightmap extras 的最小读取合同（与 lightmapBaker 写入字段对齐）。 */
export interface BimStudioLightmapExtras {
  readonly mode: string;
  readonly texCoord: number;
  readonly resolution: number;
  readonly shadows?: boolean;
  readonly ambientOcclusion?: boolean;
  readonly denoise?: boolean;
  readonly colored?: boolean;
  readonly preservesBaseColor?: boolean;
  readonly uvAtlas?: string;
}

export interface StaticLightmapSourceTexture {
  readonly id: string;
  readonly semantic: "occlusion" | "emissive";
  readonly width: number;
  readonly height: number;
  /** 与运行包 snapshot 相同的字节数组表示；hash 基于它计算。 */
  readonly data: readonly number[];
}

export interface StaticLightmapDescriptorInput {
  readonly extras: BimStudioLightmapExtras;
  readonly texture: StaticLightmapSourceTexture;
  readonly colorSpace?: "linear" | "srgb";
  readonly intensity?: number;
}

export type StaticLightmapDescriptorError =
  | "unsupported-mode"
  | "unsupported-semantic"
  | "invalid-texcoord"
  | "invalid-resolution"
  | "missing-texture-data";

/**
 * B6 桥接：把 lightmapBaker 写入 glTF 材质的 bimStudioLightmap 元数据与烘焙纹理资源
 * 转换为运行包 `RuntimeStaticLightmapDescriptor`。不做 IO、不生成贴图；hash 基于与
 * 运行包一致的 texture snapshot 表示，保证 descriptor 与包内资源逐字节可对账。
 */
export function staticLightmapDescriptorFromExtras(input: StaticLightmapDescriptorInput):
  RuntimeStaticLightmapDescriptor {
  const { extras, texture } = input;
  if (extras.mode !== "occlusion+chroma-emissive") throw new Error(`unsupported-mode: ${extras.mode}`);
  if (texture.semantic !== "occlusion" && texture.semantic !== "emissive") {
    throw new Error(`unsupported-semantic: ${texture.semantic}`);
  }
  if (extras.texCoord !== 0 && extras.texCoord !== 1) throw new Error(`invalid-texcoord: ${extras.texCoord}`);
  if (texture.width !== extras.resolution || texture.height !== extras.resolution) {
    throw new Error(`invalid-resolution: texture ${texture.width}x${texture.height} != extras ${extras.resolution}`);
  }
  if (!Array.isArray(texture.data) || texture.data.length === 0) throw new Error("missing-texture-data");

  const textureSnapshot = { id: texture.id, revision: 1, semantic: texture.semantic,
    width: texture.width, height: texture.height, data: [...texture.data] };
  const textureHash: RuntimeContentHash = { algorithm: "sha256",
    value: runtimeContentSha256(textureSnapshot) };
  const uvSet: 0 | 1 = extras.texCoord === 0 ? 0 : 1;
  const colorSpace = input.colorSpace ?? "linear";
  const intensity = input.intensity ?? 1;
  return Object.freeze({
    schema: "deep-engine.static-lightmap", schemaVersion: 1,
    textureId: texture.id, textureHash, uvSet, colorSpace, intensity,
    width: texture.width, height: texture.height,
  });
}
