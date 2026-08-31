import type { PprBopVersion } from "@bim-studio/contracts";
import { compareVersionSnapshots } from "./comparison.js";
import {
  buildCriticalPath,
  buildTopologicalOrder,
  calculateResourceLoads,
  createOperationGraph,
  findResourceConflicts,
  scheduleOperations,
} from "./scheduling.js";
import type { PprAnalysis, PprVersionComparison } from "./types.js";
import { validatePprBopVersion } from "./validation.js";

export function analyzePprBopVersion(version: PprBopVersion): PprAnalysis {
  const validated = validatePprBopVersion(version);
  const graph = createOperationGraph(version.operations, validated.relations);
  const topologicalOrder = buildTopologicalOrder(version.operations.map((operation) => operation.id), graph);
  const issues = [...validated.issues];

  if (topologicalOrder.length !== version.operations.length) {
    const cycleIds = version.operations.map((operation) => operation.id).filter((operationId) => !topologicalOrder.includes(operationId));
    issues.push({
      code: "precedence-cycle",
      severity: "error",
      entityType: "version",
      entityId: version.id,
      message: `工序前置关系存在环：${cycleIds.join("、")}。`,
    });
  }
  if (issues.some((issue) => issue.severity === "error")) return emptyAnalysis(issues, topologicalOrder);

  const schedule = scheduleOperations(topologicalOrder, validated.operations, graph.predecessors);
  const criticalPath = buildCriticalPath(schedule);
  return {
    issues,
    topologicalOrder,
    schedule,
    criticalPath,
    resourceLoads: calculateResourceLoads(version.resources, validated.assignments, schedule, validated.operations, criticalPath.durationMinutes),
    resourceConflicts: findResourceConflicts(version.resources, validated.assignments, schedule),
  };
}

export function comparePprBopVersions(beforeVersion: PprBopVersion, afterVersion: PprBopVersion): PprVersionComparison {
  return compareVersionSnapshots(
    beforeVersion,
    afterVersion,
    analyzePprBopVersion(beforeVersion),
    analyzePprBopVersion(afterVersion),
  );
}

function emptyAnalysis(issues: PprAnalysis["issues"], topologicalOrder: string[]): PprAnalysis {
  return {
    issues,
    topologicalOrder,
    schedule: [],
    criticalPath: { operationIds: [], durationMinutes: 0 },
    resourceLoads: [],
    resourceConflicts: [],
  };
}
