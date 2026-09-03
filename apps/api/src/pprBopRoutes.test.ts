import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { createApiServer } from "./serverOptions.js";
import { PprBopService } from "./pprBopService.js";
import { registerPprBopRoutes } from "./pprBopRoutes.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("PPR/BOP routes", () => {
  it("appends immutable versions, analyzes them, compares their impact and persists history", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-ppr-bop-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new PprBopService(directory);
    await service.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerPprBopRoutes(app, {
      service,
      store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never,
    });

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: draft(),
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json() as { id: string; version: string };
    expect(first.version).toBe("v1");

    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: draft(first.id, 10),
    });
    expect(secondResponse.statusCode).toBe(201);
    const second = secondResponse.json() as { id: string; version: string };
    expect(second.version).toBe("v2");

    const analysis = await app.inject({
      method: "GET",
      url: `/api/projects/project-1/ppr/bop-versions/${second.id}/analysis`,
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json()).toMatchObject({
      criticalPath: { durationMinutes: 14 },
      qualityControl: {
        operationCount: 2,
        coveredOperationCount: 1,
        completeOperationCount: 1,
        missingOperationIds: ["locate"],
        qualityPlanReady: false,
        evidenceScope: "control-plan-definition-only",
      },
    });

    const euDraft = draft(second.id, 10);
    euDraft.variantIds = ["EU", "US"];
    euDraft.operations[1]!.variantIds = ["US"];
    const thirdResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: euDraft,
    });
    expect(thirdResponse.statusCode).toBe(201);
    const third = thirdResponse.json() as { id: string; version: string };
    const euAnalysis = await app.inject({
      method: "GET",
      url: `/api/projects/project-1/ppr/bop-versions/${third.id}/analysis?variantId=EU`,
    });
    expect(euAnalysis.statusCode).toBe(200);
    expect(euAnalysis.json()).toMatchObject({
      criticalPath: { durationMinutes: 4 },
      variantScope: { activeVariantId: "EU", excluded: { operationIds: ["assemble"] } },
    });

    const comparison = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions/compare",
      payload: { beforeVersionId: first.id, afterVersionId: second.id },
    });
    expect(comparison.statusCode).toBe(200);
    expect(comparison.json()).toMatchObject({
      impact: { operationIds: ["assemble"], componentIds: ["assembly"] },
      regressions: expect.arrayContaining([expect.objectContaining({ code: "standard-time-increased" })]),
    });

    const euComparison = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions/compare",
      payload: { beforeVersionId: second.id, afterVersionId: third.id, activeVariantId: "EU" },
    });
    expect(euComparison.statusCode).toBe(200);
    expect(euComparison.json()).toMatchObject({
      before: { variantScope: { activeVariantId: "EU", knownVariant: true } },
      after: { variantScope: { activeVariantId: "EU", knownVariant: true } },
      changes: expect.arrayContaining([expect.objectContaining({ entityType: "operation", entityId: "assemble", changeType: "removed" })]),
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: { ...draft(), version: "v1" },
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().message).toContain("不可覆盖");

    const reloaded = new PprBopService(directory);
    await reloaded.init();
    expect(reloaded.list("project-1").map((version) => version.version)).toEqual(["v1", "v2", "v3"]);
    expect(reloaded.list("project-1")[1]?.operations[1]?.workInstruction).toMatchObject({
      steps: [{ id: "assemble-step-1", instruction: "按定位销装配并紧固" }],
      qualityChecks: [{
        id: "assemble-quality-1",
        checkpoint: "装配间隙",
        specificationKind: "limits",
        lowerLimit: 0.5,
        upperLimit: 0.8,
        samplingFrequency: { mode: "every-n-items", interval: 10 },
      }],
      visualReferences: [{ kind: "object", id: "fixture-01" }],
    });
  });

  it("rejects malformed structure, broken references and invalid EWI without appending a version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-ppr-bop-invalid-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new PprBopService(directory);
    await service.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerPprBopRoutes(app, {
      service,
      store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never,
    });

    const validResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/ppr/bop-versions",
      payload: draft(),
    });
    expect(validResponse.statusCode).toBe(201);
    expect(service.list("project-1")).toHaveLength(1);

    const malformedArrays = { ...draft(), operations: { assemble: true } };
    const brokenReferences = draft();
    brokenReferences.operations[0]!.componentRefs = [{ componentId: "missing-component", role: "input" }];
    const invalidEwi = {
      ...draft(),
      operations: draft().operations.map((operation) => operation.id === "assemble"
        ? { ...operation, workInstruction: { ...operation.workInstruction, safetyNotes: "not-an-array" } }
        : operation),
    };
    const brokenOperationAssignment = draft();
    brokenOperationAssignment.resourceAssignments[0]!.operationId = "missing-operation";
    const detachedQualityReference = draft();
    Object.assign(detachedQualityReference.operations[1]!.workInstruction!.qualityChecks[0]!, { operationId: "missing-operation" });
    const invalidQualityLimits = draft();
    Object.assign(invalidQualityLimits.operations[1]!.workInstruction!.qualityChecks[0]!, {
      specificationKind: "limits",
      lowerLimit: 2,
      upperLimit: 1,
      inspectionMethod: "塞尺",
      samplingFrequency: { mode: "every-item" },
      outOfControlReaction: "隔离本批",
    });
    const invalidSampling = draft();
    Object.assign(invalidSampling.operations[1]!.workInstruction!.qualityChecks[0]!, {
      specificationKind: "tolerance",
      targetValue: 12,
      tolerance: 1,
      inspectionMethod: "扭矩枪",
      samplingFrequency: { mode: "every-n-items", interval: 0 },
      outOfControlReaction: "停止并隔离",
    });
    const cases = [
      { payload: malformedArrays, expectedMessage: "$.operations 必须是 array" },
      { payload: brokenReferences, expectedMessage: "不存在的零部件 missing-component" },
      { payload: invalidEwi, expectedMessage: "workInstruction.safetyNotes 必须是 array" },
      { payload: brokenOperationAssignment, expectedMessage: "引用了不存在的工序或资源" },
      { payload: detachedQualityReference, expectedMessage: "operationId 不是允许的字段" },
      { payload: invalidQualityLimits, expectedMessage: "下限必须小于或等于上限" },
      { payload: invalidSampling, expectedMessage: "samplingFrequency.interval 不能小于 1" },
    ];

    for (const invalid of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/projects/project-1/ppr/bop-versions",
        payload: invalid.payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(invalid.expectedMessage);
      expect(service.list("project-1")).toHaveLength(1);
    }

    const reloaded = new PprBopService(directory);
    await reloaded.init();
    expect(reloaded.list("project-1")).toHaveLength(1);
  });
});

