import type {
  PlantLiteConfidenceInterval,
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteStudyRecord,
  PlantLiteTraceCaptureOptions,
  PlantLiteTraceEvent,
} from "@bim-studio/contracts";
import { createEvidenceFingerprint, EVIDENCE_FINGERPRINT_ALGORITHM } from "@bim-studio/studio-core";

export const PLANT_LITE_EVIDENCE_SCHEMA = "bim-studio.plant-lite-engineering-evidence.v1" as const;

interface StudyLineageReference {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  inputFingerprint: string;
  modelFingerprint: string | null;
  recordFingerprint: string;
  reproductionOf: string | null;
  comparison: PlantLiteStudyRecord["comparison"] | null;
}

export interface PlantLiteEvidencePackage {
  schema: typeof PLANT_LITE_EVIDENCE_SCHEMA;
  generatedBy: "DeepMonkey Studio";
  exportedAt: string;
  packageId: string;
  units: { time: "minute"; throughput: "item-per-hour"; energy: "kilowatt-hour"; carbon: "kilogram-co2e"; currency: "CNY" };
  lineage: {
    study: StudyLineageReference;
    baseline: StudyLineageReference | null;
    baselineRelationship: "reproduction-source" | "comparison-baseline" | "selected-reference" | "not-provided";
  };
  traceability: {
    fingerprintAlgorithm: typeof EVIDENCE_FINGERPRINT_ALGORITHM;
    packageFingerprint: string;
    declaredInputFingerprint: string;
    executionInputFingerprint: string;
    inputFingerprintConsistent: boolean;
    declaredModelFingerprint: string | null;
    modelSnapshotFingerprint: string | null;
  };
  run: {
    templateId: PlantLiteStudyRecord["templateId"];
    legacyTemplateParameters: { agvCount: number | null; bufferCapacity: number | null };
    engineId: PlantLiteStudyRecord["execution"]["engineId"];
    engineVersion: string;
    deterministicEngine: boolean;
    seed: string | number;
    requestedReplications: number;
    completedReplications: number;
    outcomeStatus: PlantLiteStudyRecord["outcome"]["status"];
    outcomeMessage: string | null;
    window: { totalMinutes: number; warmupMinutes: number; measuredMinutes: number };
    limits: { maxEvents: number; maxResources: number };
  };
  modelSnapshot: PlantLiteModel | null;
  acceptanceTargets: PlantLiteStudyRecord["acceptanceTargets"] | null;
  statistics: {
    system: {
      throughputPerHour: PlantLiteConfidenceInterval;
      averageWip: PlantLiteConfidenceInterval;
      averageLeadTimeMinutes: PlantLiteConfidenceInterval;
    };
    nodeMetrics95: PlantLiteStudyRecord["outcome"]["nodeMetrics95"] | null;
    resourceUtilization95: PlantLiteStudyRecord["outcome"]["resourceUtilization95"];
    resourceFailedMinutes95: PlantLiteStudyRecord["outcome"]["resourceFailedMinutes95"] | null;
    productTypeMetrics95: PlantLiteStudyRecord["outcome"]["productTypeMetrics95"] | null;
    productionOrderMetrics95: PlantLiteStudyRecord["outcome"]["productionOrderMetrics95"] | null;
    changeovers: {
      configuredRules: Array<{ stationId: string; stationName: string; fromProductTypeId: string; toProductTypeId: string; minutes: number }>;
      nodeMetrics95: Record<string, { changeoverCount?: PlantLiteConfidenceInterval; changeoverMinutes?: PlantLiteConfidenceInterval }>;
      capturedEvents: PlantLiteTraceEvent[];
    };
    quality: {
      metrics95: PlantLiteStudyRecord["outcome"]["quality"] | null;
      configuredStations: Array<{ stationId: string; stationName: string; yieldRate: number }>;
      capturedScrapEvents: PlantLiteTraceEvent[];
      firstPassYieldDefinition: string;
      reworkIncluded: false;
    };
    energy: PlantLiteStudyRecord["outcome"]["energy"] | null;
    bottlenecks: PlantLiteStudyRecord["outcome"]["bottlenecks"];
  };
  trace: {
    capture: (Required<PlantLiteTraceCaptureOptions> & { source: "execution-record" | "trace-snapshot" }) | null;
    integrity: {
      status: "captured-within-scope" | "truncated" | "missing";
      representativeReplicationOnly: true;
      fullStudyEventHistory: false;
      configurationMatchesSnapshot: boolean | null;
      capturedEventCount: number;
      capturedItemCount: number;
      omittedEventCount: number;
      declaration: string;
    };
    snapshot: PlantLiteReplicationTrace | null;
  };
  evidenceAvailability: {
    modelSnapshot: boolean;
    declaredModelFingerprint: boolean;
    nodeMetrics: boolean;
    productMetrics: boolean;
    productionOrderMetrics: boolean;
    qualityMetrics: boolean;
    energyMetrics: boolean;
    representativeTrace: boolean;
  };
  capabilityBoundary: {
    purpose: "plant-lite-engineering-evidence-handoff";
    statisticalDiscreteEventEvidence: true;
    precisePhysicalSimulation: false;
    certifiedEngineeringConclusion: false;
    productionDispatchable: false;
    tamperProofSignature: false;
    declaration: string;
    notIncluded: string[];
  };
}

