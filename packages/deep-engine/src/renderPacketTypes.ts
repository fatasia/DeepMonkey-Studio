import type { DecodedTexture, PreparedTexture } from "./textures/decodedTexture.js";
import type { DeformationPose, DeformationSnapshot } from "./deformation/types.js";

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
  /** 线性 RGBA 顶点色，与顶点一一对应；三维颜色源的 alpha 固定为 1。缺省流表示几何无顶点色。 */
  readonly colors?: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
}

export interface PbrMaterial {
  /** Omitted uses PBR; unlit renders base color without scene lighting or shadows. */
  readonly shadingModel?: "unlit";
  readonly id: string;
  readonly baseColor: readonly [number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  /** Dielectric IOR, finite float32 >= 1; omitted = 1.5. Requires material instance ABI v5 when non-default. */
  readonly ior?: number;
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
  /** baseColor alpha factor，OPAQUE 会忽略覆盖率，MASK/BLEND 使用它；BLEND 下 0 表示完全不可见但合法。 */
  readonly baseColorAlpha?: number;
  readonly alphaMode?: AlphaMode;
  /** MASK 默认 0.5；BLEND/OPAQUE 中保留但不参与覆盖率（仅阴影 mask）。与 MASK/BLEND 互斥由单值 alphaMode 保证。 */
  readonly alphaCutoff?: number;
  /** true 时关闭背面剔除，并在背面光照前翻转法线。 */
  readonly doubleSided?: boolean;
  /**
   * DE26/C03 透明语义：true 表示 baseColor 与 baseColorTexture 的 RGB 已按 alpha 预乘。
   * 仅 alphaMode=BLEND 合法；缺省 false 即 straight。Web 端由 weighted OIT premultiplied
   * 累积分支承接，Native 端切换 premultiplied blend 因子（RGB one）。
   */
  readonly premultipliedAlpha?: boolean;
  /** Omitted enables scene fog; false sets existing instance material flag bit 32. */
  readonly fog?: boolean;
}

/** Ordered from finest to coarsest; the final threshold must be zero. */
export interface RenderLodLevel {
  readonly geometry: string;
  readonly minProjectedDiameterPixels: number;
  readonly geometricError: number;
  /** Omitted levels are resident. At least one level must remain resident. */
  readonly resident?: boolean;
}

export interface RenderScreenSpaceLodProfile {
  readonly strategy?: "screen-space";
  readonly levels: readonly RenderLodLevel[];
  readonly hysteresisRatio?: number;
}
export interface RenderAuthorLodLevel {
  readonly geometry: string;
  /** Author metadata only; the renderer consumes selectedLevels without reselecting. */
  readonly distance: number;
  readonly hysteresis: number;
}
export interface RenderAuthorSelectedLodProfile {
  readonly strategy: "author-selected";
  readonly revision: number;
  readonly levels: readonly RenderAuthorLodLevel[];
  readonly selectedLevels: readonly number[];
}
export type RenderLodProfile = RenderScreenSpaceLodProfile | RenderAuthorSelectedLodProfile;

export interface RenderInstance {
  /** Pose identity separates draw batches even when geometry/material are shared. */
  readonly pose?: string;
  readonly id: string;
  readonly geometry: string;
  readonly material: string;
  readonly transform: ArrayLike<number>;
  readonly lod?: RenderLodProfile;
  /** Omitted keeps the legacy all-casters policy. Native readers must explicitly support these fields. */
  readonly castShadow?: boolean;
  /** Omitted receives shadows; false is encoded in existing material flags bit 16. */
  readonly receiveShadow?: boolean;
  /** Object-level screen-space outline; encoded in instance flags bit 256. */
  readonly outline?: boolean;
}

/** 节点级拾取映射：作者场景对象(modelId) → 包内 RenderInstance.id 集合(不含不可见对象)。 */
export interface RenderObjectBinding {
  readonly nodeId: string;
  readonly instanceIds: readonly string[];
}

/** 作者状态的渲染投影，不持有脚本、对象行为或另一套可编辑场景。 */
export interface RenderPacket {
  readonly deformation?: DeformationSnapshot;
  readonly geometries: readonly GeometryResource[];
  readonly materials: readonly PbrMaterial[];
  readonly instances: readonly RenderInstance[];
  readonly textures?: readonly DecodedTexture[];
  /**
   * 节点级拾取映射，编译器写入；仅存在于内存/作者面 RenderPacket——序列化进运行包时
   * builder 会把它提升到包顶层并从 render-packet payload 剥离(Native 契约拒绝未知字段)。
   */
  readonly objectBindings?: readonly RenderObjectBinding[];
}

/** 仅引用当前驻留几何，用于动画/脚本更新；几何内容变化仍使用完整 RenderPacket。 */
export type InstanceUpdate = Pick<RenderPacket, "materials" | "instances"> & {
  /** Complete current pose list; required when any updated instance references a pose. */
  readonly poses?: readonly DeformationPose[];
};

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
  /** Offline bake range in the shared meshlet table; absent for author-only packets. */
  readonly meshletOffset?: number;
  readonly meshletCount?: number;
}

export interface PreparedScreenSpaceLodProfile {
  readonly strategy?: "screen-space";
  readonly levels: readonly PreparedLodLevel[];
  readonly hysteresisRatio: number;
}
export interface PreparedAuthorSelectedLodProfile {
  readonly strategy: "author-selected";
  readonly revision: number;
  readonly levels: readonly (RenderAuthorLodLevel & { readonly triangles: number; readonly resident: true })[];
  readonly selectedLevels: readonly number[];
}
export type PreparedLodProfile = PreparedScreenSpaceLodProfile | PreparedAuthorSelectedLodProfile;

export interface PreparedBatch {
  readonly pose?: string;
  readonly key: string;
  readonly geometry: string;
  /** 与 packed data 的实例行一一对应，用于跨更新保留对象级运动历史。 */
  readonly instanceIds: readonly string[];
  readonly mirrored: boolean;
  readonly doubleSided: boolean;
  readonly alphaMode: AlphaMode;
  /** Explicit BLEND cutout threshold, when authored; undefined means solid BLEND shadow. */
  readonly alphaCutoff?: number;
  /** BLEND 材质声明 premultipliedAlpha 时的批次显式标记；缺省为 straight。 */
  readonly premultipliedAlpha?: boolean;
  readonly castShadow?: boolean;
  /** 旧透明排序桥接可选中心；默认 weighted OIT 会合并兼容批次且不生成该字段。 */
  readonly sortCenter?: readonly [number, number, number];
  readonly data: Float32Array<ArrayBuffer>;
  readonly count: number;
  readonly textures?: PreparedMaterialTextures;
  readonly lod?: PreparedLodProfile;
}

export interface PreparedPacket {
  readonly deformation?: DeformationSnapshot;
  readonly geometries: ReadonlyMap<string, GeometryResource>;
  readonly textures: readonly PreparedTexture[];
  readonly batches: readonly PreparedBatch[];
}

export interface GeometryFeatures {
  readonly uv0: boolean;
  readonly uv1: boolean;
  readonly tangents: boolean;
  /** 顶点颜色流存在性；渲染管线用它选择颜色变体，与材质的顶点色请求一一对应。 */
  readonly colors: boolean;
  /** Required when an instance declares a multi-geometry LOD profile. */
  readonly triangles?: number;
  readonly center?: readonly [number, number, number];
}
