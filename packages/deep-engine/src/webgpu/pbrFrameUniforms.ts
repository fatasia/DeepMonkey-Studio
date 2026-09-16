import { temporalAaJitter } from "../postprocess/temporalAaCpu.js";
import { packTransform } from "../instanceTransform.js";
import { CameraFrameHistory, jitterViewProjection, type CameraFrameHistoryResult } from "./cameraFrameHistory.js";
import { lookAt, multiply, orthographic, perspective, type Vec3 } from "./cameraMath.js";
import { DEFAULT_PBR_PRIMARY_DIRECTIONAL_LIGHT, type PbrPrimaryDirectionalLight } from "../lighting/pbrSceneLighting.js";
import { DEFAULT_PBR_RENDERER_FEATURES, type PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { resolvePbrColorGrading, type PbrColorGradingOptions } from "./pbrColorGrading.js";
import { resolvePbrEnvironmentIntensity } from "./pbrEnvironmentIntensity.js";
import type { PanoramaBackground } from "./pbrPanoramaBackground.js";
import type { PbrFog } from "./pbrFog.js";
import type { PbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
import type { PbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";

export interface PbrFrameUniformView {
  readonly eye: Vec3; readonly target: Vec3; readonly up?: Vec3; readonly extent: number;
  readonly background: Vec3; readonly floor: Vec3; readonly exposure: number; readonly roughness: number;
  readonly colorGrading?: PbrColorGradingOptions;
  readonly authorColorEffects?: PbrAuthorColorEffects;
  readonly postProcess?: PbrPostProcessOverrides;
  /** IBL-only radiance multiplier, 0..64; default 1. Does not scale GI or direct lights. */
  readonly environmentIntensity?: number;
  readonly panoramaBackground?: PanoramaBackground;
  /** Undefined keeps legacy preview fog; null disables it. Authored fog requires HDR composition. */
  readonly fog?: PbrFog | null;
  readonly verticalFovRadians?: number; readonly near?: number; readonly far?: number;
}

export interface PbrCameraProjection {
  readonly verticalFovRadians: number;
  readonly near: number;
  readonly far: number;
}

export interface PbrFrameUniformResources {
  readonly frameBuffer: GPUBuffer; readonly outputBuffer: GPUBuffer; readonly groundInstance: GPUBuffer;
  readonly frameData: Float32Array<ArrayBuffer>; readonly outputData: Float32Array<ArrayBuffer>;
  readonly groundData: Float32Array<ArrayBuffer>;
}

export interface PbrFrameUniformResult {
  readonly history: CameraFrameHistoryResult;
  readonly projection: PbrCameraProjection;
  readonly worldToView: Float32Array;
  readonly stableViewProjection: Float32Array;
  readonly depthViewProjection: Float32Array;
}

/** Packs camera, lighting and ground state while leaving history pending until submission. */
export function updatePbrFrameUniforms(queue: GPUQueue, cameraHistory: CameraFrameHistory,
  view: PbrFrameUniformView, width: number, height: number, forceCut: boolean,
  resources: PbrFrameUniformResources,
  primaryLight: PbrPrimaryDirectionalLight = DEFAULT_PBR_PRIMARY_DIRECTIONAL_LIGHT,
  features: PbrRendererFeatures = DEFAULT_PBR_RENDERER_FEATURES): PbrFrameUniformResult {
  const environmentIntensity = resolvePbrEnvironmentIntensity(view.environmentIntensity);
  const extent = view.extent, projection = resolvePbrCameraProjection(view), worldToView = lookAt(view.eye, view.target, view.up);
  const stableViewProjection = multiply(perspective(projection.verticalFovRadians, width / height,
    projection.near, projection.far), worldToView);
  const currentJitter = features.temporalAa ? temporalAaJitter(cameraHistory.revision) : [0, 0] as const;
  const depthViewProjection = jitterViewProjection(stableViewProjection, currentJitter, width, height);
  const history = cameraHistory.beginFrame({ eye: view.eye, target: view.target, extent, width, height,
    viewProjection: depthViewProjection, jitter: currentJitter, forceCut });
  resources.frameData.set(depthViewProjection, 0);
  resources.frameData.set(history.previousViewProjection, 16);
  resources.frameData.set(worldToView, 32);
  resources.frameData.set(multiply(orthographic(extent * 1.5, 0.1, extent * 8),
    lookAt([extent * 1.6, extent * 2.8, extent * 1.2], [0, 0, 0])), 48);
  const jitterDeltaUv = [(history.previousJitter[0] - history.currentJitter[0]) / width,
    (history.previousJitter[1] - history.currentJitter[1]) / height] as const;
  // background.w was reserved; keep the frame ABI size and all following offsets intact.
  resources.frameData.set([...view.eye, features.environment ? 1 : 0, ...view.background, primaryLight.castShadow === false ? 0 : 1,
    ...view.floor, features.groundGrid ? 1 : 0,
    ...primaryLight.surfaceToLightWorld, environmentIntensity, ...jitterDeltaUv, view.roughness, 0.11 / extent,
    ...primaryLight.color, primaryLight.intensity], 64);
  resources.frameData[83] = features.fog ? 0.11 / extent : 0;
  resources.outputData[0] = view.exposure;
  resources.outputData[2] = features.vignette ? 0.25 : 0;
  resources.outputData[3] = features.toneMapping === "three-aces-r185" ? 1 : 0;
  const grading = resolvePbrColorGrading(view.colorGrading);
  resources.outputData.set([grading.temperature, grading.tint, grading.contrast, grading.saturation], 4);
  resources.frameData.set(resources.outputData, 88);
  if (features.groundPlane) {
    const size = extent * 8;
    packTransform([size, 0, 0, 0, 0, size, 0, 0, 0, 0, size, 0, 0, -0.02, 0, 1], resources.groundData);
    resources.groundData.set([0, 0, 0, 0, 0.9, 0.5, 1, 8, 0, 0, 0, 1], 24);
    queue.writeBuffer(resources.groundInstance, 0, resources.groundData);
  }
  queue.writeBuffer(resources.frameBuffer, 0, resources.frameData);
  queue.writeBuffer(resources.outputBuffer, 0, resources.outputData);
  return { history, projection, worldToView, stableViewProjection, depthViewProjection };
}

export function resolvePbrCameraProjection(view: Pick<PbrFrameUniformView,
  "extent" | "verticalFovRadians" | "near" | "far">): PbrCameraProjection {
  const verticalFovRadians = view.verticalFovRadians ?? Math.PI / 4;
  const near = view.near ?? 0.1;
  const far = view.far ?? view.extent * 20;
  if (![verticalFovRadians, near, far].every(Number.isFinite)
    || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI || near <= 0 || far <= near) {
    throw new Error("Invalid PBR camera projection.");
  }
  return Object.freeze({ verticalFovRadians, near, far });
}
