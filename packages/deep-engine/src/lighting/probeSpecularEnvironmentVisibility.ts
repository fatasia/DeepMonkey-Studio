/**
 * Rejected F5 brightness-ratio candidate, retained only for regression counterexamples.
 *
 * This is NOT geometric/specular visibility and is not exported by lighting/index.ts or
 * consumed by the production shader. Probe capture averages first-hit Lambert radiance
 * plus ambient misses, not directional specular visibility. Identical RGB/alpha can
 * therefore describe a dark unoccluded surface or an occluded bright one. Cascade
 * mixing also makes alpha fractional; local reflection radiance has separate provenance.
 *
 * == F5 方案 A（2026-10-03 用户批准）之后的地位 ==
 * 被撤的「全域标量乘子」不回归；但同一比值算术以**受限形态**回到生产：仅在探针
 * words[12..23] RGB L1 SH 缺失（旧捕获/未启用 moments 变体）时作为该探针的 fallback
 * 门（WGSL deepGiSpecularLevelGate 内联，不引用本函数）。其「暗 albedo × 无遮挡 ≡
 * 白 albedo × 遮挡」不可辨识局限随之保留在 fallback 路径上，主路径为方向重建。
 * 合同：docs/specs/f5-directional-l1-implementation-20261003.md；本文件保留原始算术
 * 作为可复现反例证据，仍是 deprecated、不得从绿灯算术测试复活为全域合同。
 */
export type GiRgb = readonly [number, number, number];

export interface GiSample {
  readonly rgb: GiRgb;
  readonly a: number;
}

export const GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON = 0.0001;
const LUMA_WEIGHTS: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];

function luma(value: GiRgb): number {
  return Math.max(value[0], 0) * LUMA_WEIGHTS[0]
    + Math.max(value[1], 0) * LUMA_WEIGHTS[1]
    + Math.max(value[2], 0) * LUMA_WEIGHTS[2];
}

/** @deprecated Rejected brightness heuristic; diagnostics/tests only, never a visibility contract. */
export function probeSpecularEnvironmentVisibility(environmentIrradiance: GiRgb, gi: GiSample): number {
  if (!(gi.a > 0)) return 1;
  const envLuma = luma(environmentIrradiance);
  if (!(envLuma > GI_SPECULAR_ENVIRONMENT_VISIBILITY_LUMA_EPSILON)) return 1;
  return Math.min(1, Math.max(0, luma(gi.rgb) / envLuma));
}
