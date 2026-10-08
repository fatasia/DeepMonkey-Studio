import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE, type PbrVolumetricFogProfile, type RenderView } from "@bim-studio/deep-engine/webgpu";

/** 开关和 Bloom 参数取自实际作者状态；AO 算法参数仍需单独接入。 */
export function readStudioDeepPostProcess(state: ScenePostProcessingState,
  composerActive: boolean): NonNullable<RenderView["postProcess"]> {
  const bloom = composerActive && state.enabled && Boolean(state.bloom);
  const screenSpaceReflection = composerActive && state.enabled && Boolean(state.screenSpaceReflection);
  const volumetricFog = composerActive && state.enabled && Boolean(state.volumetricFog);
  const volumetricFogProfile: PbrVolumetricFogProfile | undefined = volumetricFog ? Object.freeze({
    ...DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE,
    medium: Object.freeze({
      ...DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE.medium,
      baseExtinction: state.volumetricFogDensity ?? DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE.medium.baseExtinction,
      scaleHeight: state.volumetricFogHeight ?? DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE.medium.scaleHeight,
      anisotropy: state.volumetricFogAnisotropy ?? DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE.medium.anisotropy,
      albedo: state.volumetricFogAlbedo ?? DEFAULT_PBR_VOLUMETRIC_FOG_PROFILE.medium.albedo,
    }),
    ...(state.volumetricFogSteps === undefined ? {} : { steps: state.volumetricFogSteps }),
    ...(state.volumetricGodRays ? { godRaysStrength: state.volumetricGodRaysStrength ?? 1 } : {}),
  }) : undefined;
  return Object.freeze({ ambientOcclusion: composerActive && state.enabled && Boolean(state.ssao || state.gtao),
    screenSpaceReflection,
    ...(screenSpaceReflection ? { screenSpaceReflectionProfile: Object.freeze({ steps: state.ssrSteps ?? 32,
      thicknessScale: state.ssrThickness ?? 0.01, maxDistanceScale: state.ssrMaxDistance ?? 2 }) } : {}),
    volumetricFog,
    ...(volumetricFogProfile ? { volumetricFogProfile } : {}),
    // 对象级描边外观跟随作者 outlineStrength(three OutlinePass.edgeStrength);是否绘制由 packet 的 outline 实例决定。
    ...(state.outlineStrength === undefined ? {} : { instanceOutline: Object.freeze({ strength: state.outlineStrength }) }),
    bloom, ...(bloom ? { authorBloom: Object.freeze({ strength: state.bloomStrength, threshold: state.bloomThreshold }) } : {}) });
}

/** 读取实际 Composer 状态；空对象明确关闭 Deep 预览暗角。 */
export function readStudioDeepColorEffects(state: ScenePostProcessingState,
  composerActive: boolean): NonNullable<RenderView["authorColorEffects"]> {
  if (!composerActive || !state.enabled) return Object.freeze({});
  return Object.freeze({
    ...(state.vignette ? { vignette: Object.freeze({ darkness: state.vignetteDarkness ?? 1.2 }) } : {}),
    ...(state.colorGrading ? { colorGrading: Object.freeze({ hue: state.hue ?? 0,
      saturation: state.saturation ?? 0, brightness: state.brightness ?? 0, contrast: state.contrast ?? 0,
      temperature: state.temperature ?? 0, tint: state.tint ?? 0 }) } : {}),
  });
}
