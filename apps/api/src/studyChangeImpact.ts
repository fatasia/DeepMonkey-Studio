import {
  collectThreadLinks,
  diagnoseDigitalThread,
  type DigitalThreadObject,
  type IndustrialStudyRecord,
  type PprBopVersion,
  type SceneAssetRevisionSnapshot,
} from "@bim-studio/contracts";
import type { PprVersionComparison } from "@bim-studio/ppr-lite-engine";

export type StudyPprDependency =
  | { kind: "plan"; id: string }
  | { kind: "component" | "operation" | "resource" | "precedence" | "assignment"; id: string };

/** 由 Study 创建方在运行时冻结；不得从现有 Study 指纹反推实体依赖。 */
export interface StudyChangeBinding {
  studyId: string;
  planId: string;
  versionId: string;
  entities: StudyPprDependency[];
  assets: Array<{ modelId: string; snapshot: SceneAssetRevisionSnapshot }>;
}

export interface StudyAssetHead {
  modelId: string;
  snapshot: SceneAssetRevisionSnapshot;
}

export interface StudyStaleReason {
  code: "ppr-changed" | "asset-revised";
  subject: string;
  message: string;
}

export interface StudyChangeImpact {
  studyId: string;
  status: "fresh" | "stale" | "unknown";
  reasons: StudyStaleReason[];
  baselineStudyId: string | null;
}

export interface StudyChangeDiagnostic {
  code: "missing-binding" | "missing-study" | "duplicate-binding" | "invalid-binding" | "missing-entity" | "missing-asset" | "asset-revision-conflict" | "thread-link";
  studyId?: string;
  message: string;
}

export interface StudyChangeImpactResult {
  studies: StudyChangeImpact[];
  diagnostics: StudyChangeDiagnostic[];
}

