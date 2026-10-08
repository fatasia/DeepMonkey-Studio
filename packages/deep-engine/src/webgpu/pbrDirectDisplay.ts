import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { encodePbrDisplayColor } from "./pbrDisplayColor.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";

/** Frame-local plan switches; allocated owners remain available when Composer returns. */
export function pbrAuthorFrameFeatures(features: PbrRendererFeatures, direct = false): PbrRendererFeatures {
  return direct ? { ...features, temporalAa: false, spatialAa: false, contactShadows: false,
    temporalUpscale: false, ssgi: false, projectedTextures: false } : features;
}

/** Selects the lossless one-pass presentation path when no effect needs HDR color history. */
export function pbrDirectDisplayClear(view: PbrFrameUniformView, features: PbrRendererFeatures,
  hasTransparent: boolean, writeGeometryBuffers = false): readonly [number, number, number] | undefined {
  // MRT/deformation-capable pipeline sets do not create direct-display pipelines, even for a static packet.
  // M2 光追阴影:RT 档强制完整 HDR 链(fail-closed)—— 直出 display 快路径只有单级联
  // legacy 采样语义,不消费 RT mask;与 B1 虚拟档强制走完整链同族(帧签名对拍)。
  if (features.rayTracedShadows) return undefined;
  // The author's no-Composer route already encodes fragments before blending;
  // the legacy fused-display shader would tone-map those fragments twice.
  if (view.authorDirectDisplay) return undefined;
  if (writeGeometryBuffers || view.authorColorEffects?.vignette || view.authorColorEffects?.colorGrading
    || view.fog || view.panoramaBackground || hasTransparent || features.ambientOcclusion || features.temporalAa || features.spatialAa || features.occlusionCulling
    || features.screenSpaceReflection || features.bloom || (features.vignette && view.authorColorEffects === undefined)) return undefined;
  return encodePbrDisplayColor(view.background, { exposure: view.exposure,
    toneMapping: features.toneMapping,
    ...(view.colorGrading === undefined ? {} : { colorGrading: view.colorGrading }) });
}
