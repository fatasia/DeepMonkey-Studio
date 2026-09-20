export type LightVector3 = readonly [number, number, number];
import type { RuntimeLightProfile } from "../runtimePackage/environmentTypes.js";

export interface DirectionalLight {
  /** Unit length is not required; packing normalizes this view-space direction. */
  readonly directionView: LightVector3;
  readonly color: LightVector3;
  readonly intensity: number;
}

export interface LocalLightShadow {
  /** Stable identity used by the shared atlas planner. */
  readonly key: string;
  /** Optional allocation priority; intensity is used when omitted. */
  readonly importance?: number;
}

/** E02 IES 光域网引用（设计 §2）；字段语义与 runtimePackage 的 RuntimeLightIes 一致，
 * 由 lighting/iesShading.ts 在打包时做合同验证与解析。 */
export interface SpotLightIes {
  readonly profileId: string;
  /** 绕灯轴的水平旋转，0.5° 网格、[0,360)；缺省 0。 */
  readonly rotationDeg?: number;
  /** 强度缩放 [0,10]；缺省 1。消费端吃归一化因子（candela/maxCandela×scaleFactor）。 */
  readonly scaleFactor?: number;
}

export interface PointLight {
  readonly positionView: LightVector3;
  readonly range: number;
  readonly color: LightVector3;
  readonly intensity: number;
  readonly shadow?: LocalLightShadow;
}

export interface SpotLight extends PointLight {
  readonly directionView: LightVector3;
  readonly innerConeCos: number;
  readonly outerConeCos: number;
  /** 可选 IES 光域网；缺省=既有锥形行为（着色路径逐位不变）。 */
  readonly ies?: SpotLightIes;
}

export interface ClusteredLights {
  readonly directional?: readonly DirectionalLight[];
  readonly points?: readonly PointLight[];
  readonly spots?: readonly SpotLight[];
  /** E02：IES 光度表载荷（runtimePackage lightProfiles 原样透传），
   * 与 spots 的 ies.profileId 引用闭合由打包层强制。 */
  readonly lightProfiles?: readonly RuntimeLightProfile[];
}

export interface ClusterGridConfig {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly tileSizeX: number;
  readonly tileSizeY: number;
  readonly zSlices: number;
  readonly near: number;
  readonly far: number;
  readonly verticalFovRadians: number;
  readonly maxLightsPerCluster: number;
}

export interface NormalizedClusterGrid extends ClusterGridConfig {
  readonly tilesX: number;
  readonly tilesY: number;
  readonly clusterCount: number;
  readonly aspect: number;
  readonly tanHalfFovY: number;
}

export interface ClusterLightBounds {
  readonly minTileX: number;
  readonly maxTileX: number;
  readonly minTileY: number;
  readonly maxTileY: number;
  readonly minSlice: number;
  readonly maxSlice: number;
}

export interface CpuClusterAssignment {
  readonly grid: NormalizedClusterGrid;
  /** [fixed offset, bounded count] for every cluster. */
  readonly headers: Uint32Array;
  /** Fixed-stride local-light indices. Unused entries are 0xffffffff. */
  readonly lightIndices: Uint32Array;
  readonly overflowCount: number;
  readonly localLightCount: number;
}

export interface PackedClusteredLights {
  readonly directional: Float32Array;
  readonly points: Float32Array;
  readonly spots: Float32Array;
  /** point bounds followed by spot bounds; cluster indices address this order. */
  readonly localBounds: Float32Array;
  readonly directionalCount: number;
  readonly pointCount: number;
  readonly spotCount: number;
}
