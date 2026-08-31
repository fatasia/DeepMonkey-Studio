import type { PprBopVersion } from "@bim-studio/contracts";
import type {
  PprAnalysis,
  PprChangeEntityType,
  PprRegression,
  PprVersionChange,
  PprVersionComparison,
  PprVersionImpact,
} from "./types.js";

export function compareVersionSnapshots(beforeVersion: PprBopVersion, afterVersion: PprBopVersion, before: PprAnalysis, after: PprAnalysis): PprVersionComparison {
  const changes = [
    ...compareEntities("component", beforeVersion.components, afterVersion.components),
    ...compareEntities("operation", beforeVersion.operations, afterVersion.operations),
    ...compareEntities("precedence", beforeVersion.precedenceRelations, afterVersion.precedenceRelations),
    ...compareEntities("resource", beforeVersion.resources, afterVersion.resources),
    ...compareEntities("assignment", beforeVersion.resourceAssignments, afterVersion.resourceAssignments),
  ];
  const impact = deriveImpact(changes, beforeVersion, afterVersion);
  const regressions = findRegressions(before, after, beforeVersion, afterVersion);
  return { before, after, changes, impact, regressions };
}

function compareEntities<T extends { id: string }>(entityType: PprChangeEntityType, before: T[], after: T[]): PprVersionChange[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  const next = new Map(after.map((item) => [item.id, item]));
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const changes: PprVersionChange[] = [];

  ids.forEach((entityId) => {
    const oldValue = previous.get(entityId);
    const newValue = next.get(entityId);
    if (!oldValue) {
      changes.push({ entityType, entityId, changeType: "added", changedFields: Object.keys(newValue!) });
      return;
    }
    if (!newValue) {
      changes.push({ entityType, entityId, changeType: "removed", changedFields: Object.keys(oldValue) });
      return;
    }
    const changedFields = changedKeys(oldValue, newValue);
    if (changedFields.length) changes.push({ entityType, entityId, changeType: "modified", changedFields });
  });
  return changes;
}

function deriveImpact(changes: PprVersionChange[], before: PprBopVersion, after: PprBopVersion): PprVersionImpact {
  const versions = [before, after];
  const componentIds = new Set(changes.filter((change) => change.entityType === "component").map((change) => change.entityId));
  const operationIds = new Set(changes.filter((change) => change.entityType === "operation").map((change) => change.entityId));
  const resourceIds = new Set(changes.filter((change) => change.entityType === "resource").map((change) => change.entityId));

  changes.forEach((change) => addRelationImpact(change, versions, operationIds, resourceIds));
  versions.forEach((version) => version.operations.forEach((operation) => {
    if (operationIds.has(operation.id)) operation.componentRefs.forEach((reference) => componentIds.add(reference.componentId));
  }));

  return {
    componentIds: [...componentIds].sort(),
    operationIds: [...operationIds].sort(),
    resourceIds: [...resourceIds].sort(),
  };
}

function addRelationImpact(change: PprVersionChange, versions: PprBopVersion[], operationIds: Set<string>, resourceIds: Set<string>): void {
  if (change.entityType === "precedence") {
    versions.forEach((version) => {
      const relation = version.precedenceRelations.find((item) => item.id === change.entityId);
      if (relation) {
        operationIds.add(relation.predecessorOperationId);
        operationIds.add(relation.successorOperationId);
      }
    });
  }
  if (change.entityType === "assignment") {
    versions.forEach((version) => {
      const assignment = version.resourceAssignments.find((item) => item.id === change.entityId);
      if (assignment) {
        operationIds.add(assignment.operationId);
        resourceIds.add(assignment.resourceId);
      }
    });
  }
}

function findRegressions(before: PprAnalysis, after: PprAnalysis, beforeVersion: PprBopVersion, afterVersion: PprBopVersion): PprRegression[] {
  const regressions: PprRegression[] = [];
  addCriticalPathRegression(regressions, before, after);
  addValidationRegressions(regressions, before, after);
  addResourceConflictRegressions(regressions, before, after);
  addStandardTimeRegressions(regressions, beforeVersion, afterVersion);
  return regressions;
}

function addCriticalPathRegression(regressions: PprRegression[], before: PprAnalysis, after: PprAnalysis): void {
  if (after.criticalPath.durationMinutes <= before.criticalPath.durationMinutes) return;
  regressions.push({
    code: "critical-path-increased",
    message: `关键路径由 ${before.criticalPath.durationMinutes} 分钟增加到 ${after.criticalPath.durationMinutes} 分钟。`,
    entityIds: after.criticalPath.operationIds,
  });
}

function addValidationRegressions(regressions: PprRegression[], before: PprAnalysis, after: PprAnalysis): void {
  const previousErrors = new Set(before.issues.filter((issue) => issue.severity === "error").map(issueKey));
  after.issues.filter((issue) => issue.severity === "error" && !previousErrors.has(issueKey(issue))).forEach((issue) => {
    regressions.push({ code: "new-validation-error", message: issue.message, entityIds: [issue.entityId] });
  });
}

function addResourceConflictRegressions(regressions: PprRegression[], before: PprAnalysis, after: PprAnalysis): void {
  const previousConflicts = new Set(before.resourceConflicts.map(conflictKey));
  after.resourceConflicts.filter((conflict) => !previousConflicts.has(conflictKey(conflict))).forEach((conflict) => {
    regressions.push({
      code: "resource-conflict-introduced",
      message: `资源 ${conflict.resourceId} 在 ${conflict.startMinutes}–${conflict.endMinutes} 分钟发生时间冲突。`,
      entityIds: [conflict.resourceId, ...conflict.operationIds],
    });
  });
}

function addStandardTimeRegressions(regressions: PprRegression[], before: PprBopVersion, after: PprBopVersion): void {
  const previous = new Map(before.operations.map((operation) => [operation.id, operation]));
  after.operations.forEach((operation) => {
    const oldOperation = previous.get(operation.id);
    if (!oldOperation || operation.standardTimeMinutes <= oldOperation.standardTimeMinutes) return;
    regressions.push({
      code: "standard-time-increased",
      message: `工序 ${operation.id} 标准工时由 ${oldOperation.standardTimeMinutes} 分钟增加到 ${operation.standardTimeMinutes} 分钟。`,
      entityIds: [operation.id],
    });
  });
}

function changedKeys(left: object, right: object): string[] {
  const previous = left as Record<string, unknown>;
  const next = right as Record<string, unknown>;
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .sort();
}

function issueKey(issue: PprAnalysis["issues"][number]): string {
  return `${issue.code}:${issue.entityType}:${issue.entityId}`;
}

function conflictKey(conflict: PprAnalysis["resourceConflicts"][number]): string {
  return `${conflict.resourceId}:${conflict.startMinutes}:${conflict.endMinutes}:${conflict.operationIds.slice().sort().join(",")}`;
}