/** 只读投影：不修改 Study 结果/历史基线，不把未知依赖推断为 fresh。 */
export function assessStudyChangeImpact(input: {
  studies: readonly IndustrialStudyRecord[];
  bindings: readonly StudyChangeBinding[];
  before: PprBopVersion;
  after: PprBopVersion;
  comparison: PprVersionComparison;
  assetHeads?: readonly StudyAssetHead[];
  threadObjects?: readonly DigitalThreadObject[];
}): StudyChangeImpactResult {
  if (input.before.planId !== input.after.planId) throw new Error("变更影响只能比较同一工艺计划，请选择同一计划的两个版本");
  const diagnostics: StudyChangeDiagnostic[] = [];
  const byStudy = new Map<string, StudyChangeBinding>();
  const duplicateStudyIds = new Set<string>();
  const studyIds = new Set(input.studies.map((study) => study.id));
  for (const binding of input.bindings) {
    if (!studyIds.has(binding.studyId)) {
      diagnostics.push({ code: "missing-study", studyId: binding.studyId, message: `Study ${binding.studyId} 不存在，请核对冻结依赖的来源` });
      continue;
    }
    if (duplicateStudyIds.has(binding.studyId)) continue;
    if (byStudy.has(binding.studyId)) {
      diagnostics.push({ code: "duplicate-binding", studyId: binding.studyId, message: `Study ${binding.studyId} 有重复依赖绑定，请检查输入` });
      byStudy.delete(binding.studyId);
      duplicateStudyIds.add(binding.studyId);
      continue;
    }
    byStudy.set(binding.studyId, binding);
  }
  const removedOrChanged = new Map(input.comparison.changes.map((change) => [`${change.entityType}:${change.entityId}`, change]));
  const operationImpact = affectedOperations(input.before, input.after, input.comparison);
  const beforeEntities = entityIds(input.before);
  const afterEntities = entityIds(input.after);
  const assetHeads = new Map<string, SceneAssetRevisionSnapshot>();
  const conflictedAssetIds = new Set<string>();
  for (const asset of input.assetHeads ?? []) {
    if (conflictedAssetIds.has(asset.modelId)) continue;
    const existing = assetHeads.get(asset.modelId);
    if (existing && (existing.packageId !== asset.snapshot.packageId || existing.revision !== asset.snapshot.revision || existing.sourceHash !== asset.snapshot.sourceHash)) {
      diagnostics.push({ code: "asset-revision-conflict", message: `素材 ${asset.modelId} 同时有不同最新修订，请核对项目资产清单` });
      assetHeads.delete(asset.modelId);
      conflictedAssetIds.add(asset.modelId);
      continue;
    }
    assetHeads.set(asset.modelId, asset.snapshot);
  }
  const threadDiagnostics = input.threadObjects ? diagnoseDigitalThread(input.threadObjects) : [];
  const threadLinks = input.threadObjects ? collectThreadLinks(input.threadObjects) : [];
  const studyIdForLink = new Map(threadLinks.filter((link) => link.role === "study-record").map((link) => [link.fromStableId, link.toStableId]));
  const output = input.studies.map((study): StudyChangeImpact => {
    const binding = byStudy.get(study.id);
    const reasons: StudyStaleReason[] = [];
    let uncertain = duplicateStudyIds.has(study.id) || threadDiagnostics.some((issue) =>
      studyIdForLink.get(issue.fromStableId ?? "") === study.id && !(issue.kind === "broken-link" && issue.toStableId === study.id));
    if (!binding) {
      if (!duplicateStudyIds.has(study.id)) diagnostics.push({ code: "missing-binding", studyId: study.id, message: `Study ${study.id} 没有冻结的输入依赖，无法判断变更影响` });
      uncertain = true;
    } else if (binding.planId !== input.before.planId || binding.versionId !== input.before.id) {
      diagnostics.push({ code: "invalid-binding", studyId: study.id, message: `Study ${study.id} 的工艺计划或基线版本与比较输入不匹配` });
      uncertain = true;
    } else if (!binding.entities.length && !binding.assets.length) {
      diagnostics.push({ code: "invalid-binding", studyId: study.id, message: `Study ${study.id} 未冻结任何 PPR 实体或素材依赖，无法判定变更影响` });
      uncertain = true;
    } else {
      const seen = new Set<string>();
      for (const dependency of binding.entities) {
        const key = `${dependency.kind}:${dependency.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const direct = removedOrChanged.get(key);
        const related = dependency.kind === "plan" && input.comparison.changes.length
          ? "BOM/BOP 版本"
          : dependency.kind === "operation"
            ? operationImpact.get(dependency.id) ?? null
            : null;
        if (direct && direct.changeType !== "added") {
          reasons.push({ code: "ppr-changed", subject: key, message: `${key} ${direct.changeType === "removed" ? "已删除" : `字段 ${direct.changedFields.join("、")} 已变更`}（${input.before.version} → ${input.after.version}）` });
          if (direct.changeType === "removed") diagnostics.push({ code: "missing-entity", studyId: study.id, message: `Study ${study.id} 的输入 ${key} 已在新版本删除，请重审 Study 并保留原基线` });
        } else if (related) {
          reasons.push({ code: "ppr-changed", subject: key, message: `${key} 依赖的${related}已变更（${input.before.version} → ${input.after.version}）` });
        } else if (!beforeEntities.has(key) || !afterEntities.has(key)) {
          diagnostics.push({ code: "missing-entity", studyId: study.id, message: `Study ${study.id} 引用的 ${key} 不存在于基线或新版本，请检查删除/错误边` });
          uncertain = true;
        }
      }
      for (const asset of binding.assets) {
        const head = assetHeads.get(asset.modelId);
        if (!head || head.packageId !== asset.snapshot.packageId) {
          diagnostics.push({ code: "missing-asset", studyId: study.id, message: `Study ${study.id} 素材 ${asset.modelId} 的资产包不可解析，请核对绑定或删除记录` });
          uncertain = true;
        } else if (head.revision > asset.snapshot.revision || (head.revision === asset.snapshot.revision && head.sourceHash !== asset.snapshot.sourceHash)) {
          reasons.push({ code: "asset-revised", subject: asset.modelId, message: `素材 ${asset.modelId} 修订 ${asset.snapshot.revision} → ${head.revision}${head.sourceHash !== asset.snapshot.sourceHash ? "（内容哈希不同）" : ""}` });
        } else if (head.revision < asset.snapshot.revision) {
          diagnostics.push({ code: "asset-revision-conflict", studyId: study.id, message: `素材 ${asset.modelId} 的最新修订低于 Study 冻结修订，请核对资产历史` });
          uncertain = true;
        }
      }
    }
    return {
      studyId: study.id,
      status: uncertain ? "unknown" : reasons.length ? "stale" : "fresh",
      reasons,
      baselineStudyId: study.lineage.baselineStudyId,
    };
  });
  for (const issue of threadDiagnostics) {
    if (issue.kind === "broken-link" && studyIdForLink.get(issue.fromStableId ?? "") === issue.toStableId && studyIds.has(issue.toStableId ?? "")) continue;
    const linkedStudyId = studyIdForLink.get(issue.fromStableId ?? "");
    diagnostics.push({ code: "thread-link", ...(linkedStudyId ? { studyId: linkedStudyId } : {}), message: issue.message });
  }
  return { studies: output, diagnostics };
}

function entityIds(version: PprBopVersion): Set<string> {
  return new Set([
    `plan:${version.planId}`,
    ...version.components.map((item) => `component:${item.id}`),
    ...version.operations.map((item) => `operation:${item.id}`),
    ...version.resources.map((item) => `resource:${item.id}`),
    ...version.precedenceRelations.map((item) => `precedence:${item.id}`),
    ...version.resourceAssignments.map((item) => `assignment:${item.id}`),
  ]);
}

function affectedOperations(before: PprBopVersion, after: PprBopVersion, comparison: PprVersionComparison): Map<string, string> {
  const changed = new Map<string, string>();
  const resources = new Set(comparison.changes.filter((change) => change.entityType === "resource" && change.changeType !== "added").map((change) => change.entityId));
  const assignments = new Set(comparison.changes.filter((change) => change.entityType === "assignment").map((change) => change.entityId));
  const components = new Set(comparison.changes.filter((change) => change.entityType === "component" && change.changeType !== "added").map((change) => change.entityId));
  const relations = new Set(comparison.changes.filter((change) => change.entityType === "precedence").map((change) => change.entityId));
  for (const version of [before, after]) {
    for (const relation of version.precedenceRelations) {
      if (!relations.has(relation.id)) continue;
      changed.set(relation.predecessorOperationId, "BOP 前置关系");
      changed.set(relation.successorOperationId, "BOP 前置关系");
    }
    for (const operation of version.operations) {
      if (operation.componentRefs.some((ref) => components.has(ref.componentId))) changed.set(operation.id, "BOM 零部件");
    }
    for (const assignment of version.resourceAssignments) {
      if (resources.has(assignment.resourceId) || assignments.has(assignment.id)) changed.set(assignment.operationId, "资源分配");
    }
  }
  return changed;
}
