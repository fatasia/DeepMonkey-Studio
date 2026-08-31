import type { JsonValue } from "./application.js";

export type IndustrialValidationStudyType = "workcell-audit" | "virtual-commissioning";

export interface IndustrialValidationStudyExecution {
  engineId: string;
  engineVersion: string;
  inputFingerprint: string;
  deterministic: boolean;
}

export interface IndustrialValidationStudyContext {
  sceneFingerprint?: string;
  modelFingerprint?: string;
  versionFingerprint?: string;
  modelId?: string;
  modelVersion?: string;
}

/**
 * 轻量工业验证任务卡。
 * 它只负责把诊断目标、场景对象和最近一次确定性结果串起来，不承担工艺规划或审批职责。
 */
export interface IndustrialValidationStudyRecord {
  id: string;
  projectId: string;
  revision: number;
  title: string;
  sourceKind: "maintenance-diagnosis" | "workcell-audit" | "manual";
  /** 新记录必须显式区分工位体检与虚拟调试；旧任务卡可由 sourceKind 兼容推断。 */
  studyType?: IndustrialValidationStudyType;
  sourceRefs: string[];
  sceneId?: string;
  objectIds: string[];
  objective: string;
  acceptanceCriteria: string[];
  scenarioInput?: JsonValue;
  execution?: IndustrialValidationStudyExecution;
  context?: IndustrialValidationStudyContext;
  baselineStudyId?: string;
  reproductionOf?: string;
  status: "ready" | "passed" | "failed";
  latestResult?: IndustrialValidationStudyResult;
  createdAt: string;
  updatedAt: string;
}

export interface IndustrialValidationStudyResult {
  status: "passed" | "failed";
  scenarioId: string;
  evidenceFingerprint: string;
  failureCount: number;
  completedAt: string;
}

/** expectedRevision 用于阻止旧页面静默覆盖更新后的任务卡。 */
export interface SaveIndustrialValidationStudyInput {
  id?: string;
  expectedRevision?: number;
  title?: string;
  sourceKind?: IndustrialValidationStudyRecord["sourceKind"];
  studyType?: IndustrialValidationStudyType;
  sourceRefs?: string[];
  sceneId?: string;
  objectIds?: string[];
  objective?: string;
  acceptanceCriteria?: string[];
  scenarioInput?: JsonValue;
  execution?: Omit<IndustrialValidationStudyExecution, "inputFingerprint"> & { inputFingerprint?: string };
  context?: IndustrialValidationStudyContext;
  baselineStudyId?: string;
  reproductionOf?: string;
  latestResult?: IndustrialValidationStudyResult;
}
