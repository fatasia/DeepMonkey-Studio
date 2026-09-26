/**
 * 百分位人体档案(ANSUR-II 口径)。
 *
 * 数据性质声明:近似,非医学级。
 * - 身高统计取 ANSUR II(Gordon et al. 2014, TR-15-034)公开汇总的整数化引用值;
 * - 其余节段按公开综述的经典节段比例(Drillis & Contini 1966 等)对身高线性近似,
 *   不是 ANSUR II 原表逐项测量值;
 * - 百分位换算用正态假设 value = mean + z·sd,是工效学筛查惯例,不适用于尾端个体。
 * 仅可用于规划初筛与人因参考,不得用于医学、法务或认证结论。
 */

export type HumanPercentileStandard = "ANSUR-II";
export type HumanPercentileRank = 1 | 5 | 50 | 95 | 99;
export type HumanSex = "male" | "female";

/** 立姿节段尺寸(mm);key 即含义,全部为身高派生量。 */
export type HumanSegmentKey =
  | "statureMm"
  | "eyeHeightMm"
  | "shoulderHeightMm"
  | "elbowHeightMm"
  | "hipHeightMm"
  | "knuckleHeightMm"
  | "functionalReachMm";

export interface HumanPercentileFigure {
  standard: HumanPercentileStandard;
  percentile: HumanPercentileRank;
  sex: HumanSex;
  segmentLengthsMm: Record<HumanSegmentKey, number>;
}

/** 生成器随结果附带的数据性质声明(近似,非医学级)。 */
export const HUMAN_PERCENTILE_FIGURE_NOTE =
  "近似,非医学级:ANSUR II 身高公开统计(Gordon et al. 2014)+ 经典节段比例线性近似,仅用于规划筛查。";

export const HUMAN_PERCENTILE_RANKS = [1, 5, 50, 95, 99] as const;

/** 标准正态分位数(常用百分位,4 位小数近似;统计常数表)。 */
const NORMAL_QUANTILE_Z: Record<HumanPercentileRank, number> = {
  1: -2.3263,
  5: -1.6449,
  50: 0,
  95: 1.6449,
  99: 2.3263,
};

/** ANSUR II 身高公开汇总统计(均值/标准差,mm;整数化近似引用值)。 */
const ANSUR2_STATURE_MM: Record<HumanSex, { mean: number; sd: number }> = {
  male: { mean: 1756, sd: 67 },
  female: { mean: 1629, sd: 64 },
};

/** 立姿节段与身高之比(公开综述经典比例,线性近似;不含身高本身)。 */
const SEGMENT_STATURE_RATIO: Record<Exclude<HumanSegmentKey, "statureMm">, number> = {
  eyeHeightMm: 0.936,
  shoulderHeightMm: 0.818,
  elbowHeightMm: 0.63,
  hipHeightMm: 0.53,
  knuckleHeightMm: 0.377,
  functionalReachMm: 0.44,
};

export function isHumanPercentileRank(value: unknown): value is HumanPercentileRank {
  return typeof value === "number" && Number.isInteger(value) && (HUMAN_PERCENTILE_RANKS as readonly number[]).includes(value);
}

export function isHumanSex(value: unknown): value is HumanSex {
  return value === "male" || value === "female";
}

/**
 * 确定性生成一份百分位人体档案:同入参永远得到逐毫米一致的结果。
 * 非法入参直接抛错,保证输出永远落在合同枚举内。
 */
export function buildHumanPercentileFigure(percentile: HumanPercentileRank, sex: HumanSex): HumanPercentileFigure {
  if (!isHumanPercentileRank(percentile)) throw new Error(`百分位必须是 ${HUMAN_PERCENTILE_RANKS.join("/")} 之一,收到:${String(percentile)}`);
  if (!isHumanSex(sex)) throw new Error(`sex 必须是 male/female,收到:${String(sex)}`);
  const z = NORMAL_QUANTILE_Z[percentile];
  const { mean, sd } = ANSUR2_STATURE_MM[sex];
  const statureMm = mean + z * sd;
  const segmentLengthsMm = { statureMm: roundMm(statureMm) } as Record<HumanSegmentKey, number>;
  for (const [key, ratio] of Object.entries(SEGMENT_STATURE_RATIO)) {
    segmentLengthsMm[key as Exclude<HumanSegmentKey, "statureMm">] = roundMm(statureMm * ratio);
  }
  return { standard: "ANSUR-II", percentile, sex, segmentLengthsMm };
}

function roundMm(value: number): number {
  return Math.round(value);
}
