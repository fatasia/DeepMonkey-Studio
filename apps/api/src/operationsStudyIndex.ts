import type {
  IndustrialStudyRecord,
  IndustrialStudyType,
  IndustrialValidationStudyRecord,
  JsonValue,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";
import type { WhatIfStudyRecord } from "@bim-studio/studio-core";
import { evidenceFingerprint } from "./operationsEngine.js";

interface StudySources {
  plantLiteStudies: PlantLiteStudyRecord[];
  validationStudies: IndustrialValidationStudyRecord[];
  whatIfStudies: WhatIfStudyRecord[];
}

/** 从各求解器的权威记录派生统一索引，避免重复持久化结果造成漂移。 */
export function buildOperationsStudyIndex(source: StudySources): IndustrialStudyRecord[] {
  return [
    ...source.plantLiteStudies.map(fromPlantLite),
    ...source.whatIfStudies.map(fromWhatIf),
    ...source.validationStudies.map(fromValidationStudy),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function fromPlantLite(source: PlantLiteStudyRecord): IndustrialStudyRecord {
  const type = "plant-lite" as const;
  const versionFingerprint = executionVersionFingerprint(source.execution);
  const outcomeFingerprint = evidenceFingerprint({ input: source.inputFingerprint, outcome: source.outcome });
  return {
    id: studyId(type, source.id),
    sourceRecordId: source.id,
    projectId: source.projectId,
    type,
    title: source.name,
    scenarioInput: {
      templateId: source.templateId,
      agvCount: source.agvCount,
      bufferCapacity: source.bufferCapacity,
      seed: source.seed,
      replications: source.replications,
    },
    context: emptyContext(),
    fingerprints: {
      input: source.inputFingerprint,
      scene: null,
      model: null,
      version: versionFingerprint,
      evidence: outcomeFingerprint,
    },
    execution: execution(source.execution),
    run: { status: source.outcome.status, cancellable: false },
    result: {
      headline: source.outcome.message ?? `完成 ${source.outcome.completedReplications} 次有效重复`,
      metrics: [
        metric("throughput", "平均产出", source.outcome.throughputPerHour.mean, "/h"),
        metric("wip", "平均在制品", source.outcome.averageWip.mean),
        metric("lead-time", "平均交付周期", source.outcome.averageLeadTimeMinutes.mean, "min"),
      ],
      evidenceRefs: [source.inputFingerprint, outcomeFingerprint],
      completedAt: source.createdAt,
    },
    lineage: lineage(type, source.reproductionOf),
    reproduction: { kind: "rerun", operationsTab: "logistics" },
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
  };
}

function fromWhatIf(source: WhatIfStudyRecord): IndustrialStudyRecord {
  const type = "what-if" as const;
  const executionValue = source.execution ?? null;
  return {
    id: studyId(type, source.id),
    sourceRecordId: source.id,
    projectId: source.projectId,
    type,
    title: source.name,
    scenarioInput: structuredClone(source.input) as unknown as JsonValue,
    context: emptyContext(),
    fingerprints: {
      input: executionValue?.inputFingerprint ?? source.result.inputFingerprint,
      scene: null,
      model: null,
      version: executionValue ? executionVersionFingerprint(executionValue) : null,
      evidence: source.result.evidenceFingerprint,
    },
    execution: executionValue ? execution(executionValue) : null,
    run: { status: "completed", cancellable: false },
    result: {
      headline: `风险 ${riskLabel(source.result.risk.level)} · 可信度 ${source.result.confidence.level}`,
      metrics: [
        metric("risk", "风险", riskLabel(source.result.risk.level)),
        metric("confidence", "可信度", source.result.confidence.score),
        ...source.result.predictions.slice(0, 3).map((item) =>
          metric(item.metricId, item.metricId, item.predictedValue, item.unit),
        ),
      ],
      evidenceRefs: [source.result.inputFingerprint, source.result.evidenceFingerprint],
      completedAt: source.createdAt,
    },
    lineage: lineage(type, source.reproductionOf),
    reproduction: { kind: "rerun", operationsTab: "whatif" },
    createdAt: source.createdAt,
    updatedAt: source.createdAt,
  };
}

function fromValidationStudy(source: IndustrialValidationStudyRecord): IndustrialStudyRecord {
  const type = validationType(source);
  const completed = source.latestResult;
  return {
    id: studyId(type, source.id),
    sourceRecordId: source.id,
    projectId: source.projectId,
    type,
    title: source.title,
    scenarioInput: source.scenarioInput === undefined ? null : structuredClone(source.scenarioInput),
    context: {
      sceneId: source.sceneId ?? null,
      objectIds: [...source.objectIds],
      modelId: source.context?.modelId ?? null,
      modelVersion: source.context?.modelVersion ?? null,
    },
    fingerprints: {
      input: source.execution?.inputFingerprint ?? null,
      scene: source.context?.sceneFingerprint ?? null,
      model: source.context?.modelFingerprint ?? null,
      version: source.context?.versionFingerprint ?? (source.execution ? executionVersionFingerprint(source.execution) : null),
      evidence: completed?.evidenceFingerprint ?? null,
    },
    execution: source.execution ? execution(source.execution) : null,
    run: { status: source.status, cancellable: false },
    result: completed ? {
      headline: completed.status === "passed" ? "验收通过" : `${completed.failureCount} 项未通过`,
      metrics: [metric("failures", "未通过项", completed.failureCount)],
      evidenceRefs: compactRefs([...source.sourceRefs, completed.evidenceFingerprint]),
      completedAt: completed.completedAt,
    } : null,
    lineage: {
      baselineStudyId: linkedStudyId(type, source.baselineStudyId),
      reproductionOf: linkedStudyId(type, source.reproductionOf),
    },
    reproduction: { kind: "open-workbench", operationsTab: "commissioning" },
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

function validationType(source: IndustrialValidationStudyRecord): Extract<IndustrialStudyType, "workcell-audit" | "virtual-commissioning"> {
  if (source.studyType) return source.studyType;
  // 旧版 manual/maintenance-diagnosis 任务卡只从虚拟调试台创建和复核；仅在统一索引中兼容归类，不补造其缺失证据。
  return source.sourceKind === "workcell-audit" ? "workcell-audit" : "virtual-commissioning";
}

function execution(value: { engineId: string; engineVersion: string; deterministic: boolean }) {
  return { engineId: value.engineId, engineVersion: value.engineVersion, deterministic: value.deterministic };
}

function executionVersionFingerprint(value: { engineId: string; engineVersion: string }): string {
  return evidenceFingerprint({ engineId: value.engineId, engineVersion: value.engineVersion });
}

function emptyContext(): IndustrialStudyRecord["context"] {
  return { sceneId: null, objectIds: [], modelId: null, modelVersion: null };
}

function metric(key: string, label: string, value: string | number, unit?: string) {
  return { key, label, value, ...(unit ? { unit } : {}) };
}

function lineage(type: IndustrialStudyType, reproductionOf?: string): IndustrialStudyRecord["lineage"] {
  const linked = linkedStudyId(type, reproductionOf);
  return { baselineStudyId: linked, reproductionOf: linked };
}

function linkedStudyId(type: IndustrialStudyType, sourceId?: string): string | null {
  return sourceId ? studyId(type, sourceId) : null;
}

function studyId(type: IndustrialStudyType, sourceId: string): string {
  return `${type}:${sourceId}`;
}

function compactRefs(refs: string[]): string[] {
  return [...new Set(refs.map((item) => item.trim()).filter(Boolean))];
}

function riskLabel(level: WhatIfStudyRecord["result"]["risk"]["level"]): string {
  return ({ low: "低", medium: "中", high: "高", critical: "严重" })[level];
}
