import type { ComponentRecord } from "./analysis";

// P1 模型版本变更对比评审·切片一（2026-09-19 用户批准的轻量切片）：
// 以 C08 稳定构件 ID（stableId）为身份的两次模型快照 diff 引擎。
// 纯数据层：新增/删除/修改 + 属性级变更清单；UI 三色高亮与评审发布页由
// 场景事务（B01）与资源面板集成切片完成。不新建身份体系。

export type ModelDiffFieldKind = "identity" | "semantic" | "property";

export interface ModelDiffChange {
  stableId: string;
  before: ComponentRecord;
  after: ComponentRecord;
  changedFields: Array<{ field: string; kind: ModelDiffFieldKind; before: string; after: string }>;
}

export interface ModelDiffReport {
  generatedAt: string;
  beforeCount: number;
  afterCount: number;
  added: ComponentRecord[];
  removed: ComponentRecord[];
  modified: ModelDiffChange[];
  unchangedCount: number;
  summary: {
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    /** 身份字段变化 = 构件被重命名/移动层级，最影响人工核对 */
    identityChanges: number;
    semanticChanges: number;
    propertyChanges: number;
  };
  /** changedBeforeAfter: true = 变更集中至少一个构件有实质变化（空 diff 也如实报告） */
  hasChanges: boolean;
  evidenceBoundary: "以 stableId 为身份的记录级 diff；几何级顶点差异不在本切片范围（由编译链几何质量报告承担）";
}

const IDENTITY_FIELDS = new Set(["name", "path", "level", "modelName"]);
const SEMANTIC_FIELDS = new Set(["type", "category", "specialty"]);

export function diffComponentSets(before: ComponentRecord[], after: ComponentRecord[]): ModelDiffReport {
  const beforeById = new Map(before.map((record) => [record.stableId, record]));
  const afterById = new Map(after.map((record) => [record.stableId, record]));

  const added = after.filter((record) => !beforeById.has(record.stableId));
  const removed = before.filter((record) => !afterById.has(record.stableId));
  const modified: ModelDiffChange[] = [];

  for (const afterRecord of after) {
    const beforeRecord = beforeById.get(afterRecord.stableId);
    if (!beforeRecord) continue;
    const changedFields = changedFieldsBetween(beforeRecord, afterRecord);
    if (changedFields.length > 0) modified.push({ stableId: afterRecord.stableId, before: beforeRecord, after: afterRecord, changedFields });
  }

  const unchangedCount = before.length - removed.length - modified.length;
  const countKind = (kind: ModelDiffFieldKind) =>
    modified.reduce((total, change) => total + change.changedFields.filter((field) => field.kind === kind).length, 0);

  return {
    generatedAt: new Date().toISOString(),
    beforeCount: before.length,
    afterCount: after.length,
    added,
    removed,
    modified,
    unchangedCount,
    summary: {
      addedCount: added.length,
      removedCount: removed.length,
      modifiedCount: modified.length,
      identityChanges: countKind("identity"),
      semanticChanges: countKind("semantic"),
      propertyChanges: countKind("property"),
    },
    hasChanges: added.length + removed.length + modified.length > 0,
    evidenceBoundary: "以 stableId 为身份的记录级 diff；几何级顶点差异不在本切片范围（由编译链几何质量报告承担）",
  };
}

export function changedFieldsBetween(before: ComponentRecord, after: ComponentRecord): Array<{ field: string; kind: ModelDiffFieldKind; before: string; after: string }> {
  const changes: Array<{ field: string; kind: ModelDiffFieldKind; before: string; after: string }> = [];
  const scalarFields: Array<[string, ModelDiffFieldKind]> = [
    ["name", "identity"],
    ["path", "identity"],
    ["level", "identity"],
    ["modelName", "identity"],
    ["type", "semantic"],
    ["category", "semantic"],
    ["specialty", "semantic"],
  ];
  for (const [field, kind] of scalarFields) {
    const beforeValue = String((before as unknown as Record<string, unknown>)[field] ?? "");
    const afterValue = String((after as unknown as Record<string, unknown>)[field] ?? "");
    if (beforeValue !== afterValue) changes.push({ field, kind, before: beforeValue, after: afterValue });
  }
  const propertyKeys = new Set([...Object.keys(before.properties), ...Object.keys(after.properties)]);
  for (const key of propertyKeys) {
    const beforeValue = before.properties[key] ?? "";
    const afterValue = after.properties[key] ?? "";
    if (beforeValue !== afterValue) changes.push({ field: `properties.${key}`, kind: "property", before: beforeValue, after: afterValue });
  }
  return changes;
}