function draft(basedOnVersionId?: string, assembleMinutes = 8): PprBopVersionDraft {
  return {
    planId: "door-plan",
    name: "车门装配",
    ...(basedOnVersionId ? { basedOnVersionId } : {}),
    references: [{ kind: "scene", id: "scene-1" }, { kind: "study", id: "study-1" }],
    components: [{ id: "assembly", name: "车门总成", kind: "product" }],
    operations: [
      { id: "locate", name: "定位", standardTimeMinutes: 4, componentRefs: [{ componentId: "assembly", role: "in-process" }] },
      {
        id: "assemble",
        name: "装配",
        standardTimeMinutes: assembleMinutes,
        componentRefs: [{ componentId: "assembly", role: "output" }],
        references: [{ kind: "object", id: "fixture-01" }],
        workInstruction: {
          steps: [{ id: "assemble-step-1", instruction: "按定位销装配并紧固" }],
          safetyNotes: [{ id: "assemble-safety-1", note: "夹具动作前确认手部离开夹紧区" }],
          qualityChecks: [{
            id: "assemble-quality-1",
            checkpoint: "装配间隙",
            specificationKind: "limits",
            targetValue: 0.65,
            lowerLimit: 0.5,
            upperLimit: 0.8,
            unit: "mm",
            inspectionMethod: "塞尺",
            samplingFrequency: { mode: "every-n-items", interval: 10 },
            outOfControlReaction: "停止装配并隔离本批",
          }],
          visualReferences: [{ kind: "object", id: "fixture-01" }],
        },
      },
    ],
    precedenceRelations: [{ id: "locate-assemble", predecessorOperationId: "locate", successorOperationId: "assemble" }],
    resources: [{ id: "station", name: "工位", kind: "station" }],
    resourceAssignments: [
      { id: "locate-station", operationId: "locate", resourceId: "station" },
      { id: "assemble-station", operationId: "assemble", resourceId: "station" },
    ],
  };
}