export function buildPlantLiteEvidencePackage(
  study: PlantLiteStudyRecord,
  baseline?: PlantLiteStudyRecord,
  exportedAt = new Date().toISOString(),
): PlantLiteEvidencePackage {
  if (Number.isNaN(Date.parse(exportedAt))) throw new Error("工程证据包导出时间无效");
  if (containsNonFiniteNumber({ study, baseline })) throw new Error("Study 证据包含非有限数值，不能无损导出");

  const modelSnapshot = study.model ? structuredClone(study.model) : null;
  const traceSnapshot = study.trace ? structuredClone(study.trace) : null;
  const executionCapture = study.execution.trace;
  const fallbackCapture = traceSnapshot
    ? { replication: traceSnapshot.replication, maxEvents: traceSnapshot.limits.maxEvents, maxItems: traceSnapshot.limits.maxItems }
    : undefined;
  const rawCapture = executionCapture ?? fallbackCapture;
  const capture = rawCapture
    ? { ...rawCapture, source: executionCapture ? "execution-record" as const : "trace-snapshot" as const }
    : null;
  const window = {
    totalMinutes: study.execution.limits.durationMinutes,
    warmupMinutes: study.execution.limits.warmupMinutes ?? 0,
    measuredMinutes: Math.max(0, study.execution.limits.durationMinutes - (study.execution.limits.warmupMinutes ?? 0)),
  };

  const evidence = {
    units: { time: "minute", throughput: "item-per-hour", energy: "kilowatt-hour", carbon: "kilogram-co2e", currency: "CNY" } as const,
    lineage: {
      study: lineageReference(study),
      baseline: baseline ? lineageReference(baseline) : null,
      baselineRelationship: baselineRelationship(study, baseline),
    },
    traceability: {
      fingerprintAlgorithm: EVIDENCE_FINGERPRINT_ALGORITHM,
      declaredInputFingerprint: study.inputFingerprint,
      executionInputFingerprint: study.execution.inputFingerprint,
      inputFingerprintConsistent: study.inputFingerprint === study.execution.inputFingerprint,
      declaredModelFingerprint: study.modelFingerprint ?? null,
      modelSnapshotFingerprint: modelSnapshot ? createEvidenceFingerprint(modelSnapshot) : null,
    },
    run: {
      templateId: study.templateId,
      legacyTemplateParameters: { agvCount: study.agvCount ?? null, bufferCapacity: study.bufferCapacity ?? null },
      engineId: study.execution.engineId,
      engineVersion: study.execution.engineVersion,
      deterministicEngine: study.execution.deterministic,
      seed: study.seed,
      requestedReplications: study.replications,
      completedReplications: study.outcome.completedReplications,
      outcomeStatus: study.outcome.status,
      outcomeMessage: study.outcome.message ?? null,
      window,
      limits: { maxEvents: study.execution.limits.maxEvents, maxResources: study.execution.limits.maxResources },
    },
    modelSnapshot,
    acceptanceTargets: study.acceptanceTargets ? structuredClone(study.acceptanceTargets) : null,
    statistics: buildStatistics(study, traceSnapshot),
    trace: {
      capture,
      integrity: traceIntegrity(traceSnapshot, capture),
      snapshot: traceSnapshot,
    },
    evidenceAvailability: {
      modelSnapshot: Boolean(modelSnapshot),
      declaredModelFingerprint: Boolean(study.modelFingerprint),
      nodeMetrics: Boolean(study.outcome.nodeMetrics95),
      productMetrics: Boolean(study.outcome.productTypeMetrics95),
      productionOrderMetrics: Boolean(study.outcome.productionOrderMetrics95),
      qualityMetrics: Boolean(study.outcome.quality),
      energyMetrics: Boolean(study.outcome.energy),
      representativeTrace: Boolean(traceSnapshot),
    },
    capabilityBoundary: capabilityBoundary(),
  };
  const packageFingerprint = createEvidenceFingerprint({ schema: PLANT_LITE_EVIDENCE_SCHEMA, ...evidence });
  return {
    schema: PLANT_LITE_EVIDENCE_SCHEMA,
    generatedBy: "DeepMonkey Studio",
    exportedAt: new Date(exportedAt).toISOString(),
    packageId: `plant-lite-evidence:${packageFingerprint.slice(-16)}`,
    ...evidence,
    traceability: { ...evidence.traceability, packageFingerprint },
  };
}

