import type { DataSourceEvidence } from "./data.js";
import type {
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteSimulationLimits,
  PlantLiteTraceCaptureOptions,
} from "./plantLiteModel.js";

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
  source: "imported" | "studio-sample";
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
export interface UnityWebBuildProfile {
  compression: "brotli" | "gzip" | "decompression-fallback" | "uncompressed" | "mixed";
  runtimePayloadBytes: number;
  wasmBytes: number;
  dataBytes: number;
  runtimeFileCount: number;
  debugSymbols: boolean;
}
export interface UnityBuildManifestRecord {
  schemaVersion: 1;
  bridgeVersion: 1;
  playerUrl: string;
  unityVersion?: string;
  bridgePackageVersion?: string;
  webBuild?: UnityWebBuildProfile;
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

/**
 * Plant 工厂规划 Study 输入。model 是作者器提交的权威模型；旧客户端省略 model 时，
 * API 继续用 agv-line-v1 与两个兼容旋钮生成起步模型。
 */
export interface PlantLiteStudyRequest {
  name: string;
  templateId?: "agv-line-v1";
  model?: PlantLiteModel;
  /** @deprecated 仅用于没有 model 的旧模板请求。 */
  agvCount?: number;
  /** @deprecated 仅用于没有 model 的旧模板请求。 */
  bufferCapacity?: number;
  seed?: string | number;
  replications?: number;
  /** 通常由高级运行设置或精确复现填充。 */
  limits?: PlantLiteSimulationLimits;
  /** 代表性重复的有界事件轨迹；普通作者器无需展示。 */
  trace?: PlantLiteTraceCaptureOptions;
  /**
   * 同一基线派生的方案实验元数据。求解输入仍由 model/seed/limits 决定；
   * 该字段只负责把多次真实运行组织为可追溯的决策组。
   */
  comparison?: PlantLiteStudyComparison;
  /** 项目侧的验收阈值；不改变求解过程，但属于本次 Study 的决策证据。 */
  acceptanceTargets?: PlantLiteAcceptanceTargets;
}

export interface PlantLiteAcceptanceTargets {
  /** 项目需求、产能规划或合同条款等简短依据。 */
  basis?: string;
  minimumThroughputPerHour?: number;
  maximumAverageWip?: number;
  maximumAverageLeadTimeMinutes?: number;
  maximumEnergyPerCompletedItemKwh?: number;
  maximumElectricityCostPerCompletedItem?: number;
  maximumCarbonEmissionPerCompletedItemKg?: number;
}

export interface PlantLiteStudyComparison {
  groupId: string;
  baselineStudyId: string;
  parameterLabel: string;
  candidateLabel: string;
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
  /** 旧持久化记录可能没有节点级统计。 */
  nodeMetrics95?: Record<string, PlantLiteNodeMetricConfidence>;
  resourceUtilization95: Record<string, PlantLiteConfidenceInterval>;
  /** 资源故障容量损失（台·分钟）；单资源时与停机分钟相同，旧记录可能没有。 */
  resourceFailedMinutes95?: Record<string, PlantLiteConfidenceInterval>;
  /** 仅在模型配置了真实功率与能源经济参数时生成；旧记录可能没有。 */
  energy?: PlantLiteStudyEnergyOutcome;
  /** 配置产品组合时生成；用于核对每类产品的完成占比与吞吐。 */
  productTypeMetrics95?: Record<string, PlantLiteProductTypeMetricConfidence>;
  /** 配置有限生产订单时生成；准交率以计划数量为分母。 */
  productionOrderMetrics95?: Record<string, PlantLiteProductionOrderMetricConfidence>;
  /** 至少一个工位显式配置良率时生成；旧记录可能没有。 */
  quality?: PlantLiteStudyQualityOutcome;
  bottlenecks: PlantLiteBottleneckFrequency[];
}

export interface PlantLiteStationQualityMetricConfidence {
  inspectedItems: PlantLiteConfidenceInterval;
  goodItems: PlantLiteConfidenceInterval;
  scrapItems: PlantLiteConfidenceInterval;
  firstPassYield: PlantLiteConfidenceInterval;
}

export interface PlantLiteStudyQualityOutcome {
  /** 正式统计窗口内到达成品端的合格件，与 completedItems 口径一致。 */
  goodOutputItems: PlantLiteConfidenceInterval;
  /** 正式统计窗口内在任一配置良率工位被判废并退出系统的工件。 */
  scrapItems: PlantLiteConfidenceInterval;
  /** goodOutputItems / (goodOutputItems + scrapItems)，未处置在制品不进入分母。 */
  firstPassYield: PlantLiteConfidenceInterval;
  stationMetrics95: Record<string, PlantLiteStationQualityMetricConfidence>;
}

export interface PlantLiteProductTypeMetricConfidence {
  completedItems: PlantLiteConfidenceInterval;
  completionShare: PlantLiteConfidenceInterval;
  throughputPerHour: PlantLiteConfidenceInterval;
}

export interface PlantLiteProductionOrderMetricConfidence {
  completedItems: PlantLiteConfidenceInterval;
  completionRate: PlantLiteConfidenceInterval;
  onTimeFulfillmentRate: PlantLiteConfidenceInterval;
  /** 在各重复中订单全部完成的比例。 */
  fullyCompletedRate: PlantLiteConfidenceInterval;
  /** 完成时按末件完工计算；未完成时按仿真终点计算当前观测拖期。 */
  observedTardinessMinutes: PlantLiteConfidenceInterval;
}

export interface PlantLiteStudyEnergyOutcome {
  activeEnergyKwh: PlantLiteConfidenceInterval;
  idleEnergyKwh: PlantLiteConfidenceInterval;
  totalEnergyKwh: PlantLiteConfidenceInterval;
  energyPerCompletedItemKwh: PlantLiteConfidenceInterval;
  electricityCost: PlantLiteConfidenceInterval;
  electricityCostPerCompletedItem: PlantLiteConfidenceInterval;
  carbonEmissionKg: PlantLiteConfidenceInterval;
  carbonEmissionPerCompletedItemKg: PlantLiteConfidenceInterval;
  peakDemandKw: PlantLiteConfidenceInterval;
  /** 工位或共享资源 ID -> 总电量 95% 区间。 */
  consumerEnergyKwh: Record<string, PlantLiteConfidenceInterval>;
}

export interface PlantLiteNodeMetricConfidence {
  utilization: PlantLiteConfidenceInterval;
  averageQueueLength: PlantLiteConfidenceInterval;
  blockedMinutes: PlantLiteConfidenceInterval;
  starvedMinutes: PlantLiteConfidenceInterval;
  /** 新版混流模型生成；旧记录或未配置换型时可能没有。 */
  changeoverCount?: PlantLiteConfidenceInterval;
  /** 新版混流模型生成；单位分钟。 */
  changeoverMinutes?: PlantLiteConfidenceInterval;
}

export interface PlantLiteStudyRecord extends Required<Pick<PlantLiteStudyRequest, "name">> {
  id: string;
  projectId: string;
  createdAt: string;
  templateId: "agv-line-v1";
  /** 新记录保存实际执行的完整模型快照；旧记录通过模板兼容字段复现。 */
  model?: PlantLiteModel;
  modelFingerprint?: string;
  agvCount?: number;
  bufferCapacity?: number;
  seed: string | number;
  replications: number;
  /**
   * 一个代表性重复的有界真实 DES 轨迹。旧记录可能没有；`GET /operations`
   * 为控制首屏负载只在最新记录中返回，历史权威记录与 run/reproduce 响应仍保留。
   */
  trace?: PlantLiteReplicationTrace;
  comparison?: PlantLiteStudyComparison;
  acceptanceTargets?: PlantLiteAcceptanceTargets;
  reproductionOf?: string;
  inputFingerprint: string;
  outcome: PlantLiteStudyOutcome;
  execution: {
    engineId: "plant-lite-des";
    engineVersion: "1.0.0";
    inputFingerprint: string;
    deterministic: true;
    limits: {
      /** 从空系统开始的总运行时长，包含预热期。 */
      durationMinutes: number;
      /** 旧记录省略时按 0 分钟解释。 */
      warmupMinutes?: number;
      maxEvents: number;
      maxResources: number;
    };
    /** 新记录保存实际轨迹采集参数；旧记录可从 trace 本身恢复。 */
    trace?: Required<PlantLiteTraceCaptureOptions>;
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
