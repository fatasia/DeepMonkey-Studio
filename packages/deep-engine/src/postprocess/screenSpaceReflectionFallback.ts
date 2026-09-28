/**
 * SSR → 探针/环境回退决策链（T03 整包化切片）。纯逻辑、逐分支可测；
 * 它是 SSR trace mask 语义与既有 composite「命中替换、未命中保留」行为的规范描述，
 * rayTracing/ssrRayExtension（屏外二次射线档）与真机采集脚本共用同一份决策表。
 *
 * == 能量/曝光统一约定（全链路唯一口径） ==
 * 1. 所有缓冲（base color、trace、probe/env specular）都是线性 HDR radiance（rgba16float），
 *    无 sRGB、无烘焙曝光；曝光/tone map 只发生在后级后处理链，SSR 不触碰。
 * 2. opaque base color 已含探针/环境 specular（T02 链路产出）。composite 是
 *    output = base × (1 - mask) + trace.rgb（trace.rgb = radiance × mask）——命中做
 *    「替换」不是「叠加」，同一能量不会计两次；miss 时 mask=0，base 原样保留。
 * 3. mask = Fresnel_Schlick(F0, cosθ) × smoothstep(edgeFade) ∈ [0,1]，trace 与二次射线
 *    扩展共用同一 cosθ/uv 口径；二次射线能量 = albedo × ambient ≤ base 环境项上界，
 *    只替换不增益，命中/未命中边界能量连续且有上界。
 * 4. 粗糙度走有界锥 mip（≤6 级，lod = roughness² × (activeMipLevels-1)），任何档位都
 *    禁止用全屏模糊掩盖错误。
 * 5. 历史失效（相机切换/动态遮挡 bump revision 后第一帧）：SSR 本体逐帧无状态，天然
 *    不携带旧历史；任何复用历史的次级档（屏外射线缓存、探针缓存 specular）必须降级为
 *    当前帧探针/环境项，禁止跨 cut 复用。
 */

/** miss 分类原因（与 trace WGSL 早退边界一一对应）。 */
export type SsrMissReason =
  | "no-origin"        // centerDepth ≤ 0：无反射起点（空洞/天空），不可延长。
  | "reflected-behind" // reflected.z ≥ 0：反射朝相机平面之后，屏幕空间不可解析。
  | "off-screen"       // 步进投影出屏。
  | "step-exhausted"   // 步数耗尽未交到厚度带。
  | "depth-hole"       // 命中细化遇到深度空洞被拒绝。
  | "ray-depth-guard"  // 反射射线穿过相机平面（rayDepth ≤ 0）。

/** 决策输出的能量来源档位。 */
export type SsrReflectionSource =
  | "ssr"          // 屏内 SSR 命中（trace mask > 0）。
  | "ray-extension" // 屏外二次射线扩展命中（ssrRayExtension）。
  | "probe"        // 探针 specular（base 已含，保留即可）。
  | "environment"  // 无探针覆盖时的 IBL/环境项（base 已含，保留即可）。
  | "fallback-base"; // 连环境都缺失：保留 base（仅允许变暗到 base，不允许黑洞）。

export interface SsrFallbackDecision {
  readonly source: SsrReflectionSource;
  /** no-origin / reflected-behind / off-screen / step-exhausted / depth-hole / ray-depth-guard / roughness-exceeds / history-invalid / hit */
  readonly reason: SsrMissReason | "roughness-exceeds" | "history-invalid" | "hit";
  /** composite 混合权重：>0 仅在 ssr/ray-extension 档（= 命中 mask）；回退档恒 0（保留 base）。 */
  readonly weight: number;
}