export function serializePlantLiteEvidencePackage(value: PlantLiteEvidencePackage): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function plantLiteEvidenceFileStem(value: PlantLiteEvidencePackage): string {
  const name = safeFilePart(value.lineage.study.name, "study");
  return `bim-studio-plant-${name}-${value.traceability.packageFingerprint.slice(-12)}`;
}

function lineageReference(study: PlantLiteStudyRecord): StudyLineageReference {
  return {
    id: study.id,
    projectId: study.projectId,
    name: study.name,
    createdAt: study.createdAt,
    inputFingerprint: study.inputFingerprint,
    modelFingerprint: study.modelFingerprint ?? null,
    recordFingerprint: createEvidenceFingerprint(study),
    reproductionOf: study.reproductionOf ?? null,
    comparison: study.comparison ? structuredClone(study.comparison) : null,
  };
}

function baselineRelationship(study: PlantLiteStudyRecord, baseline?: PlantLiteStudyRecord): PlantLiteEvidencePackage["lineage"]["baselineRelationship"] {
  if (!baseline) return "not-provided";
  if (study.reproductionOf === baseline.id) return "reproduction-source";
  if (study.comparison?.baselineStudyId === baseline.id) return "comparison-baseline";
  return "selected-reference";
}

function buildStatistics(study: PlantLiteStudyRecord, trace: PlantLiteReplicationTrace | null): PlantLiteEvidencePackage["statistics"] {
  const nodeMetrics95 = study.outcome.nodeMetrics95 ? structuredClone(study.outcome.nodeMetrics95) : null;
  const changeoverNodeMetrics = Object.fromEntries(Object.entries(nodeMetrics95 ?? {}).flatMap(([nodeId, metric]) => {
    if (!metric.changeoverCount && !metric.changeoverMinutes) return [];
    return [[nodeId, {
      ...(metric.changeoverCount ? { changeoverCount: metric.changeoverCount } : {}),
      ...(metric.changeoverMinutes ? { changeoverMinutes: metric.changeoverMinutes } : {}),
    }]];
  }));
  const configuredRules = (study.model?.nodes ?? []).flatMap((node) => node.kind === "station"
    ? (node.changeovers ?? []).map((rule) => ({ stationId: node.id, stationName: node.name, ...structuredClone(rule) }))
    : []);
  return {
    system: {
      throughputPerHour: structuredClone(study.outcome.throughputPerHour),
      averageWip: structuredClone(study.outcome.averageWip),
      averageLeadTimeMinutes: structuredClone(study.outcome.averageLeadTimeMinutes),
    },
    nodeMetrics95,
    resourceUtilization95: structuredClone(study.outcome.resourceUtilization95),
    resourceFailedMinutes95: study.outcome.resourceFailedMinutes95 ? structuredClone(study.outcome.resourceFailedMinutes95) : null,
    productTypeMetrics95: study.outcome.productTypeMetrics95 ? structuredClone(study.outcome.productTypeMetrics95) : null,
    productionOrderMetrics95: study.outcome.productionOrderMetrics95 ? structuredClone(study.outcome.productionOrderMetrics95) : null,
    changeovers: {
      configuredRules,
      nodeMetrics95: changeoverNodeMetrics,
      capturedEvents: (trace?.events ?? []).filter((event) => event.type === "item-changeover-start" || event.type === "item-changeover-complete").map((event) => structuredClone(event)),
    },
    quality: {
      metrics95: study.outcome.quality ? structuredClone(study.outcome.quality) : null,
      configuredStations: (study.model?.nodes ?? []).flatMap((node) => node.kind === "station" && node.yieldRate !== undefined
        ? [{ stationId: node.id, stationName: node.name, yieldRate: node.yieldRate }]
        : []),
      capturedScrapEvents: (trace?.events ?? []).filter((event) => event.type === "item-scrap").map((event) => structuredClone(event)),
      firstPassYieldDefinition: "正式统计窗口内合格产出 /（合格产出 + 工位报废）；未处置在制品不进入分母。",
      reworkIncluded: false,
    },
    energy: study.outcome.energy ? structuredClone(study.outcome.energy) : null,
    bottlenecks: structuredClone(study.outcome.bottlenecks),
  };
}

