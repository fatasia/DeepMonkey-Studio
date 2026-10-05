import * as THREE from "three";
import {
  DEFAULT_DISPLAY_CONTRACT,
  type DisplayOutputColorSpace,
  type DisplayShadowFilter,
  type DisplayToneMappingOperator,
} from "@bim-studio/contracts";

/** three 侧对 DisplayContract 枚举的唯一映射；three 只有 ACESFilmic，deep-aces 无等价算子，明确回落到它。 */
export function threeToneMappingFor(operator: DisplayToneMappingOperator): THREE.ToneMapping {
  switch (operator) {
    case "three-aces-r185": return THREE.ACESFilmicToneMapping;
    case "deep-aces": return THREE.ACESFilmicToneMapping;
  }
}

/** GI 强度缺省的唯一出口：three（setGlobalLighting/applyLighting）与 Deep 发布编译共用。 */
export function resolveGlobalIlluminationIntensity(value: number | undefined): number {
  return value ?? DEFAULT_DISPLAY_CONTRACT.environment.globalIlluminationIntensity;
}

/** 动态曝光公式的 three 侧出口；`scale` 为天气系数，Deep 编译固定 1（仅晴天）。 */
export function resolveDynamicExposure(lightingEnabled: boolean, intensity: number, scale = 1): number {
  const exposure = DEFAULT_DISPLAY_CONTRACT.toneMapping.dynamicExposure;
  return lightingEnabled && exposure.enabled
    ? THREE.MathUtils.clamp(exposure.base + intensity * scale * exposure.intensityScale, exposure.min, exposure.max)
    : exposure.min;
}

export function threeOutputColorSpaceFor(space: DisplayOutputColorSpace): THREE.ColorSpace {
  return space === "srgb" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
}

/** three r186 起 PCFSoftShadowMap 已废弃(WebGPU 侧实现移除,warn 后回落);r186 的 PCFShadowMap 即软阴影,两个合同值统一映射到它。 */
export function threeShadowMapTypeFor(filter: DisplayShadowFilter): THREE.ShadowMapType {
  return THREE.PCFShadowMap;
}

export const DISPLAY_THREE_TONE_MAPPING = threeToneMappingFor(DEFAULT_DISPLAY_CONTRACT.toneMapping.operator);
export const DISPLAY_THREE_SHADOW_MAP_TYPE = threeShadowMapTypeFor(DEFAULT_DISPLAY_CONTRACT.shadow.filter);
