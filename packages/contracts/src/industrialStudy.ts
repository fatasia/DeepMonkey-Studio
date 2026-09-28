import type { JsonValue } from "./application.js";
import type { SceneAssetRevisionSnapshot } from "./scene.js";

/** 已保存 PPR 版本中真正进入 Study 输入的实体；模型改动后不得继续声称已验证。 */
export interface IndustrialStudyPprBinding {
  planId: string;
  versionId: string;
  entities: Array<{ kind: "plan" | "component" | "operation" | "resource" | "precedence" | "assignment"; id: string; fields?: string[] }>;
  assets: Array<{ modelId: string; snapshot: SceneAssetRevisionSnapshot }>;
  sourceModelFingerprint: string;
}

export interface IndustrialStudyChangeImpactResult {
  studies: Array<{
    studyId: string;
    status: "fresh" | "stale" | "unknown";
    reasons: Array<{ code: "ppr-changed" | "asset-revised"; subject: string; message: string }>;
    baselineStudyId: string | null;
  }>;
  diagnostics: Array<{ code: "missing-binding" | "missing-study" | "duplicate-binding" | "invalid-binding" | "missing-entity" | "missing-asset" | "asset-revision-conflict" | "thread-link"; studyId?: string; message: string }>;
}


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
  /** 从权威运行记录投影；旧记录缺失时应显示未知。 */
  pprBinding?: IndustrialStudyPprBinding;
  createdAt: string;
  updatedAt: string;
}
