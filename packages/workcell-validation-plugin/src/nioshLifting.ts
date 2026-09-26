import type {
  NioshDurationCategory,
  NioshLiftingFactors,
  NioshLiftingScore,
  NioshMultiplierSet,
} from "@bim-studio/contracts";

/**
 * 修订版 NIOSH 提举方程(Waters, Putz-Anderson & Garg, 1994;NIOSH Publication 94-110)。
 * 全部常量取自该手册公制公式与表 5/表 7;输出为规划筛查参考,不是认证结论。
 */

export const NIOSH_LOAD_CONSTANT_KG = 23;
const HORIZONTAL_REFERENCE_CM = 25;
const VERTICAL_REFERENCE_CM = 75;
const ASYMMETRY_COEFFICIENT = 0.0032;
const DISTANCE_COEFFICIENT_CM = 4.5;

/** 手册 13.13 节:H ≤ 25cm 取 HM=1;H > 63cm HM=0(载荷为零)。 */
export const NIOSH_H_MAX_CM = 63;
/** 手册 13.1 节:V > 175cm(70 in)VM=0。 */
export const NIOSH_V_MAX_CM = 175;
/** 手册 13.3 节:D < 25cm 按 25cm 处理;D > 175cm DM=0。 */
export const NIOSH_D_MIN_CM = 25;
export const NIOSH_D_MAX_CM = 175;
/** 手册 13.4 节:A > 135° AM=0(载荷为零)。 */
export const NIOSH_A_MAX_DEG = 135;
/** 表 5:频率上限 15 次/分,超过则 FM=0;低于 0.2 按 0.2 处理。 */
export const NIOSH_F_MAX_PER_MIN = 15;
export const NIOSH_F_MIN_PER_MIN = 0.2;