function traceIntegrity(trace: PlantLiteReplicationTrace | null, capture: PlantLiteEvidencePackage["trace"]["capture"]): PlantLiteEvidencePackage["trace"]["integrity"] {
  if (!trace) return {
    status: "missing", representativeReplicationOnly: true, fullStudyEventHistory: false,
    configurationMatchesSnapshot: null, capturedEventCount: 0, capturedItemCount: 0, omittedEventCount: 0,
    declaration: "当前记录没有代表性重复的事件轨迹；统计区间仍来自已完成重复，但不能回放事件历史。",
  };
  const matches = capture !== null
    && capture.replication === trace.replication
    && capture.maxEvents === trace.limits.maxEvents
    && capture.maxItems === trace.limits.maxItems;
  const truncated = trace.truncated || trace.omittedEventCount > 0;
  return {
    status: truncated ? "truncated" : "captured-within-scope",
    representativeReplicationOnly: true,
    fullStudyEventHistory: false,
    configurationMatchesSnapshot: matches,
    capturedEventCount: trace.events.length,
    capturedItemCount: trace.capturedItemCount,
    omittedEventCount: trace.omittedEventCount,
    declaration: truncated
      ? "代表性重复的有界轨迹已截断；统计结果不受导出裁剪影响，但轨迹不得解释为完整事件历史。"
      : "轨迹在配置的代表性重复采集范围内完整；它不等同于全部重复的完整事件历史。",
  };
}

function capabilityBoundary(): PlantLiteEvidencePackage["capabilityBoundary"] {
  return {
    purpose: "plant-lite-engineering-evidence-handoff",
    statisticalDiscreteEventEvidence: true,
    precisePhysicalSimulation: false,
    certifiedEngineeringConclusion: false,
    productionDispatchable: false,
    tamperProofSignature: false,
    declaration: "该文件用于交付 Plant Lite 离散事件 Study 的输入快照、统计区间与有界轨迹证据，不是精确物理仿真、认证结论、生产调度指令或防篡改签名。",
    notIncluded: [
      "三维刚体、柔性体、流体、热力或控制器级精确物理求解",
      "安全、人体工效、设备能力或法规符合性的认证结论",
      "PLC/机器人程序、MES 排产指令或现场自动下发",
      "报废后的返工、维修、降级使用或质量成本闭环",
      "数字签名、时间戳认证、不可抵赖审计或第三方见证",
    ],
  };
}

function safeFilePart(value: string, fallback: string): string {
  const safe = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/[. ]+$/g, "").slice(0, 48);
  return safe || fallback;
}

function containsNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFiniteNumber);
  if (value && typeof value === "object") return Object.values(value).some(containsNonFiniteNumber);
  return false;
}
