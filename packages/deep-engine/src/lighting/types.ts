export type LightVector3 = readonly [number, number, number];

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
}

export interface ClusteredLights {
  readonly directional?: readonly DirectionalLight[];
  readonly points?: readonly PointLight[];
  readonly spots?: readonly SpotLight[];
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
