//! 打包期宿主桩:scripts/gate-parity.mjs 以 esbuild onResolve 插件把本模块解析到
//! apps/web/src/viewer/studioDeepEnvironmentLights.ts(单一 bundle 保证与场景共用同一
//! three 实例,instanceof 灯光判定才成立)。直接运行本桩 = 打包配置错误,fail-closed。
import type * as THREE from "three";

export interface ParityLightProjection {
  readonly lights: NonNullable<import("../src/webgpu/pbrRendererTypes.js").RenderView["lights"]>;
  readonly issues: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}

export function projectStudioDeepLights(_scene: THREE.Scene, _cameraLayerMask?: number, _shadowsEnabled?: boolean): ParityLightProjection {
  throw new Error("parityGateLightsHost was not aliased to the web implementation at bundle time");
}
