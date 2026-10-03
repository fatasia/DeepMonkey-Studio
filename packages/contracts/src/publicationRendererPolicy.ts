import type { ScenePostProcessingState, SceneSnapshot } from "./scene.js";

/**
 * 当前产品中仍依赖 WebGL EffectComposer 的发布效果。
 * 对象级描边(模型 effects.outline)已由 Deep(WebGPU)实现(packet 实例 outline 位 → 掩码/边缘/合成 pass),
 * 不再单独要求 WebGL;场景级后处理 outline(选中高亮开关)仍随其它屏幕后效一起保守回落。
 */
export function requiresWebGlPublicationEffects(post: ScenePostProcessingState | undefined): boolean {
  return Boolean(post?.enabled && (
    post.smaa || post.fxaa || post.ssao || post.gtao || post.bloom || post.outline
    || post.depthOfField || post.vignette || post.filmGrain || post.afterimage
  ));
}

export function sceneRequiresWebGlPublicationEffects(
  scene: Pick<SceneSnapshot, "models" | "postProcessing" | "primitives">
): boolean {
  return requiresWebGlPublicationEffects(scene.postProcessing);
}

/** 云 Worker 可在加载页面前使用，避免先初始化错误后端再回切。 */
export function preferredPublicationRenderer(
  scene: Pick<SceneSnapshot, "models" | "postProcessing" | "primitives">
): "webgl" | "webgpu" {
  return sceneRequiresWebGlPublicationEffects(scene) ? "webgl" : "webgpu";
}
