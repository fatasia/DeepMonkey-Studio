import type { PprBopVersionDraft, PprExternalReference } from "@bim-studio/contracts";

export interface PprPlanReferenceContext {
  sceneId?: string;
  objectId?: string;
  scriptId?: string;
  studyId?: string;
}

/** 默认模板只引用当前上下文已有 ID，不猜测场景对象或 Study。 */
export function createPprPlanDraft(
  projectId: string,
  references: PprPlanReferenceContext,
  basedOnVersionId?: string,
): PprBopVersionDraft {
  return {
    planId: `pd-lite-${projectId}`,
    name: "当前场景工艺计划",
    ...(basedOnVersionId ? { basedOnVersionId } : {}),
    references: externalReferences(references),
    components: [
      {
        id: "assembly",
        name: "当前总成",
        kind: "product",
        references: referenceOf("scene", references.sceneId),
      },
      {
        id: "workpiece",
        name: "当前工件",
        kind: "part",
        parentComponentId: "assembly",
        references: referenceOf("object", references.objectId),
      },
    ],
    operations: [
      {
        id: "locate",
        name: "定位与准备",
        standardTimeMinutes: 4,
        componentRefs: [{ componentId: "workpiece", role: "in-process" }],
        references: referenceOf("script", references.scriptId),
      },
      {
        id: "assemble",
        name: "装配完成",
        standardTimeMinutes: 8,
        componentRefs: [{ componentId: "assembly", role: "output" }],
        references: referenceOf("study", references.studyId),
      },
    ],
    precedenceRelations: [{
      id: "locate-assemble",
      predecessorOperationId: "locate",
      successorOperationId: "assemble",
    }],
    resources: [{
      id: "station",
      name: "当前工位",
      kind: "station",
      references: referenceOf("scene", references.sceneId),
    }],
    resourceAssignments: [
      { id: "locate-station", operationId: "locate", resourceId: "station" },
      { id: "assemble-station", operationId: "assemble", resourceId: "station" },
    ],
  };
}

function externalReferences(references: PprPlanReferenceContext): PprExternalReference[] {
  return [
    ...referenceOf("scene", references.sceneId),
    ...referenceOf("object", references.objectId),
    ...referenceOf("script", references.scriptId),
    ...referenceOf("study", references.studyId),
  ];
}

function referenceOf(kind: PprExternalReference["kind"], id: string | undefined): PprExternalReference[] {
  return id?.trim() ? [{ kind, id }] : [];
}
