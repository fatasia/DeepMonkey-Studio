import { describe, expect, it } from "vitest";
import type { PprBopVersion, PprBopVersionDraft } from "@bim-studio/contracts";
import {
  addPprComponent,
  addPprOperation,
  addPprResource,
  analyzePprPlanDraft,
  availablePprParents,
  clonePprVersionAsDraft,
  createEmptyPprPlanDraft,
  removePprComponent,
  removePprOperation,
  removePprResource,
  setPprEntityVariantIds,
  setPprPrecedenceRelationCondition,
} from "./pprPlanDraftModel";

describe("PD Lite authoring draft", () => {
  it("starts empty and inherits only real scene/object/script/study references", () => {
    const draft = createEmptyPprPlanDraft("project-1", {
      sceneId: " scene-1 ",
      objectId: "object-1",
      scriptId: "",
      studyId: "study-1",
    });

    expect(draft).toMatchObject({
      planId: "pd-lite-project-1",
      components: [],
      operations: [],
      resources: [],
      references: [
        { kind: "scene", id: "scene-1" },
        { kind: "object", id: "object-1" },
        { kind: "study", id: "study-1" },
      ],
    });
    expect(draft).not.toHaveProperty("targetTaktMinutes");
  });

  it("builds the simple product-operation-resource path with automatic links", () => {
    let draft = createEmptyPprPlanDraft("project-1", {});
    draft = addPprComponent(draft, "product");
    draft = addPprComponent(draft, "part");
    draft = addPprOperation(draft);
    draft = addPprOperation(draft);
    draft = addPprResource(draft, "robot");

    expect(draft.components[1]).toMatchObject({ kind: "part", parentComponentId: draft.components[0]!.id });
    expect(draft.operations[0]?.componentRefs).toHaveLength(1);
    expect(draft.precedenceRelations).toEqual([expect.objectContaining({
      predecessorOperationId: draft.operations[0]!.id,
      successorOperationId: draft.operations[1]!.id,
    })]);
    expect(draft.resourceAssignments).toEqual([expect.objectContaining({
      operationId: draft.operations[0]!.id,
      resourceId: draft.resources[0]!.id,
    })]);
    expect(analyzePprPlanDraft(draft).criticalPath.durationMinutes).toBe(2);
  });

  it("clones an immutable version deeply and preserves external references", () => {
    const version = savedVersion();
    const draft = clonePprVersionAsDraft(version);
    draft.operations[0]!.name = "草稿更名";
    draft.operations[0]!.workInstruction!.steps[0]!.instruction = "草稿步骤";
    draft.references!.push({ kind: "script", id: "script-1" });

    expect(draft.basedOnVersionId).toBe(version.id);
    expect(draft.targetTaktMinutes).toBe(version.targetTaktMinutes);
    expect(draft.version).toBeUndefined();
    expect(version.operations[0]?.name).toBe("定位");
    expect(version.operations[0]?.workInstruction?.steps[0]?.instruction).toBe("将零件放入定位夹具");
    expect(version.references).toEqual([{ kind: "scene", id: "scene-1" }]);
  });

  it("cascades deletions so the authoring UI never leaves dangling IDs", () => {
    const source = savedVersion();
    const draft = clonePprVersionAsDraft(source);
    const withoutComponent = removePprComponent(draft, "part-1");
    expect(withoutComponent.operations[0]?.componentRefs).toEqual([]);

    const withoutOperation = removePprOperation(draft, "operation-1");
    expect(withoutOperation.precedenceRelations).toEqual([]);
    expect(withoutOperation.resourceAssignments).toEqual([]);

    const withoutResource = removePprResource(draft, "resource-1");
    expect(withoutResource.resourceAssignments).toEqual([]);
  });

  it("excludes self and descendants from the BOM parent selector", () => {
    const draft = {
      ...createEmptyPprPlanDraft("project-1", {}),
      components: [
        { id: "root", name: "整机", kind: "product" as const },
        { id: "child", name: "总成", kind: "product" as const, parentComponentId: "root" },
        { id: "leaf", name: "零件", kind: "part" as const, parentComponentId: "child" },
        { id: "other", name: "备件", kind: "part" as const },
      ],
    };
    expect(availablePprParents(draft, "root").map((item) => item.id)).toEqual(["other"]);
  });

  it("stores and removes a condition on a precedence relation through the typed draft", () => {
    const draft = clonePprVersionAsDraft(savedVersion());
    const conditioned = setPprPrecedenceRelationCondition(draft, "relation-1", {
      expression: "variant == 'EU'",
      description: "仅欧盟版本执行该前置约束",
    });

    expect(conditioned.precedenceRelations[0]?.condition).toEqual({
      expression: "variant == 'EU'",
      description: "仅欧盟版本执行该前置约束",
    });
    expect(analyzePprPlanDraft(conditioned).issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid-condition", entityId: "relation-1" }),
    ]));

    const cleared = setPprPrecedenceRelationCondition(conditioned, "relation-1", undefined);
    expect(cleared.precedenceRelations[0]).not.toHaveProperty("condition");
  });

  it("deletes empty variantIds from components, operations and resources", () => {
    const draft = clonePprVersionAsDraft(savedVersion());
    draft.components[0]!.variantIds = ["EU"];
    draft.operations[0]!.variantIds = ["EU"];
    draft.resources[0]!.variantIds = ["EU"];

    const componentCleared = setPprEntityVariantIds(draft, "component", "product-1", []);
    expect(componentCleared.components[0]).not.toHaveProperty("variantIds");
    expect(componentCleared.operations[0]?.variantIds).toEqual(["EU"]);

    const operationCleared = setPprEntityVariantIds(componentCleared, "operation", "operation-1", []);
    expect(operationCleared.operations[0]).not.toHaveProperty("variantIds");
    expect(operationCleared.resources[0]?.variantIds).toEqual(["EU"]);

    const resourceCleared = setPprEntityVariantIds(operationCleared, "resource", "resource-1", []);
    expect(resourceCleared.resources[0]).not.toHaveProperty("variantIds");
  });
});

function savedVersion(): PprBopVersion {
  const draft: PprBopVersionDraft = {
    planId: "pd-lite-project-1",
    name: "装配计划",
    targetTaktMinutes: 7.5,
    references: [{ kind: "scene", id: "scene-1" }],
    components: [
      { id: "product-1", name: "整机", kind: "product" },
      { id: "part-1", name: "零件", kind: "part", parentComponentId: "product-1" },
    ],
    operations: [
      {
        id: "operation-1",
        name: "定位",
        standardTimeMinutes: 2,
        componentRefs: [{ componentId: "part-1", role: "in-process" }],
        workInstruction: {
          steps: [{ id: "position-step-1", instruction: "将零件放入定位夹具" }],
          safetyNotes: [],
          qualityChecks: [{ id: "position-quality-1", checkpoint: "定位状态", acceptanceCriteria: "定位销完全入位" }],
        },
      },
      { id: "operation-2", name: "装配", standardTimeMinutes: 3, componentRefs: [{ componentId: "product-1", role: "output" }] },
    ],
    precedenceRelations: [{ id: "relation-1", predecessorOperationId: "operation-1", successorOperationId: "operation-2" }],
    resources: [{ id: "resource-1", name: "工位", kind: "station", capacity: 1 }],
    resourceAssignments: [{ id: "assignment-1", operationId: "operation-1", resourceId: "resource-1" }],
  };
  return { ...draft, id: "version-1", version: "v1", createdAt: "2026-09-03T08:00:00.000Z" };
}
