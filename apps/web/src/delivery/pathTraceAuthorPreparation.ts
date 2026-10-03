import type { SceneSnapshot } from "@bim-studio/contracts";
import type { PathTraceSceneIdentity, PathTraceSessionConfig, RenderPacket } from "@bim-studio/deep-engine";
import { runtimeContentSha256, type RuntimeAuthoredLighting, type RuntimeSceneCamera } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneCamera } from "./compileSceneCamera";
import { compileSceneLighting } from "./compileSceneLighting";
import { compileSceneRenderPacket, type CompileSceneRenderOptions } from "./compileSceneRenderPacket";
import { localizeSceneCoordinates } from "./sceneLocalCoordinates";
import { sceneCompilationSource } from "./sceneCompilationSource";

export type PathTraceAuthorIllumination = "physical-scene-radiance" | "directional-reference" | "white-furnace-reference";
export interface PathTraceAuthorPrepared {
  readonly packet: RenderPacket;
  readonly camera: RuntimeSceneCamera;
  readonly lighting?: RuntimeAuthoredLighting;
  readonly studioIntensity: number;
  readonly illumination: PathTraceAuthorIllumination;
  readonly identity: PathTraceSceneIdentity;
  readonly config: PathTraceSessionConfig;
  readonly sourceHash: string;
  readonly sceneName: string;
  readonly inapplicableRealtimeControls: Readonly<Record<string, unknown>>;
}
export function pathTraceAuthorSourceHash(scene: SceneSnapshot): string {
  const source = sceneCompilationSource(scene);
  delete source.createdAt;
  return runtimeContentSha256(source);
}

/** Current author source -> existing static packet/camera compiler. No viewport readback. */
export async function preparePathTraceAuthor(scene: SceneSnapshot, config: PathTraceSessionConfig,
  illumination: PathTraceAuthorIllumination, options: CompileSceneRenderOptions): Promise<PathTraceAuthorPrepared> {
  options.signal?.throwIfAborted();
  if (!["physical-scene-radiance", "directional-reference", "white-furnace-reference"].includes(illumination)) {
    throw new Error("Unsupported path trace illumination mode.");
  }
  const snapshot = structuredClone(scene), sourceHash = pathTraceAuthorSourceHash(snapshot);
  if (snapshot.clipping?.enabled) throw new Error("物理出图暂不支持场景剖切。");
  const environment = snapshot.environment;
  let studioIntensity = 0, lighting: RuntimeAuthoredLighting | undefined;
  if (illumination !== "white-furnace-reference") {
    if (snapshot.weather !== undefined && snapshot.weather !== "sunny") throw new Error("物理出图暂不支持天气/体积效果。");
    const studio = environment?.skybox === "studio";
    lighting = compileSceneLighting(snapshot.lighting, snapshot.weather, undefined, studio);
    if (!lighting) throw new Error("当前场景灯光无法编译为物理出图辐射源。");
    if (lighting.localLights?.length || lighting.lightProfiles?.length) throw new Error("物理出图暂不支持局部光/IES。");
    if (illumination === "physical-scene-radiance") {
      if (environment?.environmentMapUrl) throw new Error("物理出图暂不支持外部 HDR 环境。");
      if (!environment || (environment.skybox !== "none" && !studio)) throw new Error("物理出图暂不支持该环境类型。");
      const intensity = environment.environmentIntensity ?? 1;
      if (!Number.isFinite(intensity) || intensity < 0) throw new Error("物理出图环境强度无效。");
      studioIntensity = studio ? intensity : 0;
    }
  }
  // This physical mode excludes editor overlays; retain the original value in its receipt.
  if (snapshot.environment) snapshot.environment = { ...snapshot.environment, gridVisible: false };
  const localized = localizeSceneCoordinates(snapshot);
  const compiled = await compileSceneRenderPacket(localized.scene, { ...options,
    auxiliaryGridOrigin: { x: -localized.frame.origin.x, y: -localized.frame.origin.y, z: -localized.frame.origin.z } });
  options.signal?.throwIfAborted();
  const camera = compileSceneCamera(localized.scene, localized.frame);
  return Object.freeze({ packet: compiled.packet, camera, ...(lighting ? { lighting } : {}), studioIntensity, illumination,
    identity: Object.freeze({ sceneRevision: 1, materialHash: runtimeContentSha256({ sourceHash, illumination }),
      cameraHash: runtimeContentSha256(camera) }), config: Object.freeze({ ...config }), sourceHash, sceneName: scene.name,
    inapplicableRealtimeControls: Object.freeze({ realtimeGiEnhancement: scene.lighting?.globalIlluminationIntensity,
      realtimeReflectionsEnabled: scene.lighting?.reflectionsEnabled,
      realtimeGlobalIlluminationEnabled: scene.lighting?.globalIlluminationEnabled,
      editorAuxiliaryGrid: scene.environment?.gridVisible, postProcessing: scene.postProcessing,
      hdrDisplayExposure: lighting?.exposure, backgroundSrgb: environment?.backgroundColor }) });
}
