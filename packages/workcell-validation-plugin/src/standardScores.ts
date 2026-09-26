import type {
  HumanPercentileFigure,
  NioshDurationCategory,
  NioshLiftingFactors,
  NioshLiftingScore,
  OwasPostureInput,
  OwasPostureScore,
  Vector3Value,
} from "@bim-studio/contracts";
import { buildHumanPercentileFigure } from "@bim-studio/contracts";
import { computeNioshLifting } from "./nioshLifting.js";
import { classifyOwasPosture } from "./owasPosture.js";

/**
 * 标准分数层装配:把可选输入(百分位人体/任务因子/姿态编码)推导成完整因子并评分。
 * 推导不出完整因子时直接不输出该分数(诚实缺口),不编造默认值。
 */

export interface ErgonomicsStandardScoreOptions {
  /** 百分位人体档(近似,非医学级);缺省 V 时用指关节高推导提举起点参考。 */
  humanFigure?: HumanPercentileFigure;
  /** NIOSH 任务变量;缺省字段按 场景作业点/任务参数 推导,推导不了则不输出 NIOSH。 */
  nioshLifting?: Partial<NioshLiftingFactors>;
  /** OWAS 姿态四元组;载荷缺省取任务载荷,再缺省按未知载荷归最重组。 */
  owasPosture?: Omit<OwasPostureInput, "loadMassKg"> & { loadMassKg?: number };
}

export interface StandardScoreContext {
  workPoint?: Vector3Value;
  operatorPosition?: Vector3Value;
  /** 操作员到作业点的水平距离,m。 */
  horizontalReachMeters?: number;
  taskLoadMassKg?: number;
  repetitionsPerHour?: number;
  durationMinutes?: number;
}

export interface StandardScoreAttachments {
  nioshLifting?: NioshLiftingScore;
  owasPosture?: OwasPostureScore;
  humanFigureApplied?: HumanPercentileFigure;
}

export function buildStandardScoreAttachments(
  context: StandardScoreContext,
  options: ErgonomicsStandardScoreOptions,
): StandardScoreAttachments {
  const humanFigure = resolveHumanFigure(options.humanFigure);
  const nioshLifting = options.nioshLifting ? resolveNioshScore(context, options.nioshLifting, humanFigure) : undefined;
  let owasPosture: OwasPostureScore | undefined;
  if (options.owasPosture) {
    const owasLoadKg = options.owasPosture.loadMassKg ?? context.taskLoadMassKg;
    owasPosture = classifyOwasPosture(
      owasLoadKg === undefined ? options.owasPosture : { ...options.owasPosture, loadMassKg: owasLoadKg },
    );
  }
  return {
    ...(nioshLifting ? { nioshLifting } : {}),
    ...(owasPosture ? { owasPosture } : {}),
    ...(humanFigure ? { humanFigureApplied: humanFigure } : {}),
  };
}

function resolveHumanFigure(figure: HumanPercentileFigure | undefined): HumanPercentileFigure | undefined {
  return figure;
}

function resolveNioshScore(
  context: StandardScoreContext,
  partial: Partial<NioshLiftingFactors>,
  humanFigure?: HumanPercentileFigure,
): NioshLiftingScore | undefined {
  const loadMassKg = partial.loadMassKg ?? context.taskLoadMassKg;
  if (loadMassKg === undefined) return undefined;
  const verticalOriginCm = partial.verticalOriginCm ?? deriveVerticalOriginCm(context, humanFigure);
  const horizontalCm = partial.horizontalCm ?? deriveHorizontalCm(context);
  const liftsPerMinute = partial.liftsPerMinute ?? (context.repetitionsPerHour !== undefined ? context.repetitionsPerHour / 60 : undefined);
  const durationCategory = partial.durationCategory ?? deriveDurationCategory(context.durationMinutes);
  const travelCm = partial.travelCm;
  // 行程 D 没有可辩护的场景默认值:不显式提供就不输出 NIOSH,而不是编一个 D。
  if (verticalOriginCm === undefined || horizontalCm === undefined || liftsPerMinute === undefined || durationCategory === undefined || travelCm === undefined) {
    return undefined;
  }
  const factors: NioshLiftingFactors = {
    loadMassKg,
    horizontalCm,
    verticalOriginCm,
    travelCm,
    asymmetryDeg: partial.asymmetryDeg ?? 0,
    liftsPerMinute,
    durationCategory,
    coupling: partial.coupling ?? "fair",
  };
  return computeNioshLifting(factors);
}

function deriveVerticalOriginCm(context: StandardScoreContext, humanFigure?: HumanPercentileFigure): number | undefined {
  const { workPoint, operatorPosition } = context;
  if (workPoint && operatorPosition) return (workPoint.y - operatorPosition.y) * 100;
  // 无作业点时退化为所选百分位人体的指关节高(立姿提举起点经典参考,近似)。
  if (humanFigure) return humanFigure.segmentLengthsMm.knuckleHeightMm / 10;
  return undefined;
}

function deriveHorizontalCm(context: StandardScoreContext): number | undefined {
  return context.horizontalReachMeters !== undefined ? context.horizontalReachMeters * 100 : undefined;
}

function deriveDurationCategory(durationMinutes: number | undefined): NioshDurationCategory | undefined {
  if (durationMinutes === undefined) return undefined;
  if (durationMinutes <= 60) return "short";
  if (durationMinutes <= 120) return "moderate";
  if (durationMinutes <= 480) return "long";
  return undefined; // 超过 8 小时官方不提供限值。
}

/** 便捷入口:按标准/百分位/性别生成档案(透传 contracts 生成器)。 */
export function createHumanPercentileFigure(standard: "ANSUR-II", percentile: 1 | 5 | 50 | 95 | 99, sex: "male" | "female"): HumanPercentileFigure {
  if (standard !== "ANSUR-II") throw new Error(`仅支持 ANSUR-II 口径,收到:${String(standard)}`);
  return buildHumanPercentileFigure(percentile, sex);
}
