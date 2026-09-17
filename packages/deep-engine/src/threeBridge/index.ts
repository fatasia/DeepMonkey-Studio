export { ThreeProjectionBridge } from "./ThreeProjectionBridge.js";
export { SceneChangesetProjection } from "./SceneChangesetProjection.js";
export type { ThreeProjectionDirtyMetrics, ThreeProjectionDirtyPlan, ThreeSceneNodeBinding } from "./SceneChangesetProjection.js";
export type { ThreeObjectSource, ThreeProjectionHooks, ProjectionIssue, ProjectionResult } from "./types.js";
export { DeepWebGpuBackend, DeepWebGpuProjectionError } from "./DeepWebGpuBackend.js";
export type { DeepWebGpuBackendCreateRequest, DeepWebGpuBackendOptions, DeepWebGpuBackendRuntime,
  DeepWebGpuRenderRuntime, DeepWebGpuRuntimeFactory, DeepWebGpuShadowSelection,
  DeepWebGpuSyncResult } from "./DeepWebGpuBackend.js";
export { BackendCanvasDeck, bindBackendCanvas } from "./BackendCanvasDeck.js";
export type { BackendCanvasHost, BackendCanvasLease, BackendCanvasSurface,
  CanvasBoundBackend } from "./BackendCanvasDeck.js";
export { threeRenderView } from "./threeRenderView.js";
export type { ThreePerspectiveCameraSource, ThreeRenderViewSource } from "./threeRenderView.js";
export { threeObjectCollection } from "./threeObjectCollection.js";
export { projectThreeWorldLights } from "./threeWorldLights.js";
export type { ThreeFallbackLightRange, ThreeLightObjectSource, ThreeLightProjectionIssue,
  ThreeWorldLightsOptions, ThreeWorldLightsResult } from "./threeWorldLights.js";
