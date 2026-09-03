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
import { calculateLineBalance } from "./lineBalancing.js";
import { projectPprVariant } from "./variantProjection.js";
import { calculatePprQualityControlCoverage } from "./qualityControls.js";

export function analyzePprBopVersion(version: PprBopVersion, activeVariantId?: string): PprAnalysis {
  const projection = projectPprVariant(version, activeVariantId);
  const activeVersion = projection.version;
  const validated = validatePprBopVersion(activeVersion);
  const graph = createOperationGraph(activeVersion.operations, validated.relations);
  const topologicalOrder = buildTopologicalOrder(activeVersion.operations.map((operation) => operation.id), graph);
  const issues = [...projection.issues, ...validated.issues];
  const qualityControl = calculatePprQualityControlCoverage(activeVersion);

  if (topologicalOrder.length !== activeVersion.operations.length) {
    const cycleIds = activeVersion.operations.map((operation) => operation.id).filter((operationId) => !topologicalOrder.includes(operationId));
    issues.push({
      code: "precedence-cycle",
      severity: "error",
      entityType: "version",
      entityId: version.id,
      message: `工序前置关系存在环：${cycleIds.join("、")}。`,
    });
  }
  if (issues.some((issue) => issue.severity === "error")) return emptyAnalysis(issues, topologicalOrder, projection.scope, qualityControl);

  const schedule = scheduleOperations(topologicalOrder, validated.operations, graph.predecessors);
  const criticalPath = buildCriticalPath(schedule);
  return {
    issues,
    topologicalOrder,
    schedule,
    criticalPath,
    resourceLoads: calculateResourceLoads(activeVersion.resources, validated.assignments, schedule, validated.operations, criticalPath.durationMinutes),
    resourceConflicts: findResourceConflicts(activeVersion.resources, validated.assignments, schedule),
    lineBalance: calculateLineBalance(activeVersion, validated.operations),
    variantScope: projection.scope,
    qualityControl,
  };
}

export function comparePprBopVersions(
  beforeVersion: PprBopVersion,
  afterVersion: PprBopVersion,
  activeVariantId?: string,
): PprVersionComparison {
  const variantId = activeVariantId?.trim();
  if (variantId) {
    const beforeProjection = projectPprVariant(beforeVersion, variantId);
    const afterProjection = projectPprVariant(afterVersion, variantId);
    return compareVersionSnapshots(
      comparisonProjection(beforeProjection.version, variantId),
      comparisonProjection(afterProjection.version, variantId),
      analyzePprBopVersion(beforeVersion, variantId),
      analyzePprBopVersion(afterVersion, variantId),
    );
  }
  return compareVersionSnapshots(
    beforeVersion,
    afterVersion,
    analyzePprBopVersion(beforeVersion),
    analyzePprBopVersion(afterVersion),
  );
}

function comparisonProjection(version: PprBopVersion, activeVariantId: string): PprBopVersion {
  return { ...version, variantIds: [activeVariantId] };
}

function emptyAnalysis(
  issues: PprAnalysis["issues"],
  topologicalOrder: string[],
  variantScope: PprAnalysis["variantScope"],
  qualityControl: PprAnalysis["qualityControl"],
): PprAnalysis {
  return {
    issues,
    topologicalOrder,
    schedule: [],
    criticalPath: { operationIds: [], durationMinutes: 0 },
    resourceLoads: [],
    resourceConflicts: [],
    lineBalance: {
      targetTaktMinutes: null,
      totalWorkContentMinutes: 0,
      configuredStationUnits: 0,
      theoreticalMinimumStationUnits: null,
      balanceEfficiency: null,
      stationLoads: [],
      unassignedOperationIds: [],
      overloadedResourceIds: [],
    },
    variantScope,
    qualityControl,
  };
}
