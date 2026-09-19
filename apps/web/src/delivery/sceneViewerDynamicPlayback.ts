import { buildDeepRuntimePackage, type DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileDynamicRuntime } from "./compileSceneRuntimePackage";

export interface SceneViewerDynamicPlaybackHost {
  startDynamicRuntimePlayback(
    runtimePackage: DeepRuntimePackage,
    options?: {
      readonly loop?: boolean;
      readonly onFramePresented?: (frame: { readonly timeMs: number; readonly presentationMs: number }) => void;
    },
  ): () => void;
}

/** Minimal viewer-side host for the published dynamic channel. The delivery
 * viewer already materializes geometry from the frozen publication; the
 * carrier package only has to carry the lowered v7 dynamic payload, so its
 * render packet is empty by construction. This package is a playback input
 * derived from the frozen snapshot — it is never presented as the publish
 * artifact or as a Native-ready package. */
export function compileSceneDynamicRuntimePackage(
  input: SceneSnapshot,
  options: { readonly packageId: string; readonly packageVersion: string },
): DeepRuntimePackage {
  const dynamicRuntime = compileDynamicRuntime(input);
  if (!dynamicRuntime) throw new Error("发布快照没有可播放的对象 TRS 动画");
  return buildDeepRuntimePackage({
    packageId: options.packageId,
    packageVersion: options.packageVersion,
    renderPacket: { id: "scene.dynamic-carrier", revision: 1, value: { geometries: [], materials: [], instances: [] } },
    dynamicRuntime,
  });
}

/** Production wiring for the read-only scene viewer: when the frozen
 * publication snapshot carries object TRS animation, start clock-driven
 * playback of the compiled dynamic runtime on the engine's presentation
 * frame scheduler (WebGL and WebGPU hosts alike). Returns the idempotent
 * stop function, or undefined when the snapshot has no playable dynamic
 * channel — a missing channel must stay silent, not fake a playing scene. */
export function startSceneViewerDynamicPlayback(
  engine: SceneViewerDynamicPlaybackHost,
  scene: SceneSnapshot,
  options: { readonly packageId: string; readonly packageVersion: string; readonly onFramePresented?: (frame: { readonly timeMs: number; readonly presentationMs: number }) => void },
): (() => void) | undefined {
  const animation = scene.animation;
  if (!animation || !animation.models.length) return undefined;
  const runtimePackage = compileSceneDynamicRuntimePackage(scene, options);
  return engine.startDynamicRuntimePlayback(runtimePackage, {
    loop: animation.loop,
    ...(options.onFramePresented ? { onFramePresented: options.onFramePresented } : {}),
  });
}
