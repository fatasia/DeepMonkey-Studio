import type { RuntimeContentHash } from "./types.js";

export const RUNTIME_IBL_MAX_BYTES = 64 * 1024 * 1024;
/** B6 静态光照贴图描述符：只描述已由 glTF/资产包提供的纹理，不负责生成贴图。 */
export interface RuntimeStaticLightmapDescriptor {
  readonly schema: "deep-engine.static-lightmap";
  readonly schemaVersion: 1;
  readonly textureId: string;
  readonly textureHash: RuntimeContentHash;
  readonly uvSet: 0 | 1;
  readonly colorSpace: "linear" | "srgb";
  readonly intensity: number;
  readonly width: number;
  readonly height: number;
}
/** F3 探针网格载荷：与 Native probe_gi_grid 网格头/记录合同一致（单层）。 */
export interface RuntimeIrradianceProbeGrid {
  readonly schema: "deep-engine.probe-grid";
  readonly schemaVersion: 1;
  readonly origin: readonly [number, number, number];
  readonly spacing: number;
  readonly gridSize: readonly [number, number, number];
  readonly probes: readonly RuntimeIrradianceProbe[];
}
export interface RuntimeIrradianceProbe {
  readonly irradiance: readonly [number, number, number];
  readonly validity: number;
  readonly meanDistance: number;
  readonly distanceVariance: number;
  readonly occlusionFloor?: number;
  readonly positionOffset?: readonly [number, number, number];
}
/** 固定输出变换的纯色背景；不携带直射灯或全局照明状态。 */
export interface RuntimeSolidEnvironment {
  readonly schema: "deep-engine.solid-environment";
  readonly schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly id: "scene.environment";
  readonly revision: 1;
  readonly kind: "solid-background-no-ibl" | "solid-background-prefiltered-ibl" | "solid-background-builtin-ibl";
  readonly ibl?: RuntimePrefilteredIbl;
  readonly backgroundSrgb: readonly [number, number, number];
  readonly outputTransform: "native-aces-v1" | "native-aces-light-v2" | "native-aces-lights-v3" | "native-aces-spot-shadows-v4" | "native-aces-local-shadows-v5" | "native-aces-hdr-v6" | "native-aces-fog-v7" | "native-aces-studio-v8";
  readonly lighting?: RuntimeAuthoredLighting;
  /** B6 静态贴图描述符；缺失时表示没有烘焙光照，不应推断为黑色贴图。 */
  readonly staticLightmap?: RuntimeStaticLightmapDescriptor;
  /** F3 探针网格：缺失表示无探针 GI，不得推断为全黑环境补偿。 */
  readonly irradianceProbes?: RuntimeIrradianceProbeGrid;
  /** v7 作者雾：与 Web PbrFog exp2 变体同语义（线性 RGB、符号相机深度、透明混合前合成）。 */
  readonly fog?: RuntimeAuthorFog;
}
/** 版本化作者雾 v1：密度≥0，颜色为线性 RGB；不含高度衰减（Web 天气雾无此维度）。 */
export interface RuntimeAuthorFog {
  readonly schemaVersion: 1;
  readonly kind: "exp2";
  readonly colorLinearRgb: readonly [number, number, number];
  readonly density: number;
}
/** E02 IES 集成：lighting 节载荷合同。lightProfiles 与 localLights 同节，
 * 灯通过 ies.profileId 引用 profile，构建/验证层强制引用闭合。 */
export interface RuntimeAuthoredLighting {
  readonly direction: readonly [number, number, number];
  readonly radiance: readonly [number, number, number];
  readonly exposure: number;
  readonly shadows: boolean;
  /** 编辑器中的作者 GI 强度（与直射光曝光分开）。 */
  readonly globalIlluminationIntensity?: number;
  readonly localLights?: readonly RuntimeLocalLight[];
  readonly lightProfiles?: readonly RuntimeLightProfile[];
}
export interface RuntimeLocalLight {
  readonly castShadow?: boolean;
  readonly kind: "directional" | "point" | "spot" | "hemisphere";
  readonly groundRadiance?: readonly [number,number,number];
  readonly shadowSoftness?: number;
  readonly position: readonly [number,number,number];
  readonly direction: readonly [number,number,number];
  readonly radiance: readonly [number,number,number];
  readonly range: number;
  readonly decay: number;
  readonly innerCos: number;
  readonly outerCos: number;
  /** 可选 IES 光域网引用；缺省=既有全向/锥形行为，载荷字节不变。 */
  readonly ies?: RuntimeLightIes;
}
export interface RuntimeLightIes {
  readonly profileId: string;
  /** 绕灯轴的水平旋转，0.5° 网格、[0,360)；缺省 0。 */
  readonly rotationDeg?: number;
  /** 强度缩放 [0,10]；缺省 1。乘后亮度仍受 radiance 上限约束。 */
  readonly scaleFactor?: number;
}
/** 运行包 IES 光度表合同（E02 设计 §2）：θ 0.5° 网格升序，candela 1e-3 量化，
 * 行数由 horizontalSymmetry 决定（1=恰 1 行旋转对称；2=均匀铺满 [0,180]；
 * 4=均匀铺满 [0,90]），复用解析器的对称系数语义。 */
export interface RuntimeLightProfile {
  readonly profileId: string;
  readonly format: "LM-63-1995" | "LM-63-2002";
  readonly verticalAngles: readonly number[];
  /** candela[水平行][垂直列]；maxCandela 由消费端归约（不入载荷）。 */
  readonly candela: readonly (readonly number[])[];
  readonly horizontalSymmetry: 1 | 2 | 4;
  readonly totalLumens: number;
}
export interface RuntimeIblMip { readonly size: number; readonly dataBase64: string }
export interface RuntimePrefilteredIbl {
  readonly schema: "deep-engine.ibl-prefiltered";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly kind: "prefiltered-hdri";
  readonly format: "rgba16float";
  readonly encoding: "base64-le";
  readonly faceOrder: "px-nx-py-ny-pz-nz";
  /** Provenance declaration; resource contentHash separately authenticates the actual payload. */
  readonly source: { readonly contentHash: RuntimeContentHash; readonly license: string };
  readonly specular: { readonly mips: readonly RuntimeIblMip[] };
  readonly diffuse: { readonly mips: readonly RuntimeIblMip[] };
  readonly brdfLut: { readonly width: number; readonly height: number; readonly dataBase64: string };
}
