import type { DataSourceEvidence } from "./data.js";

/**
 * 工业运营领域合同：预测维护、Unity 资源版本、运营案例、物流实验与能耗分析。
 * 这里只描述稳定数据边界，不承载运行时实现。
 */

export type MaintenanceModelKind = "failure-probability" | "rul" | "regression" | "anomaly";
export type MaintenanceModelEngine = "native-json" | "onnx";

export interface MaintenanceModelArtifact {
  engine: MaintenanceModelEngine;
  modelKind: MaintenanceModelKind;
  features: string[];
  means?: number[];
  stds?: number[];
  featureMeans?: number[];
  featureStds?: number[];
  weights?: number[];
  bias?: number;
  outputMean?: number;
  outputStd?: number;
  residualP90?: number;
  decisionThreshold?: number;
  labelColumn?: string;
  targetColumn?: string;
  targetUnit?: string;
  window?: number;
  inputShape?: Array<number | null>;
  inputName?: string;
  outputName?: string;
  outputIndex?: number;
  inputNormalization?: boolean;
  outputTransform?: "identity" | "sigmoid" | "class1" | "anomaly-score";
}

export interface MaintenanceModelGates {
  minimumSamples: number;
  minimumDataQuality: number;
  maximumDriftSigma: number;
  warningThreshold: number;
  criticalThreshold: number;
  scoreDirection: "high-risk" | "low-risk";
}

