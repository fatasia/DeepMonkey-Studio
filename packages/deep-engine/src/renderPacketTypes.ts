import type { DecodedTexture, PreparedTexture } from "./textures/decodedTexture.js";

export interface TextureSlot {
  readonly texture: string;
  /** glTF/Three 的第一或第二套纹理坐标；缺省为 0。 */
  readonly texCoord?: 0 | 1;
  readonly offset?: readonly [number, number];
  readonly scale?: readonly [number, number];
  readonly rotation?: number;
}

export interface NormalTextureSlot extends TextureSlot { readonly normalScale?: number }
export interface OcclusionTextureSlot extends TextureSlot { readonly strength?: number }
export type AlphaMode = "OPAQUE" | "MASK" | "BLEND";

export interface GeometryResource {
  readonly id: string;
  /** 同一 ID 的内容变化必须递增版本；上传后不依赖作者数组的生命周期。 */
  readonly revision: number;
  /** 位置 xyz + 法线 xyz，索引为逆时针三角形。 */
  readonly vertices: Float32Array<ArrayBuffer>;
  /** 第一套纹理坐标 uv；提供时必须与顶点一一对应。 */
  readonly uv0?: Float32Array<ArrayBuffer>;
  /** 第二套纹理坐标 uv；各纹理槽可独立选择，绝不回退到 UV0。 */
  readonly uv1?: Float32Array<ArrayBuffer>;
  /** 切线 xyz + 手性 w。xyz 为单位切向量，w 只能为 -1/+1；bitangent = cross(normal, tangent) * w。 */
  readonly tangents?: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

export interface PbrMaterial {
  readonly id: string;
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly baseColorTexture?: TextureSlot;
  readonly metallicRoughnessTexture?: TextureSlot;
  /** 没有切线/TBN 时会明确拒绝，不能退化成错误的物体空间法线。 */
  readonly normalTexture?: NormalTextureSlot;
  /** 线性 R 通道，只衰减间接光；strength 默认 1。 */
  readonly occlusionTexture?: OcclusionTextureSlot;
  /** 线性 emissive factor；纹理以 sRGB 采样，在线性 HDR tone mapping 前相乘叠加。 */
  readonly emissiveFactor?: readonly [number, number, number];
  /** KHR_materials_emissive_strength 线性增益；默认 1，范围 0..256。 */
  readonly emissiveStrength?: number;
  readonly emissiveTexture?: TextureSlot;
  /** baseColor alpha factor，OPAQUE 会忽略覆盖率，MASK/BLEND 使用它。 */
  readonly baseColorAlpha?: number;
  readonly alphaMode?: AlphaMode;
  /** MASK 默认 0.5；BLEND/OPAQUE 中保留但不参与覆盖率。 */
  readonly alphaCutoff?: number;
  /** true 时关闭背面剔除，并在背面光照前翻转法线。 */
  readonly doubleSided?: boolean;
}

/** Ordered from finest to coarsest; the final threshold must be zero. */
export interface RenderLodLevel {
  readonly geometry: string;
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  /** Omitted levels are resident. At least one level must remain resident. */
  readonly resident?: boolean;
}

export interface RenderLodProfile {
  readonly levels: readonly RenderLodLevel[];
  readonly hysteresisRatio?: number;
}

export interface RenderInstance {
  readonly id: string;
  readonly geometry: string;
  readonly material: string;
  readonly transform: ArrayLike<number>;
  readonly lod?: RenderLodProfile;
}

/** 作者状态的渲染投影，不持有脚本、对象行为或另一套可编辑场景。 */
export interface RenderPacket {
  readonly geometries: readonly GeometryResource[];
  readonly materials: readonly PbrMaterial[];
  readonly instances: readonly RenderInstance[];
  readonly textures?: readonly DecodedTexture[];
}

/** 仅引用当前驻留几何，用于动画/脚本更新；几何内容变化仍使用完整 RenderPacket。 */
export type InstanceUpdate = Pick<RenderPacket, "materials" | "instances">;

export interface PreparedTextureSlot {
  readonly texture: string;
  readonly texCoord: 0 | 1;
  /** 两行仿射矩阵：[m00,m01,tx,m10,m11,ty]。 */
  readonly uvTransform: readonly [number, number, number, number, number, number];
}

export interface PreparedMaterialTextures {
  /** 固定 material uniform 的 emissiveRow1.w；存在任意材质纹理时统一携带。 */
  readonly emissiveStrength: number;
  readonly baseColor?: PreparedTextureSlot;
  readonly metallicRoughness?: PreparedTextureSlot;
  readonly normal?: PreparedTextureSlot & { readonly normalScale: number };
  readonly occlusion?: PreparedTextureSlot & { readonly strength: number };
  readonly emissive?: PreparedTextureSlot;
}

export interface PreparedLodLevel {
  readonly geometry: string;
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  readonly triangles: number;
  readonly resident: boolean;
}

export interface PreparedLodProfile {
  readonly levels: readonly PreparedLodLevel[];
  readonly hysteresisRatio: number;
}

export interface PreparedBatch {
  readonly key: string;
  readonly geometry: string;
  /** 与 packed data 的实例行一一对应，用于跨更新保留对象级运动历史。 */
  readonly instanceIds: readonly string[];
  readonly mirrored: boolean;
  readonly doubleSided: boolean;
  readonly alphaMode: AlphaMode;
  /** 旧透明排序桥接可选中心；默认 weighted OIT 会合并兼容批次且不生成该字段。 */
  readonly sortCenter?: readonly [number, number, number];
  readonly data: Float32Array<ArrayBuffer>;
  readonly count: number;
  readonly textures?: PreparedMaterialTextures;
  readonly lod?: PreparedLodProfile;
}

export interface PreparedPacket {
  readonly geometries: ReadonlyMap<string, GeometryResource>;
  readonly textures: readonly PreparedTexture[];
  readonly batches: readonly PreparedBatch[];
}

export interface GeometryFeatures {
  readonly uv0: boolean;
  readonly uv1: boolean;
  readonly tangents: boolean;
  /** Required when an instance declares a multi-geometry LOD profile. */
  readonly triangles?: number;
  readonly center?: readonly [number, number, number];
}
