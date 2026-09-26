/**
 * MTM 工时分解合同(P0-B 线平衡增强)。
 * 只表达"MTM 代码 → 应用次数 → 分钟数"的分解结果与固定值覆盖;
 * MTM 数据卡(code→minutes 的标准值表)受版权限制不随包分发,
 * 由调用方按所购数据集提供,本合同不内置任何代码库数值。
 */

/** MTM 体系变体;同一份分解内允许混排,但推导口径由调用方保证一致。 */
export type MtmCodeVariant = "MTM-1" | "MTM-UAS" | "MTM-2";

/** 一条 MTM 代码应用:同一代码在工序内的重复次数 × 每次应用分钟数。 */
export interface MtmCodeApplicationEntry {
  /** MTM 代码字面量(如 "M10G1");数值语义查调用方提供的数据卡。 */
  code: string;
  /** 该代码在本工序内的应用次数,≥1 的整数。 */
  count: number;
  /** 每次应用的分钟数,来自调用方数据卡;本包不校验其与官方数据卡的一致性。 */
  minutesPerApplication: number;
  variant?: MtmCodeVariant;
}

/** 一个工序的 MTM 分解申请;标准工时 = Σ(minutesPerApplication×count) + 固定值。 */
export interface MtmCodeApplication {
  operationId: string;
  codes: MtmCodeApplicationEntry[];
  /** 与代码无关的固定附加工时(装夹、程序启动等),不参与代码求和。 */
  overrides?: {
    setupMinutes?: number;
    processingMinutes?: number;
  };
}
