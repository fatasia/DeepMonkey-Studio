import type { JsonValue } from "./application.js";

export type IndustrialStudyType =
  | "plant-lite"
  | "what-if"
  | "workcell-audit"
  | "virtual-commissioning";

export type IndustrialStudyRunStatus =
  | "ready"
  | "running"
  | "cancelling"
  | "completed"
  | "passed"
  | "failed"
  | "cancelled"
  | "limited"
  | "insufficient-data";

export interface IndustrialStudyMetric {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
}

/**
 * 统一 Study 是现有求解结果的只读投影，不复制求解器结果。
 * null 表示旧记录没有该类证据，读取端必须明确展示缺失，不能推测补齐。
 */
export interface IndustrialStudyRecord {
  id: string;
  sourceRecordId: string;
  projectId: string;
  type: IndustrialStudyType;
  title: string;
  scenarioInput: JsonValue | null;
  context: {
    sceneId: string | null;
    objectIds: string[];
    modelId: string | null;
    modelVersion: string | null;
  };
  fingerprints: {
    input: string | null;
    scene: string | null;
    model: string | null;
    version: string | null;
    evidence: string | null;
  };
  execution: {
    engineId: string;
    engineVersion: string;
    deterministic: boolean;
  } | null;
  run: {
    status: IndustrialStudyRunStatus;
    cancellable: boolean;
  };
  result: {
    headline: string;
    metrics: IndustrialStudyMetric[];
    evidenceRefs: string[];
    completedAt: string | null;
  } | null;
  lineage: {
    baselineStudyId: string | null;
    reproductionOf: string | null;
  };
  reproduction: {
    kind: "rerun" | "open-workbench";
    operationsTab: "logistics" | "whatif" | "commissioning";
  };
  createdAt: string;
  updatedAt: string;
}
