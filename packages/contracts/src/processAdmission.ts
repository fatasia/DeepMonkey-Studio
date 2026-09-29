import type {
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
} from "./ppr.js";

/**
 * 非线性工艺映射准入（C2）合同。
 *
 * 准入表把 BOP 工艺里的非线性结构逐项映射或显式拒绝：凡 mapped-review/blocked
 * 结论必带稳定机器可读理由码（拒绝矩阵纪律），不做静默线性化。
 * 与 web 侧 PPR→PlantLite 草稿准入保持同一结论词汇，双端可对账。
 */

/** 准入结论：direct=等价表达；mapped-review=映射已建立但关键参数是占位，须人工确认；blocked=无等价表达。 */
export type ProcessAdmissionVerdict = "direct" | "mapped-review" | "blocked";

/** 准入表逐行覆盖的结构语义：顺序基线 + 四类非线性结构（分流/AND 汇合/联合占用/滞后，含白名单外联合占用的拒绝行）。 */
export type ProcessAdmissionStructure =
  | "sequential-flow"
  | "branch-split"
  | "and-join-convergence"
  | "joint-equipment-worker"
  | "multi-resource-atomic-lock"
  | "minimum-lag";

/** 理由码：mapped-review/blocked 行的拒绝理由码沿用 PPR→PlantLite 复核词汇；direct 行携带身份码便于逐项对账。 */
export type ProcessAdmissionReasonCode =
  | "sequential-direct"
  | "multiple-successors"
  | "multiple-predecessors"
  | "joint-occupancy-whitelist"
  | "multiple-resources"
  | "minimum-lag";

/** 准入评估输入：BOP 版本/草稿中与结构判定相关的投影（避免把整个版本合同耦合进准入层）。 */
export interface ProcessAdmissionPlan {
  planId: string;
  versionId: string;
  operations: PprOperation[];
  precedenceRelations: PprPrecedenceRelation[];
  resources: PprResource[];
  resourceAssignments: PprOperationResourceAssignment[];
}

/** 准入表逐行结论。 */
export interface ProcessAdmissionEntry {
  structure: ProcessAdmissionStructure;
  verdict: ProcessAdmissionVerdict;
  reasonCode: ProcessAdmissionReasonCode;
  /** 人工可读结论：映射口径或阻断级人工重建指引。 */
  message: string;
  /** 涉及的工序/前置关系/资源分配 ID，逐项对账用。 */
  subjectIds: string[];
}

export interface ProcessAdmissionCounts {
  total: number;
  direct: number;
  mappedReview: number;
  blocked: number;
}

export interface ProcessAdmissionReport {
  planId: string;
  versionId: string;
  entries: ProcessAdmissionEntry[];
  counts: ProcessAdmissionCounts;
  /**
   * fail-closed 门：仅当准入表全 direct（含顺序基线行）才允许正式预测。
   * mapped-review 的占位参数（如分流份额）与 blocked 的无等价表达结构都使本值为 false。
   */
  formalPredictionAllowed: boolean;
  /** 阻断正式预测的结论码（去重，按 entries 出现序）。 */
  blockingReasonCodes: ProcessAdmissionReasonCode[];
}
