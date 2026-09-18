import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";

/** 开关和 Bloom 参数取自实际作者状态；AO 算法参数仍需单独接入。 */
export function readStudioDeepPostProcess(state: ScenePostProcessingState,
  composerActive: boolean): NonNullable<RenderView["postProcess"]> {
  const bloom = composerActive && state.enabled && Boolean(state.bloom);
  return Object.freeze({ ambientOcclusion: composerActive && state.enabled && Boolean(state.ssao || state.gtao),
    bloom, ...(bloom ? { authorBloom: Object.freeze({ strength: state.bloomStrength, threshold: state.bloomThreshold }) } : {}) });
}

/** 读取实际 Composer 状态；空对象明确关闭 Deep 预览暗角。 */
export function readStudioDeepColorEffects(state: ScenePostProcessingState,
  composerActive: boolean): NonNullable<RenderView["authorColorEffects"]> {
  if (!composerActive || !state.enabled) return Object.freeze({});
  return Object.freeze({
    ...(state.vignette ? { vignette: Object.freeze({ darkness: state.vignetteDarkness ?? 1.2 }) } : {}),
    ...(state.colorGrading ? { colorGrading: Object.freeze({ hue: state.hue ?? 0,
      saturation: state.saturation ?? 0, brightness: state.brightness ?? 0, contrast: state.contrast ?? 0 }) } : {}),
  });
}
