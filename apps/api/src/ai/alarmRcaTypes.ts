export type AlarmSeverity = "info" | "warning" | "critical";
export type RcaConfidenceBand = "insufficient" | "low" | "medium" | "high";

export interface AlarmRcaInput {
  schemaVersion: 1;
  asset: { id: string; name: string; type?: string; criticality?: "low" | "medium" | "high" };
  alarm: {
    id: string;
    code: string;
    label: string;
    severity: AlarmSeverity;
    triggeredAt: string;
    source: string;
  };
  window: { startAt: string; endAt: string };
  events: AlarmWindowEvent[];
  anomalies: AlarmMeasurementAnomaly[];
  maintenanceHistory: AlarmMaintenanceRecord[];
}

export interface AlarmWindowEvent {
  id: string;
  assetId?: string;
  kind: "state-change" | "interlock" | "operator-action" | "communication" | "process" | "alarm";
  code: string;
  label: string;
  occurredAt: string;
  source: string;
  qualityScore?: number;
}

export interface AlarmMeasurementAnomaly {
  id: string;
  assetId?: string;
  signal: string;
  label: string;
  observedAt: string;
  direction: "high" | "low" | "change" | "flatline" | "missing";
  deviationScore: number;
  quality: "valid" | "suspect" | "invalid";
  qualityScore: number;
  source: string;
  observedValue?: number;
  baselineValue?: number;
  unit?: string;
}

export interface AlarmMaintenanceRecord {
  id: string;
  assetId: string;
  category: "inspection" | "repair" | "replacement" | "lubrication" | "calibration" | "configuration";
  summary: string;
  status: "planned" | "in-progress" | "completed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  affectedSignals?: string[];
}

export interface RcaEvidenceItem {
  id: string;
  kind: "alarm" | "event" | "measurement" | "maintenance";
  label: string;
  source: string;
  observedAt: string;
  reliability: number;
  temporalProximity: number;
  contribution: number;
}

export interface RcaCauseCandidate {
  id: string;
  rank: number;
  title: string;
  score: number;
  confidence: RcaConfidenceBand;
  status: "hypothesis";
  statement: string;
  evidence: RcaEvidenceItem[];
  missingEvidence: string[];
}

export interface RcaValidationStep {
  id: string;
  candidateId: string;
  priority: "now" | "next" | "observe";
  title: string;
  instruction: string;
  acceptanceCriterion: string;
  requiresHuman: true;
}

export interface RcaWorkOrderDraft {
  id: string;
  status: "draft";
  title: string;
  priority: "low" | "medium" | "high";
  assetId: string;
  alarmId: string;
  summary: string;
  checklist: string[];
  requiresConfirmation: true;
  closePolicy: "human-only";
  evidenceFingerprint: string;
}

export interface AlarmRcaResult {
  schemaVersion: 1;
  generatedBy: "deterministic-alarm-rca";
  decisionStatus: "investigation-required" | "monitor" | "insufficient-data";
  confidence: number;
  confidenceBand: RcaConfidenceBand;
  candidates: RcaCauseCandidate[];
  missingEvidence: string[];
  validationSteps: RcaValidationStep[];
  workOrderDraft: RcaWorkOrderDraft;
  excludedRecordIds: string[];
  limitations: string[];
  evidenceFingerprint: string;
}

export interface AlarmRcaExplanationEnvelope {
  instructions: string;
  input: string;
  evidenceFingerprint: string;
}

