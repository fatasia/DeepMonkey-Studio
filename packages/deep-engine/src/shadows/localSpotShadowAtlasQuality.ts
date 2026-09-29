import { SHARED_SHADOW_ATLAS_GUARD_TEXELS, type SharedShadowAtlasOptions } from "./sharedShadowAtlas.js";
import { LOCAL_SPOT_SHADOW_MAX_LIGHTS } from "./localSpotShadowShader.js";

/**
 * 局部光（spot）阴影图集的质量档位合同（F7 报告 §四.2/§五 的"图集多灯 opt-in 档"）。
 *
 * 词汇沿用既有档位体系：`standard` = 已发布默认口径（DeepGi preset 词汇，同
 * F7 harness atlas-product-512 腿），`multi-light` = 多灯 opt-in 档（同 F7
 * atlas-256 腿：1024 图集 4×4 tile，16 灯全覆盖，真机 RMSE 0.042 vs 默认档 0.165）。
 * 两档是同一预算（1024² depth32float = 4 MiB、渲染工作量近似相等）下的**分布选择**
 * ——每灯分辨率（508 vs 252 有效 texel）换阴影灯容量（4 vs 16），不是单调质量阶梯，
 * 故不借用 performance/balanced/high/ultra 词汇以免暗示"越高越好"。
 *
 * 默认档不变：默认切换走 Z3.5 联测授权（本模块只提供 opt-in 解析，不改任何默认值）。
 */

export type LocalSpotShadowAtlasTier = "standard" | "multi-light";

export interface LocalSpotShadowAtlasQualityProfile {
  readonly tier: LocalSpotShadowAtlasTier;
  readonly options: Readonly<Required<SharedShadowAtlasOptions>>;
  /** 每灯有效边长（tile 扣 guard texel；真机判据 Q1 的规划口径）。 */
  readonly effectiveTileTexels: number;
  /** 图集保留字节（depth32float；两档同字节，资源代价不变）。 */
  readonly estimatedDepthTextureBytes: number;
}

export interface LocalSpotShadowAtlasTierLimits {
  readonly maxTextureDimension2D?: number;
  readonly maxDepthTextureBytes?: number;
  /**
   * 产品 uniform ABI 的 spot 条目上限（当前 `LOCAL_SPOT_SHADOW_MAX_LIGHTS` = 4；
   * clusterLightingPbr 的 group-3 绑定以 384 字节为 ABI 锚）。缺省按当前 ABI 收口：
   * 16 灯档在 ABI 扩容（1536 字节）落地前 fail-closed，静默接线会在
   * stageMetadata 越界——那是错误路径，不是档位语义。
   */
  readonly maxSpotShadowEntries?: number;
}

export interface LocalSpotShadowAtlasTierSelection {
  readonly requestedTier: LocalSpotShadowAtlasTier;
  readonly selectedTier: LocalSpotShadowAtlasTier;
  readonly downgraded: boolean;
  readonly profile: LocalSpotShadowAtlasQualityProfile;
}

const TIERS = ["standard", "multi-light"] as const satisfies readonly LocalSpotShadowAtlasTier[];

function profile(tier: LocalSpotShadowAtlasTier, requestedAtlasSize: number, tilesPerAxis: number,
  maxShadowedLights: number, maxShadowViews: number): LocalSpotShadowAtlasQualityProfile {
  return Object.freeze({
    tier,
    options: Object.freeze({ requestedAtlasSize, tilesPerAxis, maxShadowedLights, maxShadowViews }),
    effectiveTileTexels: requestedAtlasSize / tilesPerAxis - SHARED_SHADOW_ATLAS_GUARD_TEXELS * 2,
    estimatedDepthTextureBytes: estimateLocalSpotShadowAtlasDepthBytes(requestedAtlasSize),
  });
}

export const LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES:
  Readonly<Record<LocalSpotShadowAtlasTier, LocalSpotShadowAtlasQualityProfile>> = Object.freeze({
    // 逐值等于已发布的 LOCAL_SPOT_SHADOW_ATLAS_OPTIONS（默认零回归的锚）。
    standard: profile("standard", 1024, 2, LOCAL_SPOT_SHADOW_MAX_LIGHTS, LOCAL_SPOT_SHADOW_MAX_LIGHTS),
    // F7 atlas-256 腿参数：16 灯全覆盖，每灯 252 有效 texel。
    "multi-light": profile("multi-light", 1024, 4, 16, 16),
  });

/**
 * 解析请求档位为图集选项。fail-closed：未知档、非法 limits、档位容量超出
 * spot uniform ABI 一律 RangeError；设备资源上限不在本层降档（沿用
 * planSharedShadowAtlas 的 chooseAtlasSize 降级语义，经 plan.downgraded 上报）。
 */
export function resolveLocalSpotShadowAtlasTier(requestedTier: LocalSpotShadowAtlasTier,
  limits?: LocalSpotShadowAtlasTierLimits): LocalSpotShadowAtlasTierSelection {
  if (!TIERS.includes(requestedTier)) throw new RangeError(`Unknown local spot shadow atlas tier: ${String(requestedTier)}.`);
  const profileValue = LOCAL_SPOT_SHADOW_ATLAS_QUALITY_PROFILES[requestedTier];
  const maxSpotShadowEntries = limits?.maxSpotShadowEntries === undefined ? LOCAL_SPOT_SHADOW_MAX_LIGHTS
    : positiveInteger(limits.maxSpotShadowEntries, "maximum spot shadow entries");
  if (profileValue.options.maxShadowedLights > maxSpotShadowEntries) {
    throw new RangeError(`The ${requestedTier} tier admits ${profileValue.options.maxShadowedLights} shadowed lights `
      + `but the spot uniform ABI holds ${maxSpotShadowEntries} entries; growing the ABI `
      + "(LOCAL_SPOT_SHADOW_MAX_LIGHTS, uniform bytes, WGSL entry array) is a prerequisite.");
  }
  if (limits?.maxTextureDimension2D !== undefined) {
    positiveInteger(limits.maxTextureDimension2D, "maximum texture dimension");
  }
  if (limits?.maxDepthTextureBytes !== undefined) {
    positiveInteger(limits.maxDepthTextureBytes, "maximum depth bytes");
    if (profileValue.estimatedDepthTextureBytes > limits.maxDepthTextureBytes) {
      throw new RangeError(`The ${requestedTier} tier requires ${profileValue.estimatedDepthTextureBytes} `
        + `depth bytes but the limit is ${limits.maxDepthTextureBytes}.`);
    }
  }
  return Object.freeze({ requestedTier, selectedTier: requestedTier, downgraded: false, profile: profileValue });
}

/** 质量档位 → 图集选项（probeRadianceDirectionCountForQuality 同款单一权威映射）。 */
export function localSpotShadowAtlasOptionsForTier(tier: LocalSpotShadowAtlasTier,
  limits?: LocalSpotShadowAtlasTierLimits): Readonly<Required<SharedShadowAtlasOptions>> {
  return resolveLocalSpotShadowAtlasTier(tier, limits).profile.options;
}

/** 图集保留字节数（depth32float；资源准入与预算上报口径）。 */
export function estimateLocalSpotShadowAtlasDepthBytes(requestedAtlasSize: number): number {
  positiveInteger(requestedAtlasSize, "atlas size");
  const bytes = requestedAtlasSize * requestedAtlasSize * 4;
  if (!Number.isSafeInteger(bytes)) throw new RangeError("Local spot shadow atlas depth allocation exceeds the safe integer range.");
  return bytes;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid local spot shadow atlas ${label}.`);
  return value;
}