export interface SsrFallbackInput {
  /** trace alpha（本帧真实计算值；未跑 trace 的像素传 0）。 */
  readonly ssrMask: number;
  /** 像素中心线性视空间深度；≤ 0 表示无 origin。 */
  readonly originDepth: number;
  /** 反射方向 z 分量；undefined 表示未计算（如无 origin）。 */
  readonly reflectedZ?: number | undefined;
  /** 粗糙度 [0,1]。 */
  readonly roughness: number;
  /**
   * 粗糙度回退阈：超过即认为锥 mip 已到顶、屏内信息不足以支撑该材质的镜面，
   * 优先探针预滤波 specular。默认 1 = 关闭（产品可按材质类别配置）。
   */
  readonly roughnessFallbackThreshold?: number;
  /**
   * 历史有效性：相机/遮挡 revision 自上一帧未变。false 时屏外射线档降级为探针
   * （reason=history-invalid），并要求所有能量来自当前帧计算。
   */
  readonly historyValid: boolean;
  /**
   * miss 族的显式分类（来自 GT 步进或内核调试输出）。缺省时按 reflectedZ 粗分
   * （≥0 → reflected-behind，否则 step-exhausted）。
   */
  readonly missReason?: SsrMissReason;
  /** 屏外二次射线扩展是否在本帧可用（主开关 AND 预算未耗尽）。 */
  readonly rayExtensionAvailable?: boolean;
  /**
   * 二次射线扩展本帧对该像素的命中 mask（0 = 未命中/未发）。仅当主 trace miss 且
   * 历史有效且扩展可用时才有意义。
   */
  readonly extensionMask?: number;
}

/** miss 像素的分类（不含 no-origin；那是回退档入口不是 miss 族）。 */
export function classifySsrMiss(reflectedZ: number | undefined,
  hitUvInside: boolean, marchExhausted: boolean, hitRejectedByHole: boolean): SsrMissReason {
  if (hitRejectedByHole) return "depth-hole";
  if (reflectedZ !== undefined && reflectedZ >= 0) return "reflected-behind";
  if (!hitUvInside) return "off-screen";
  return "step-exhausted";
}

/**
 * 单像素回退决策。优先级（高→低）：
 * 1. no-origin → fallback-base（无 origin，连射线都不可延）。
 * 2. ssrMask > 0 且粗糙度未超阈 → ssr（weight = mask）。
 * 3. ssrMask > 0 且超阈 → probe（roughness-exceeds；锥 mip 顶档不等价于探针预滤波）。
 * 4. miss 族 + 历史有效 + 扩展可用 + extensionMask > 0 → ray-extension。
 * 5. miss 族 + 历史失效 → probe（history-invalid；禁止跨 cut 复用扩展/缓存能量）。
 * 6. 其余 miss → probe（探针缺失时由 base 内的环境项承担，对 composite 不可区分，统称 probe 档）。
 */
export function decideSsrFallback(input: SsrFallbackInput): SsrFallbackDecision {
  if (!(input.originDepth > 0)) {
    return { source: "fallback-base", reason: "no-origin", weight: 0 };
  }
  if (input.ssrMask > 0) {
    const threshold = input.roughnessFallbackThreshold ?? 1;
    if (input.roughness > threshold) {
      return { source: "probe", reason: "roughness-exceeds", weight: 0 };
    }
    return { source: "ssr", reason: "hit", weight: Math.min(1, Math.max(0, input.ssrMask)) };
  }
  if (input.extensionMask !== undefined && input.extensionMask > 0 && input.historyValid
    && (input.rayExtensionAvailable ?? false)) {
    return { source: "ray-extension", reason: "hit", weight: Math.min(1, input.extensionMask) };
  }
  if (!input.historyValid) {
    return { source: "probe", reason: "history-invalid", weight: 0 };
  }
  if (input.missReason !== undefined) {
    return { source: "probe", reason: input.missReason, weight: 0 };
  }
  return { source: "probe", reason: input.reflectedZ !== undefined && input.reflectedZ >= 0
    ? "reflected-behind" : "step-exhausted", weight: 0 };
}

/**
 * 帧级分档统计：对一帧的逐像素决策聚合计数。
 * misHit 计数由质量模块用参考判定喂入（这里只做纯聚合）。
 */
export interface SsrTierStats {
  readonly ssr: number;
  readonly rayExtension: number;
  readonly probe: number;
  readonly fallbackBase: number;
  readonly reasons: Readonly<Record<string, number>>;
}

export function aggregateSsrTiers(decisions: readonly SsrFallbackDecision[]): SsrTierStats {
  const tiers = { ssr: 0, rayExtension: 0, probe: 0, fallbackBase: 0 };
  const reasons: Record<string, number> = {};
  for (const decision of decisions) {
    if (decision.source === "ssr") tiers.ssr += 1;
    else if (decision.source === "ray-extension") tiers.rayExtension += 1;
    else if (decision.source === "probe") tiers.probe += 1;
    else tiers.fallbackBase += 1;
    reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }
  return { ...tiers, reasons };
}