/** 表 5 频率行(次/分钟);≤0.2 为首行,未列出的频率向上取行(保守侧)。 */
const FM_FREQUENCY_ROWS = [0.2, 0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;

/**
 * FM 表(94-110 Table 5):FM_ROWS[i] = [≤1h V<75, ≤1h V≥75, 1-2h V<75, 1-2h V≥75, 2-8h V<75, 2-8h V≥75]。
 * 数值经 1994 原书第 26 页扫描件与 Waters 2012 章节 Table 33.5 两处逐值核对一致。
 */
const FM_TABLE: readonly (readonly [number, number, number, number, number, number])[] = [
  [1.0, 1.0, 0.95, 0.95, 0.85, 0.85],
  [0.97, 0.97, 0.92, 0.92, 0.81, 0.81],
  [0.94, 0.94, 0.88, 0.88, 0.75, 0.75],
  [0.91, 0.91, 0.84, 0.84, 0.65, 0.65],
  [0.88, 0.88, 0.79, 0.79, 0.55, 0.55],
  [0.84, 0.84, 0.72, 0.72, 0.45, 0.45],
  [0.8, 0.8, 0.6, 0.6, 0.35, 0.35],
  [0.75, 0.75, 0.5, 0.5, 0.27, 0.27],
  [0.7, 0.7, 0.42, 0.42, 0.22, 0.22],
  [0.6, 0.6, 0.35, 0.35, 0.18, 0.18],
  [0.52, 0.52, 0.3, 0.3, 0.0, 0.15],
  [0.45, 0.45, 0.26, 0.26, 0.0, 0.13],
  [0.41, 0.41, 0.0, 0.23, 0.0, 0.0],
  [0.37, 0.37, 0.0, 0.21, 0.0, 0.0],
  [0.0, 0.34, 0.0, 0.0, 0.0, 0.0],
  [0.0, 0.31, 0.0, 0.0, 0.0, 0.0],
  [0.0, 0.28, 0.0, 0.0, 0.0, 0.0],
];

/** 表 7 耦合乘数:low = V<75cm,high = V≥75cm。 */
const CM_TABLE = {
  good: { low: 1.0, high: 1.0 },
  fair: { low: 0.95, high: 1.0 },
  poor: { low: 0.9, high: 0.9 },
} as const;

const NIOSH_NOTE =
  "NIOSH 1994 修订版提举方程(94-110)公制口径;RWL/LI 为规划筛查参考,不是法规或认证结论。耦合未判定时按 fair 处理。";

/** 确定性计算 RWL 与 LI;输入非有限或为负时抛错,官方禁止组合返回 RWL=0、LI=null。 */
export function computeNioshLifting(factors: NioshLiftingFactors): NioshLiftingScore {
  const { loadMassKg, horizontalCm, verticalOriginCm, travelCm, asymmetryDeg, liftsPerMinute, durationCategory, coupling } = factors;
  requireFinite("loadMassKg", loadMassKg, 0, 1000);
  requireFinite("horizontalCm", horizontalCm, 0, 500);
  requireFinite("verticalOriginCm", verticalOriginCm, 0, 500);
  requireFinite("travelCm", travelCm, 0, 500);
  requireFinite("asymmetryDeg", asymmetryDeg, 0, 360);
  requireFinite("liftsPerMinute", liftsPerMinute, 0, 1000);

  const prohibited = collectProhibitions(horizontalCm, verticalOriginCm, travelCm, asymmetryDeg, liftsPerMinute);
  if (prohibited.length) {
    return {
      standard: "NIOSH-1994",
      multipliers: { hm: 0, vm: 0, dm: 0, am: 0, fm: 0, cm: 0 },
      recommendedWeightLimitKg: 0,
      liftingIndex: null,
      prohibitedReason: prohibited.join("；"),
      note: NIOSH_NOTE,
    };
  }

  const hm = horizontalCm <= HORIZONTAL_REFERENCE_CM ? 1 : HORIZONTAL_REFERENCE_CM / horizontalCm;
  const vm = 1 - 0.003 * Math.abs(verticalOriginCm - VERTICAL_REFERENCE_CM);
  const effectiveTravelCm = Math.max(travelCm, NIOSH_D_MIN_CM);
  const dm = 0.82 + DISTANCE_COEFFICIENT_CM / effectiveTravelCm;
  const am = 1 - ASYMMETRY_COEFFICIENT * asymmetryDeg;
  const fm = lookupFrequencyMultiplier(liftsPerMinute, durationCategory, verticalOriginCm);
  const cm = lookupCouplingMultiplier(coupling, verticalOriginCm);
  const multipliers: NioshMultiplierSet = { hm: round(hm, 4), vm: round(vm, 4), dm: round(dm, 4), am: round(am, 4), fm, cm };
  // RWL 取两位小数后参与 LI 计算,与手册工作表"先取整再相除"的算术一致(35/28.0=1.25→1.3)。
  const recommendedWeightLimitKg = round(NIOSH_LOAD_CONSTANT_KG * hm * vm * dm * am * fm * cm, 2);
  if (recommendedWeightLimitKg <= 0) {
    return {
      standard: "NIOSH-1994",
      multipliers,
      recommendedWeightLimitKg: 0,
      liftingIndex: null,
      prohibitedReason: prohibited.length
        ? prohibited.join("；")
        : "官方 FM 表该频率/时长/手高组合为 0(如长时程低手位高频提举),RWL 记 0",
      note: NIOSH_NOTE,
    };
  }
  return {
    standard: "NIOSH-1994",
    multipliers,
    recommendedWeightLimitKg,
    liftingIndex: round(loadMassKg / recommendedWeightLimitKg, 2),
    note: NIOSH_NOTE,
  };
}

function collectProhibitions(
  horizontalCm: number,
  verticalOriginCm: number,
  travelCm: number,
  asymmetryDeg: number,
  liftsPerMinute: number,
): string[] {
  const reasons: string[] = [];
  if (horizontalCm > NIOSH_H_MAX_CM) reasons.push(`H=${horizontalCm}cm 超过 ${NIOSH_H_MAX_CM}cm,官方 HM=0`);
  if (verticalOriginCm > NIOSH_V_MAX_CM) reasons.push(`V=${verticalOriginCm}cm 超过 ${NIOSH_V_MAX_CM}cm,官方 VM=0`);
  if (travelCm > NIOSH_D_MAX_CM) reasons.push(`D=${travelCm}cm 超过 ${NIOSH_D_MAX_CM}cm,官方 DM=0`);
  if (asymmetryDeg > NIOSH_A_MAX_DEG) reasons.push(`A=${asymmetryDeg}° 超过 ${NIOSH_A_MAX_DEG}°,官方 AM=0`);
  if (liftsPerMinute > NIOSH_F_MAX_PER_MIN) reasons.push(`F=${liftsPerMinute}次/分 超过 ${NIOSH_F_MAX_PER_MIN},官方 FM=0`);
  return reasons;
}

function lookupFrequencyMultiplier(liftsPerMinute: number, duration: NioshDurationCategory, verticalOriginCm: number): number {
  const effectiveFrequency = Math.max(liftsPerMinute, NIOSH_F_MIN_PER_MIN);
  if (effectiveFrequency > NIOSH_F_MAX_PER_MIN) return 0;
  let rowIndex = FM_FREQUENCY_ROWS.findIndex((row) => effectiveFrequency <= row);
  if (rowIndex < 0) rowIndex = FM_FREQUENCY_ROWS.length - 1;
  const columnIndex = columnFor(duration, verticalOriginCm);
  return FM_TABLE[rowIndex]![columnIndex]!;
}

function columnFor(duration: NioshDurationCategory, verticalOriginCm: number): number {
  const highHands = verticalOriginCm >= VERTICAL_REFERENCE_CM ? 1 : 0;
  switch (duration) {
    case "short": return highHands;
    case "moderate": return 2 + highHands;
    case "long": return 4 + highHands;
  }
}

function lookupCouplingMultiplier(coupling: "good" | "fair" | "poor", verticalOriginCm: number): number {
  const entry = CM_TABLE[coupling];
  return verticalOriginCm >= VERTICAL_REFERENCE_CM ? entry.high : entry.low;
}

function requireFinite(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`NIOSH 输入 ${name}=${value} 超出可校验范围 [${minimum}, ${maximum}]`);
  }
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

export function formatNioshMultiplierSet(multipliers: NioshMultiplierSet): string {
  return `HM=${multipliers.hm} VM=${multipliers.vm} DM=${multipliers.dm} AM=${multipliers.am} FM=${multipliers.fm} CM=${multipliers.cm}`;
}
