import type { PlantLiteModel, PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { plantLiteEffectiveCapacity } from "@bim-studio/plant-lite-simulation";

export interface PlantLiteBottleneckSweep {
  bottleneckName: string;
  parameterLabel: string;
  candidateLabels: string[];
  requests: PlantLiteStudyRequest[];
}

export interface PlantLiteSingleVariableSweep {
  subjectName: string;
  parameterLabel: string;
  candidateLabels: string[];
  requests: PlantLiteStudyRequest[];
}

interface PlantLiteSingleVariableSweepInput {
  study: PlantLiteStudyRecord;
  subjectName: string;
  parameterLabel: string;
  groupId: string;
  values: number[];
  update: (value: number) => PlantLiteModel;
  label: (value: number) => string;
}

/**
 * 从已保存的瓶颈证据派生两个单变量方案；保持 seed、重复次数与运行上限一致，
 * 使候选方案和基线采用共同随机数，避免把随机波动误当成改善。
 */
export function createPlantLiteBottleneckSweep(study: PlantLiteStudyRecord): PlantLiteBottleneckSweep | undefined {
  const model = study.model;
  const bottleneck = study.outcome.bottlenecks[0];
  if (!model || !bottleneck) return undefined;
  const node = model.nodes.find((candidate) => candidate.id === bottleneck.nodeId);
  if (!node) return undefined;

  if (node.kind === "station") {
    const equipment = node.resourceId ? model.resources?.find((candidate) => candidate.id === node.resourceId) : undefined;
    if (node.resourceId && (!equipment || equipment.kind !== "equipment")) return undefined;
    const base = plantLiteEffectiveCapacity(model, node);
    const currentResourceUnits = model.resources?.reduce((sum, candidate) => sum + candidate.capacity, 0) ?? 0;
    const values = [base + 1, base + 2].filter((value) => {
      if (value > 100 || !equipment) return value <= 100;
      return currentResourceUnits - equipment.capacity + Math.max(equipment.capacity, value) <= study.execution.limits.maxResources;
    });
    if (!values.length) return undefined;
    return equipment
      ? sweep(study, node.name, "工位有效并行能力", values, (value) => raiseStationEffectiveCapacity(model, node.id, value), (value) => `${value} 路有效并行`)
      : sweep(study, node.name, "并行工位数", values, (value) => updateNode(model, node.id, { capacity: value }), (value) => `${value} 个并行工位`);
  }
  if (node.kind === "buffer" || node.kind === "queue-buffer") {
    const values = uniqueIntegers([Math.ceil(node.capacity * 1.5), node.capacity * 2]).filter((value) => value > node.capacity);
    if (!values.length) return undefined;
    return sweep(study, node.name, "缓冲容量", values, (value) => updateNode(model, node.id, { capacity: value }), (value) => `${value} 件容量`);
  }
  if (node.kind === "transport") {
    const resource = model.resources?.find((candidate) => candidate.id === node.resourceId);
    if (!resource) return undefined;
    const currentResourceUnits = model.resources?.reduce((sum, candidate) => sum + candidate.capacity, 0) ?? 0;
    const maxResourceUnits = study.execution.limits.maxResources;
    const values = [resource.capacity + 1, resource.capacity + 2]
      .filter((value) => value <= 100 && currentResourceUnits - resource.capacity + value <= maxResourceUnits);
    if (!values.length) return undefined;
    return sweep(study, node.name, "搬运资源数", values, (value) => updateResourceCapacity(model, resource.id, value), (value) => `${value} 个搬运资源`);
  }
  return undefined;
}

function sweep(
  study: PlantLiteStudyRecord,
  bottleneckName: string,
  parameterLabel: string,
  values: number[],
  update: (value: number) => PlantLiteModel,
  label: (value: number) => string,
): PlantLiteBottleneckSweep {
  const result = createPlantLiteSingleVariableSweep({
    study,
    subjectName: bottleneckName,
    parameterLabel,
    groupId: `bottleneck-sweep:${study.id}`,
    values,
    update,
    label,
  });
  return { ...result, bottleneckName };
}

/**
 * 统一组装单变量实验请求。容量、资源等策略只负责派生模型，公平比较所需的
 * seed、重复次数、运行上限、轨迹与验收目标都在这里复制，避免各入口产生不同口径。
 */
export function createPlantLiteSingleVariableSweep({
  study,
  subjectName,
  parameterLabel,
  groupId,
  values,
  update,
  label,
}: PlantLiteSingleVariableSweepInput): PlantLiteSingleVariableSweep {
  const candidateLabels = values.map(label);
  return {
    subjectName,
    parameterLabel,
    candidateLabels,
    requests: values.map((value, index) => ({
      name: boundedLabel(`${study.name} · ${subjectName} ${candidateLabels[index]}`, 80),
      templateId: study.templateId,
      model: update(value),
      seed: study.seed,
      replications: study.replications,
      limits: { ...study.execution.limits },
      ...traceRequest(study),
      ...(study.acceptanceTargets ? { acceptanceTargets: { ...study.acceptanceTargets } } : {}),
      comparison: {
        groupId: boundedIdentifier(groupId, 160),
        baselineStudyId: study.id,
        parameterLabel: boundedLabel(parameterLabel, 80),
        candidateLabel: candidateLabels[index] ?? String(value),
      },
    })),
  };
}

function traceRequest(study: PlantLiteStudyRecord): Pick<PlantLiteStudyRequest, "trace"> | Record<string, never> {
  if (study.execution.trace) return { trace: { ...study.execution.trace } };
  if (study.trace) return {
    trace: {
      replication: study.trace.replication,
      maxEvents: study.trace.limits.maxEvents,
      maxItems: study.trace.limits.maxItems,
    },
  };
  return {};
}

function boundedLabel(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}

function boundedIdentifier(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  return `${value.slice(0, maximum - suffix.length - 1)}:${suffix}`;
}

function updateNode(model: PlantLiteModel, nodeId: string, patch: Record<string, number>): PlantLiteModel {
  const next = structuredClone(model);
  next.nodes = next.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node) as PlantLiteModel["nodes"];
  return next;
}

function updateResourceCapacity(model: PlantLiteModel, resourceId: string, capacity: number): PlantLiteModel {
  const next = structuredClone(model);
  if (!next.resources) return next;
  next.resources = next.resources.map((resource) => resource.id === resourceId ? { ...resource, capacity } : resource);
  return next;
}

function raiseStationEffectiveCapacity(model: PlantLiteModel, nodeId: string, capacity: number): PlantLiteModel {
  const next = structuredClone(model);
  next.nodes = next.nodes.map((node) => node.id === nodeId && node.kind === "station"
    ? { ...node, capacity: Math.max(node.capacity ?? 1, capacity) }
    : node);
  const station = next.nodes.find((node) => node.id === nodeId && node.kind === "station");
  if (!station || station.kind !== "station" || !station.resourceId || !next.resources) return next;
  next.resources = next.resources.map((resource) => resource.id === station.resourceId && resource.kind === "equipment"
    ? { ...resource, capacity: Math.max(resource.capacity, capacity) }
    : resource);
  return next;
}

function uniqueIntegers(values: number[]): number[] {
  return [...new Set(values.map((value) => Math.max(1, Math.round(value))))];
}
