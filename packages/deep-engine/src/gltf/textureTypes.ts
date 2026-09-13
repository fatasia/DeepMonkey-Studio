import type { DecodedTexture, TextureSampler, TextureSemantic } from "../textures/decodedTexture.js";
import type { Ktx2TranscodePreference, Ktx2Transcoder } from "../textures/ktx2Transcode.js";

export type GltfTextureMimeType = "image/png" | "image/jpeg" | "image/ktx2";

/** 编码图像保持原始 PNG/JPEG/KTX2 字节；此层不隐式 fetch，也不假装已经解码或转码。 */
export interface GltfEncodedImage {
  readonly id: string;
  readonly imageIndex: number;
  readonly mimeType: GltfTextureMimeType;
  readonly data: Uint8Array<ArrayBuffer>;
}

export interface GltfTextureResource {
  readonly id: string;
  readonly textureIndex: number;
  readonly image: string;
  /** Optional core PNG/JPEG source used only when BasisU is not required and no KTX2 transcoder is available. */
  readonly fallbackImage?: string;
  readonly semantic: TextureSemantic;
  readonly sampler: Required<TextureSampler>;
}

export interface GltfTextureSlot {
  readonly texture: string;
  readonly texCoord: 0 | 1;
  readonly offset: readonly [number, number];
  readonly scale: readonly [number, number];
  readonly rotation: number;
}

export interface GltfNormalTextureSlot extends GltfTextureSlot { readonly normalScale: number }
export interface GltfOcclusionTextureSlot extends GltfTextureSlot { readonly strength: number }

export interface GltfTexturedMaterial {
  readonly id: string;
  readonly materialIndex: number;
  readonly baseColorTexture?: GltfTextureSlot;
  readonly metallicRoughnessTexture?: GltfTextureSlot;
  readonly normalTexture?: GltfNormalTextureSlot;
  readonly occlusionTexture?: GltfOcclusionTextureSlot;
  readonly emissiveTexture?: GltfTextureSlot;
  readonly emissiveStrength?: number;
}

export interface GltfPrimitiveUvSet {
  /** 与 RenderPacket GeometryResource.id 相同，便于集成层无猜测地接线。 */
  readonly geometry: string;
  readonly meshIndex: number;
  readonly primitiveIndex: number;
  readonly texCoord: 0 | 1;
  readonly values: Float32Array<ArrayBuffer>;
  /** 仅法线纹理图元读取 TANGENT；缺省时组合层从位置、法线、UV 和索引生成。 */
  readonly tangents?: Float32Array<ArrayBuffer>;
  readonly requiresTangents: boolean;
}

export interface GltfTextureManifest {
  readonly images: readonly GltfEncodedImage[];
  readonly resources: readonly GltfTextureResource[];
  readonly materials: readonly GltfTexturedMaterial[];
  readonly uvSets: readonly GltfPrimitiveUvSet[];
}

export interface GltfDecodedImage {
  readonly width: number;
  readonly height: number;
  /** 顶行在前、未预乘 alpha 的 RGBA8；须忽略文件 ICC/gamma。解码器不得返回共享内存。 */
  readonly data: Uint8Array;
  readonly bytesPerRow?: number;
}

/** 浏览器/原生宿主实现 PNG/JPEG 解码；KTX2 走独立转码器并可产出 GPU 原生块压缩纹理。 */
export interface GltfImageDecoder {
  /** 浏览器实现应使用 colorSpaceConversion:"none"，并在兑现 Promise 前关闭临时 ImageBitmap。 */
  decode(image: GltfEncodedImage, signal?: AbortSignal): Promise<GltfDecodedImage>;
}

export interface GltfTextureDecodeOptions {
  readonly signal?: AbortSignal;
  readonly maxDimension?: number;
  readonly maxBytes?: number;
  readonly maxTextures?: number;
  readonly ktx2?: Readonly<{
    readonly transcoder: Ktx2Transcoder;
    readonly supportedFeatures?: Iterable<"texture-compression-bc" | "texture-compression-etc2" | "texture-compression-astc">;
    readonly preference?: Ktx2TranscodePreference;
  }>;
}

export type GltfDecodedTextures = readonly DecodedTexture[];
