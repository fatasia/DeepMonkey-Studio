import type { RendererBackend } from "./viewerTypes";

export const WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE = 12;

/** 场景越大，单次整场替换产生的绑定资源越多，因此自动收紧回收周期。 */
export function webGpuSceneReplacementThreshold(componentCount: number): number {
  if (componentCount >= 5_000) return 2;
  if (componentCount >= 1_000) return 4;
  if (componentCount >= 250) return 8;
  return WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE;
}

/**
 * WebGPU 绑定组没有显式 destroy API。连续整场替换达到上限后重建 renderer/device，
 * 可回收浏览器后端持有的外部资源；单对象增删不会触发，也不改变任何画质参数。
 */
export function shouldRecycleWebGpuRenderer(
  backend: RendererBackend,
  sceneReplacements: number,
  threshold = WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE,
): boolean {
  return backend === "webgpu" && threshold > 0 && sceneReplacements >= threshold;
}