export interface MaintenanceModelPackage {
  id: string;
  projectId: string;
  name: string;
  version: string;
  algorithm: string;
  source: "iot-nb" | "imported" | "studio-sample";
  status: "awaiting-artifact" | "candidate" | "validated" | "retired";
  benchmarkOnly: boolean;
  productionEligible: boolean;
  evaluationProtocol: string;
  dataFingerprint: string;
  trainRows: number;
  validationRows: number;
  metrics: Record<string, number>;
  artifact: MaintenanceModelArtifact;
  artifactPath?: string;
  gates: MaintenanceModelGates;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UnityBuildDataLayer {
  key: string;
  description?: string;
  keyField?: string;
  target?: string;
}
export interface UnityBuildObject {
  id: string;
  name?: string;
  path?: string;
  tags?: string[];
}
export interface UnityBuildProperty {
  key: string;
  label?: string;
  type: "string" | "number" | "boolean" | "color" | "select";
  target?: string;
  options?: string[];
}
export type UnityRuntimeCapability = "ack" | "heartbeat" | "data-layers" | "properties" | "actions" | "events";
export interface UnityBuildManifestRecord {
  schemaVersion: 1;
  bridgeVersion: 1;
  playerUrl: string;
  unityVersion?: string;
  scenes?: string[];
  events?: string[];
  dataLayers?: UnityBuildDataLayer[];
  objects?: UnityBuildObject[];
  actions?: string[];
  properties?: UnityBuildProperty[];
  runtimeCapabilities?: UnityRuntimeCapability[];
}
export interface UnityResourceVersionRecord {
  id: string;
  resourceId: string;
  version: number;
  sourceFileName: string;
  contentHash: string;
  size: number;
  fileCount: number;
  playerUrl: string;
  manifestUrl: string;
  manifest: UnityBuildManifestRecord;
  diagnostics: string[];
  createdAt: string;
}
export interface UnityResourceRecord {
  id: string;
  projectId: string;
  name: string;
  activeVersionId: string;
  versions: UnityResourceVersionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceDeploymentRecord {
  id: string;
  projectId: string;
  name: string;
  modelId: string;
  equipmentId: string;
  maintainableUnitId: string;
  sceneId?: string;
  objectIds: string[];
  sourceId: string;
  /** 统一 AI 数据绑定；旧部署可继续只使用 sourceId 与采样参数。 */
  bindingId?: string;
  featureMappings: Record<string, string>;
  sampleIntervalSec: number;
  windowSize: number;
  enabled: boolean;
  status: "stopped" | "shadow" | "running" | "degraded" | "error";
  lastAssessmentId?: string;
  lastRunAt?: string;
  lastError?: string;
  consecutiveFailures?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MaintenanceAssessmentRecord {
  id: string;
  projectId: string;
  deploymentId: string;
  modelId: string;
  modelVersion: string;
  generatedAt: string;
  decisionStatus: "insufficient-data" | "drift-blocked" | "shadow" | "validated";
  score?: number;
  riskLevel: "unknown" | "normal" | "warning" | "critical";
  dataQuality: number;
  driftScore: number;
  sampleCount: number;
  topContributors: Array<{ feature: string; value: number }>;
  message: string;
  evidenceFingerprint: string;
  /** 现场数据集运行时写入，便于复核模型究竟读取了哪一路数据。 */
  sourceEvidence?: DataSourceEvidence;
}

export interface MaintenanceShadowEvaluation {
  id: string;
  projectId: string;
  modelId: string;
  createdAt: string;
  samples: number;
  positives: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
  falseAlarmsPerThousand: number;
  leadSamples?: number;
  leadHours?: number;
  threshold: number;
  passed: boolean;
  fingerprint: string;
}

export interface OperationalCaseRecord {
  id: string;
  projectId: string;
  type: "maintenance" | "quality" | "energy" | "logistics";
  title: string;
  severity: "info" | "warning" | "critical";
  status: "triage" | "confirmed" | "assigned" | "resolved" | "dismissed";
  owner: string;
  objectRefs: string[];
  sourceRefs: string[];
  hypothesis: string[];
  suggestedActions: string[];
  externalRef?: string;
  outcome?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LogisticsExperimentRequest {
  name: string;
  agvCount: number;
  bufferCapacity: number;
  demandPerHour: number;
  cycleTimeSec: number;
  chargingMinutesPerHour: number;
  congestionFactor: number;
  durationHours: number;
}

export interface LogisticsExperimentResult extends LogisticsExperimentRequest {
  id: string;
  projectId: string;
  createdAt: string;
  /** 精确复现生成的新记录保留来源，便于追溯而不覆盖原始结果。 */
  reproductionOf?: string;
  throughputPerHour: number;
  fulfilledRate: number;
  utilization: number;
  averageWip: number;
  leadTimeMinutes: number;
  bottleneck: "transport" | "buffer" | "demand";
  recommendation: string;
  fingerprint: string;
  /**
   * 固定引擎与输入证据用于复现、对比和审计，不能只依赖页面显示的参数。
   * 旧版持久化记录可能没有该字段，读取端必须明确标为“缺少证据”，不能伪造补齐。
   */
  execution?: {
    engineId: "factory-flow-analytic";
    engineVersion: "1.0.0";
    inputFingerprint: string;
    deterministic: true;
  };
}

/** Plant Lite 仅暴露已校准的产线模板与少量可解释旋钮，不把 DES 内部拓扑暴露给普通运营用户。 */
export interface PlantLiteStudyRequest {
  name: string;
  templateId?: "agv-line-v1";
  agvCount?: number;
  bufferCapacity?: number;
  seed?: string | number;
  replications?: number;
}

export interface PlantLiteConfidenceInterval {
  mean: number;
  sampleStandardDeviation: number;
  lower95: number;
  upper95: number;
  samples: number;
}

export interface PlantLiteBottleneckFrequency {
  nodeId: string;
  occurrences: number;
  probability: number;
}

export interface PlantLiteStudyOutcome {
  status: "completed" | "limited" | "cancelled" | "insufficient-data";
  message?: string;
  completedReplications: number;
  throughputPerHour: PlantLiteConfidenceInterval;
  averageWip: PlantLiteConfidenceInterval;
  averageLeadTimeMinutes: PlantLiteConfidenceInterval;
  resourceUtilization95: Record<string, PlantLiteConfidenceInterval>;
  bottlenecks: PlantLiteBottleneckFrequency[];
}

export interface PlantLiteStudyRecord extends Required<Pick<PlantLiteStudyRequest, "name">> {
  id: string;
  projectId: string;
  createdAt: string;
  templateId: "agv-line-v1";
  agvCount: number;
  bufferCapacity: number;
  seed: string | number;
  replications: number;
  reproductionOf?: string;
  inputFingerprint: string;
  outcome: PlantLiteStudyOutcome;
  execution: {
    engineId: "plant-lite-des";
    engineVersion: "1.0.0";
    inputFingerprint: string;
    deterministic: true;
    limits: { durationMinutes: number; maxEvents: number; maxResources: number };
  };
}

export interface EnergyObservation {
  timestamp: string;
  output: number;
  energyKwh: number;
  idleMinutes?: number;
}

export interface EnergyInsightRecord {
  id: string;
  projectId: string;
  createdAt: string;
  samples: number;
  baselineKwhPerUnit: number;
  currentKwhPerUnit: number;
  deviationPercent: number;
  avoidableKwh: number;
  severity: "normal" | "warning" | "critical";
  recommendations: string[];
  evidenceFingerprint: string;
}
