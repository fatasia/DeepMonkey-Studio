export type ShadowVec3 = readonly [number, number, number];

export interface CascadedShadowCamera {
  readonly eye: ShadowVec3;
  readonly target: ShadowVec3;
  readonly up?: ShadowVec3;
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

export interface CascadedShadowOptions {
  readonly cascadeCount?: number;
  readonly splitLambda?: number;
  readonly maxShadowDistance?: number;
  readonly shadowMapSize?: number;
  readonly depthPadding?: number;
  readonly blendRatio?: number;
}

export interface CascadedShadowSlice {
  readonly index: number;
  readonly near: number;
  readonly far: number;
  readonly blendStart: number;
  readonly center: ShadowVec3;
  readonly radius: number;
  readonly texelWorldSize: number;
  readonly viewProjection: Float32Array<ArrayBuffer>;
  readonly corners: readonly ShadowVec3[];
}

export interface CascadedShadowPlan {
  readonly lightDirection: ShadowVec3;
  readonly shadowMapSize: number;
  readonly cascades: readonly CascadedShadowSlice[];
  readonly splitDepths: Float32Array<ArrayBuffer>;
}
