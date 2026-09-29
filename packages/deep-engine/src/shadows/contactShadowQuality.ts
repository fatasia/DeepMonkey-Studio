/**
 * C10 屏幕空间接触阴影的质量档位合同。
 *
 * 词汇沿用既有两套档位体系:阴影四档(performance/balanced/high/ultra,shadowQuality)与
 * Deep GI 三档(probeClipmapOptionsForQuality)。接触阴影取三档语义(近场贴片质量分档),
 * 默认档(宿主不显式开启)不带——Z 级联测决策:opt-in,默认关闭。
 */

export type ContactShadowQualityTier = "performance" | "balanced" | "quality";

export interface ContactShadowQualityProfile {
  readonly tier: ContactShadowQualityTier;
  /** 屏幕空间短距步进参数;radius/thickness 是世界单位,按场景 extent 派生。 */
  readonly options: Readonly<{
    /** 采样步数(半分辨率射线);refines>0 追加二分细化步。 */
    readonly steps: number;
    readonly refines: number;
    /** 遮蔽强度 0..1(最终 mask = occlusion·strength)。 */
    readonly strength: number;
    /** 阶梯 falloff 指数(1 = 线性衰减)。 */
    readonly falloff: number;
  }>;
}

export interface ContactShadowQualityLimits {
  readonly maxTextureDimension2D: number;
}

export interface ContactShadowQualitySelection {
  readonly requestedTier: ContactShadowQualityTier;
  readonly selectedTier: ContactShadowQualityTier;
  readonly downgraded: boolean;
  readonly profile: ContactShadowQualityProfile;
}

const TIERS = ["performance", "balanced", "quality"] as const satisfies readonly ContactShadowQualityTier[];

function profile(tier: ContactShadowQualityTier, steps: number, refines: number,
  strength: number, falloff: number): ContactShadowQualityProfile {
  return Object.freeze({ tier,
    options: Object.freeze({ steps, refines, strength, falloff }) });
}

export const CONTACT_SHADOW_QUALITY_PROFILES: Readonly<Record<ContactShadowQualityTier, ContactShadowQualityProfile>> =
  Object.freeze({
    performance: profile("performance", 6, 0, 0.55, 1.2),
    balanced: profile("balanced", 10, 2, 0.7, 1.0),
    quality: profile("quality", 14, 3, 0.85, 0.85),
  });

/** 宿主三档词汇入口(probeClipmapOptionsForQuality 同契约:作者期错误在接线处暴露)。 */
export function contactShadowOptionsForQuality(quality: ContactShadowQualityTier = "balanced"):
  Readonly<{ steps: number; refines: number; strength: number; falloff: number }> {
  const preset = CONTACT_SHADOW_QUALITY_PROFILES[quality];
  if (!preset) throw new RangeError(`Invalid contact shadow quality tier: ${String(quality)}.`);
  return preset.options;
}

/**
 * 解析请求档位。接触阴影的档位不涉及设备资源上限(半分辨率 r16float 单贴),
 * 降级轴只有显式 maxMaskDimension(资源预算由调用方钳制)。
 */
export function resolveContactShadowQuality(requestedTier: ContactShadowQualityTier,
  limits?: ContactShadowQualityLimits): ContactShadowQualitySelection {
  const index = TIERS.indexOf(requestedTier);
  if (index < 0) throw new RangeError(`Unknown contact shadow quality tier: ${String(requestedTier)}.`);
  if (limits?.maxTextureDimension2D !== undefined && limits.maxTextureDimension2D < 1) {
    throw new RangeError("Contact shadow maxMaskDimension must be positive.");
  }
  const profile2 = CONTACT_SHADOW_QUALITY_PROFILES[requestedTier];
  return Object.freeze({ requestedTier, selectedTier: requestedTier, downgraded: false, profile: profile2 });
}

/** 半分辨率遮蔽贴字节数(rgba16float;资源准入/预算上报)。 */
export function estimateContactShadowMaskBytes(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new RangeError("Contact shadow mask dimensions must be positive safe integers.");
  }
  return Math.ceil(width / 2) * Math.ceil(height / 2) * 8;
}
