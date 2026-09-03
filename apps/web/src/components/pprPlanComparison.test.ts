import { describe, expect, it } from "vitest";
import type { PprAnalysis, PprVersionComparison } from "@bim-studio/ppr-lite-engine";
import type { PprBopVersion } from "@bim-studio/contracts";
import {
  bindPprVersionComparison,
  currentPprVersionComparison,
  pprComparisonEntityName,
} from "./pprPlanComparison";

describe("PPR version comparison binding", () => {
  it("only exposes a result for the selectors that produced it", () => {
    const result = comparisonResult();
    const bound = bindPprVersionComparison("version-1", "version-2", result);

    expect(currentPprVersionComparison(bound, "version-1", "version-2")).toBe(bound);
    expect(currentPprVersionComparison(bound, "version-2", "version-3")).toBeUndefined();
    expect(currentPprVersionComparison(undefined, "version-1", "version-2")).toBeUndefined();

    const euBound = bindPprVersionComparison("version-1", "version-2", result, "EU");
    expect(currentPprVersionComparison(euBound, "version-1", "version-2", "EU")).toBe(euBound);
    expect(currentPprVersionComparison(euBound, "version-1", "version-2", "US")).toBeUndefined();
  });

  it("resolves names from the bound target then baseline, never an unrelated later snapshot", () => {
    const before = version("version-1", "历史工序", true);
    const after = version("version-2", "比较目标工序", false);
    const unrelatedLater = version("version-3", "无关后续改名", false);
    const bound = bindPprVersionComparison(before.id, after.id, comparisonResult());

    expect(pprComparisonEntityName("operation-1", bound, [before, after, unrelatedLater])).toBe("比较目标工序");
    expect(pprComparisonEntityName("legacy-part", bound, [before, after, unrelatedLater])).toBe("历史零件");
    expect(pprComparisonEntityName(before.planId, bound, [before, after, unrelatedLater])).toBe(after.name);
  });
});

function version(id: string, operationName: string, includeLegacyPart: boolean): PprBopVersion {
  return {
    id,
    planId: "plan-1",
    version: id.replace("version-", "v"),
    name: id === "version-1" ? "基线计划" : id === "version-2" ? "目标计划" : "后续计划",
    createdAt: "2026-09-03T08:00:00.000Z",
    components: [
      { id: "product-1", name: "整机", kind: "product" },
      ...(includeLegacyPart ? [{ id: "legacy-part", name: "历史零件", kind: "part" as const }] : []),
    ],
    operations: [{ id: "operation-1", name: operationName, standardTimeMinutes: 1, componentRefs: [{ componentId: "product-1", role: "output" }] }],
    precedenceRelations: [],
    resources: [],
    resourceAssignments: [],
  };
}

function comparisonResult(): PprVersionComparison {
  const analysis: PprAnalysis = {
    issues: [],
    topologicalOrder: [],
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
    variantScope: {
      activeVariantId: null,
      availableVariantIds: [],
      knownVariant: true,
      included: { componentIds: [], operationIds: [], precedenceRelationIds: [], resourceIds: [], assignmentIds: [] },
      excluded: { componentIds: [], operationIds: [], precedenceRelationIds: [], resourceIds: [], assignmentIds: [] },
      unresolvedConditionIds: [],
    },
    qualityControl: {
      operationCount: 0,
      coveredOperationCount: 0,
      completeOperationCount: 0,
      controlPointCount: 0,
      completeControlPointCount: 0,
      missingOperationIds: [],
      incompleteOperationIds: [],
      qualityPlanReady: false,
      evidenceScope: "control-plan-definition-only",
    },
  };
  return {
    before: analysis,
    after: structuredClone(analysis),
    changes: [],
    impact: { componentIds: [], operationIds: [], resourceIds: [] },
    regressions: [],
  };
}
