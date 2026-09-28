import * as THREE from "three";
import { CASCADED_SHADOW_QUALITY_PROFILES, type CascadedShadowQualityTier } from "@bim-studio/deep-engine";
import { adaptiveQualityOverridesForProfile, type AuthoredQualityProfile } from "@bim-studio/deep-engine/webgpu";

/**
 * 作者质量档 → 引擎阴影档。映射走引擎既有 PROFILES 表（adaptiveQuality.ts
 * `adaptiveQualityOverridesForProfile`），词汇与 `AdaptiveQualityKnobs.shadowTier`
 * 完全一致，零契约漂移；未配置质量档时取 Z1 审计 §4.1 的零配置口径 high（4×2048）。
 * 注意：这是"分配档"，与自适应降档 knobs（运行期只降不升）同表同词汇。
 */
export function studioDeepShadowTier(profile: AuthoredQualityProfile | null | undefined): CascadedShadowQualityTier {
  if (!profile) return "high";
  const tier = adaptiveQualityOverridesForProfile(profile).shadowTier;
  if (!tier) throw new Error("自适应质量档缺少阴影档位。");
  return tier;
}

/** 档位分配（级联数/尺寸/分割/混合），直读 `CASCADED_SHADOW_QUALITY_PROFILES`，零新建。 */
export function studioDeepShadowAllocation(tier: CascadedShadowQualityTier) {
  return CASCADED_SHADOW_QUALITY_PROFILES[tier].options;
}

/** 零配置档位分配的阴影贴图边长（high = 2048）。 */
export const STUDIO_DEEP_SHADOW_TIER_MAP_SIZE = studioDeepShadowAllocation("high").shadowMapSize;

/**
 * Reserve the author's map even when global shadows are currently off.
 * 无任何有效作者阴影意图时，兜底从固定 1024 提升为档位尺寸（Z1 P1：零配置 2048）；
 * 作者显式配置仍完全优先——引擎会话合同要求分配精确跟随作者值（见
 * studioDeepShadowAllocation 测试与引擎 cascadedShadowResources 的 authored 约束）。
 */
export function studioDeepShadowMapSize(scene: THREE.Scene, cameraLayerMask: number,
  tierMapSize: number = STUDIO_DEEP_SHADOW_TIER_MAP_SIZE): number {
  let mapSize: number | undefined;
  scene.traverseVisible(object => {
    if (mapSize !== undefined || !(object instanceof THREE.DirectionalLight) || !object.castShadow
      || object.intensity <= 0 || (object.layers.mask & cameraLayerMask) === 0) return;
    const { x, y } = object.shadow.mapSize;
    // Invalid inactive author shadows are diagnosed when enabled, not while preparing a shadow-free view.
    if (x === y && Number.isSafeInteger(x) && x >= 64 && x <= 16384) mapSize = x;
  });
  return mapSize ?? tierMapSize;
}
