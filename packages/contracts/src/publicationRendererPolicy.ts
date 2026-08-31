import type { ScenePostProcessingState, SceneSnapshot } from "./scene.js";

/** 当前产品中仍依赖 WebGL EffectComposer 的发布效果。 */
export function requiresWebGlPublicationEffects(
  post: ScenePostProcessingState | undefined,
  objectOutlineEnabled = false
): boolean {
  const activePostEffect = Boolean(post?.enabled && (
    post.smaa || post.fxaa || post.ssao || post.gtao || post.bloom || post.outline
    || post.depthOfField || post.vignette || post.filmGrain || post.afterimage
  ));
  return activePostEffect || objectOutlineEnabled;
}

export function sceneRequiresWebGlPublicationEffects(
  scene: Pick<SceneSnapshot, "models" | "postProcessing" | "primitives">
): boolean {
  // 兼容早期发布快照缺少 primitives 的历史数据，策略层不得让 Worker 启动崩溃。
  const objectOutlineEnabled = [...(scene.models ?? []), ...(scene.primitives ?? [])]
    .some((object) => object.effects?.outline);
  return requiresWebGlPublicationEffects(scene.postProcessing, objectOutlineEnabled);
}

/** 云 Worker 可在加载页面前使用，避免先初始化错误后端再回切。 */
export function preferredPublicationRenderer(
  scene: Pick<SceneSnapshot, "models" | "postProcessing" | "primitives">
): "webgl" | "webgpu" {
  return sceneRequiresWebGlPublicationEffects(scene) ? "webgl" : "webgpu";
}
