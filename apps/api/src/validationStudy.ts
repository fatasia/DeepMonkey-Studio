import { randomUUID } from "node:crypto";
import type {
  IndustrialValidationStudyRecord,
  IndustrialValidationStudyContext,
  SaveIndustrialValidationStudyInput,
} from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";

export class OperationsRevisionConflictError extends Error {
  constructor(readonly current: IndustrialValidationStudyRecord) {
    super("验证任务卡已被其他页面更新，请刷新后重试");
    this.name = "OperationsRevisionConflictError";
  }
}

/** 统一收敛任务卡输入，避免路由、AI 和页面各自形成一套隐式规则。 */
export function buildValidationStudyRecord(
  projectId: string,
  input: SaveIndustrialValidationStudyInput,
  existing?: IndustrialValidationStudyRecord,
): IndustrialValidationStudyRecord {
  if (input.id && !existing) throw new Error("验证任务卡不存在");
  if (existing && input.expectedRevision !== existing.revision) {
    throw new OperationsRevisionConflictError(existing);
  }
  const now = new Date().toISOString();
  const latestResult = input.latestResult ?? existing?.latestResult;
  const scenarioInput = input.scenarioInput ?? existing?.scenarioInput;
  const executionSource = input.execution ?? existing?.execution;
  const studyType = input.studyType ?? existing?.studyType;
  const baselineStudyId = compactOptionalText(input.baselineStudyId ?? existing?.baselineStudyId);
  const reproductionOf = compactOptionalText(input.reproductionOf ?? existing?.reproductionOf);
  if (input.execution && scenarioInput === undefined) throw new Error("执行证据必须关联可复现工况输入");
  const execution = executionSource
    ? {
        engineId: requiredText(executionSource.engineId, "执行引擎"),
        engineVersion: requiredText(executionSource.engineVersion, "执行引擎版本"),
        inputFingerprint: scenarioInput === undefined
          ? requiredText(executionSource.inputFingerprint, "输入指纹")
          : createEvidenceFingerprint(scenarioInput),
        deterministic: executionSource.deterministic === true,
      }
    : undefined;
  const context = compactContext(input.context ?? existing?.context);
  const record: IndustrialValidationStudyRecord = {
    id: existing?.id ?? randomUUID(),
    projectId,
    revision: (existing?.revision ?? 0) + 1,
    title: requiredText(input.title ?? existing?.title, "验证任务名称"),
    sourceKind: input.sourceKind ?? existing?.sourceKind ?? "manual",
    ...(studyType ? { studyType } : {}),
    sourceRefs: compactStringList(input.sourceRefs ?? existing?.sourceRefs ?? [], 20),
    objectIds: compactStringList(input.objectIds ?? existing?.objectIds ?? [], 100),
    objective: requiredText(input.objective ?? existing?.objective, "验证目标"),
    acceptanceCriteria: compactStringList(input.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [], 20),
    ...(scenarioInput !== undefined ? { scenarioInput: structuredClone(scenarioInput) } : {}),
    ...(execution ? { execution } : {}),
    ...(context ? { context } : {}),
    ...(baselineStudyId ? { baselineStudyId } : {}),
    ...(reproductionOf ? { reproductionOf } : {}),
    status: latestResult?.status ?? "ready",
    ...(input.sceneId ?? existing?.sceneId ? { sceneId: (input.sceneId ?? existing?.sceneId)! } : {}),
    ...(latestResult ? { latestResult: structuredClone(latestResult) } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (!record.acceptanceCriteria.length) throw new Error("至少需要一条验收条件");
  return record;
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

function compactStringList(values: string[], maximum: number): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, maximum);
}

function compactOptionalText(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, 300) : undefined;
}

function compactContext(context: IndustrialValidationStudyContext | undefined): IndustrialValidationStudyContext | undefined {
  if (!context) return undefined;
  const entries = Object.entries(context)
    .map(([key, value]) => [key, compactOptionalText(value)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return entries.length ? Object.fromEntries(entries) as IndustrialValidationStudyContext : undefined;
}
