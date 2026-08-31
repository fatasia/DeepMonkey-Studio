import type { MaintenanceAssessmentRecord } from "./operations.js";

/** 设备上下文只保留诊断、定位和后续验证需要的最小语义。 */
export interface IndustrialDiagnosisAssetContext {
  id: string;
  name: string;
  sceneId?: string;
  objectIds: string[];
}

export interface IndustrialDiagnosisModelContext {
  id: string;
  name: string;
  version: string;
  algorithm: string;
  modelKind: string;
  benchmarkOnly: boolean;
  productionEligible: boolean;
}

export interface IndustrialDiagnosisInput {
  assessment: MaintenanceAssessmentRecord;
  model: IndustrialDiagnosisModelContext;
  asset?: IndustrialDiagnosisAssetContext;
}

export interface IndustrialDiagnosisHypothesis {
  id: string;
  rank: number;
  title: string;
  rationale: string;
  evidence: string[];
  /** 诊断假设必须经过点检或仿真验证，不能伪装成已确认根因。 */
  status: "candidate";
}

export interface IndustrialDiagnosisAction {
  id: string;
  kind: "inspect" | "validate-data" | "simulate" | "create-case" | "monitor";
  priority: "now" | "next" | "observe";
  label: string;
  reason: string;
}

export interface IndustrialDiagnosisValidationDraft {
  sourceAssessmentId: string;
  objective: string;
  signals: string[];
  acceptanceCriteria: string[];
  sceneId?: string;
  objectId?: string;
}

export interface IndustrialSemanticNode {
  id: string;
  kind: "asset" | "signal" | "model" | "assessment" | "evidence";
  label: string;
}

export interface IndustrialSemanticEdge {
  from: string;
  to: string;
  relation: "observes" | "assessed-by" | "derived-from" | "located-in";
}

export interface IndustrialDiagnosisResult {
  generatedBy: "industrial-diagnosis-plugin";
  reasoningMode: "evidence-orchestration";
  severity: MaintenanceAssessmentRecord["riskLevel"];
  decisionStatus: MaintenanceAssessmentRecord["decisionStatus"];
  confidence: number;
  headline: string;
  summary: string;
  facts: string[];
  hypotheses: IndustrialDiagnosisHypothesis[];
  actions: IndustrialDiagnosisAction[];
  validationDraft: IndustrialDiagnosisValidationDraft;
  semanticGraph: {
    nodes: IndustrialSemanticNode[];
    edges: IndustrialSemanticEdge[];
  };
  limitations: string[];
  evidenceFingerprint: string;
}
