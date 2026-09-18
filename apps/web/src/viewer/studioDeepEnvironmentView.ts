import * as THREE from "three";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import { validatePanoramaBackground } from "@bim-studio/deep-engine/webgpu";

export type StudioDeepEnvironmentView = Pick<RenderView, "background" | "floor" | "panoramaBackground">
  & { readonly environmentIntensity: number };

/** The actual author render path determines background tone mapping, not its file extension. */
export function readStudioDeepEnvironmentView(scene: THREE.Scene, composerActive: boolean): StudioDeepEnvironmentView {
  if (scene.environment && [scene.environmentRotation.x, scene.environmentRotation.y, scene.environmentRotation.z].some(value => value !== 0)) {
    throw new Error("Deep 尚未接入作者环境反射旋转。");
  }
  const environmentIntensity = scene.environment ? scene.environmentIntensity : 0;
  if (!Number.isFinite(environmentIntensity) || environmentIntensity < 0 || environmentIntensity > 64) {
    throw new Error("环境反射强度必须在 0 到 64 之间。");
  }
  if (scene.background instanceof THREE.Color) {
    if (!composerActive) throw new Error("Deep 尚未接入无后处理路径的纯色背景显示域合成。");
    const background = scene.background.toArray() as [number, number, number];
    if (!background.every(value => Number.isFinite(value) && value >= 0)) throw new Error("背景颜色必须为有限非负数。");
    return { background, floor: [0, 0, 0], environmentIntensity };
  }
  if (!(scene.background instanceof THREE.Texture)) throw new Error("Deep 尚未接入透明场景背景。");
  if (scene.backgroundBlurriness !== 0) throw new Error("Deep 尚未接入作者天空模糊参数。");
  const toneMapped = composerActive || scene.background.colorSpace !== THREE.SRGBColorSpace;
  if (!toneMapped) throw new Error("Deep 尚未接入无后处理路径的 sRGB 天空显示域合成。");
  const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4()
    .makeRotationFromEuler(scene.backgroundRotation)).transpose().toArray();
  const panoramaBackground = { intensity: scene.backgroundIntensity, rotation, toneMapped };
  validatePanoramaBackground(panoramaBackground);
  return { background: [0, 0, 0], floor: [0, 0, 0], environmentIntensity,
    panoramaBackground };
}
