import type {
  PprBopVersion,
  PprBopVersionDraft,
  PprComponentKind,
  PprCondition,
  PprExternalReference,
  PprOperation,
  PprResourceKind,
} from "@bim-studio/contracts";
import { analyzePprBopVersion, collectPprVariantIds, type PprAnalysis } from "@bim-studio/ppr-lite-engine";

export interface PprPlanReferenceContext {
  sceneId?: string;
  objectId?: string;
  scriptId?: string;
  studyId?: string;
}

export type PprPlanSection = "product" | "operations" | "resources";
export type PprVariantEntityType = "component" | "operation" | "resource";

const DRAFT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/** 新计划从空白结构开始，只继承真实存在的上下文引用，不再生成演示工序。 */
export function createEmptyPprPlanDraft(
  projectId: string,
  references: PprPlanReferenceContext,
): PprBopVersionDraft {
  return {
    planId: `pd-lite-${projectId}`,
    name: "新建工艺计划",
    references: externalReferences(references),
    components: [],
    operations: [],
    precedenceRelations: [],
    resources: [],
    resourceAssignments: [],
  };
}

/** 版本快照永不原地编辑；作者界面只在深拷贝草稿上工作。 */
export function clonePprVersionAsDraft(version: PprBopVersion): PprBopVersionDraft {
  const cloned = structuredClone(version);
  return {
    planId: cloned.planId,
    name: cloned.name,
    basedOnVersionId: cloned.id,
    ...(cloned.targetTaktMinutes !== undefined ? { targetTaktMinutes: cloned.targetTaktMinutes } : {}),
    components: cloned.components,
    operations: cloned.operations,
    precedenceRelations: cloned.precedenceRelations,
    resources: cloned.resources,
    resourceAssignments: cloned.resourceAssignments,
    ...(cloned.variantIds ? { variantIds: cloned.variantIds } : {}),
    ...(cloned.condition ? { condition: cloned.condition } : {}),
    ...(cloned.references ? { references: cloned.references } : {}),
  };
}

/** 直接运行既有 PD Lite 引擎，让草稿在保存前得到同一套确定性诊断。 */
export function analyzePprPlanDraft(draft: PprBopVersionDraft, activeVariantId?: string): PprAnalysis {
  return analyzePprBopVersion({
    ...structuredClone(draft),
    id: "__draft__",
    version: draft.version?.trim() || "draft",
    createdAt: DRAFT_TIMESTAMP,
  }, activeVariantId);
}

export function collectPprPlanVariantIds(draft: PprBopVersionDraft): string[] {
  return collectPprVariantIds(draft);
}

export function hasPersistablePprContent(draft: PprBopVersionDraft): boolean {
  return draft.components.length > 0 && draft.operations.length > 0;
}

export function addPprComponent(draft: PprBopVersionDraft, kind: PprComponentKind): PprBopVersionDraft {
  const id = nextId(kind === "product" ? "product" : "part", draft.components.map((item) => item.id));
  const parentComponentId = kind === "part"
    ? draft.components.find((item) => item.kind === "product")?.id
    : undefined;
  return {
    ...draft,
    components: [...draft.components, {
      id,
      name: kind === "product" ? "新产品" : "新零部件",
      kind,
      ...(parentComponentId ? { parentComponentId } : {}),
    }],
  };
}

export function removePprComponent(draft: PprBopVersionDraft, componentId: string): PprBopVersionDraft {
  return {
    ...draft,
    components: draft.components
      .filter((item) => item.id !== componentId)
      .map((item) => item.parentComponentId === componentId
        ? withoutKey(item, "parentComponentId")
        : item),
    operations: draft.operations.map((operation) => ({
      ...operation,
      componentRefs: operation.componentRefs.filter((reference) => reference.componentId !== componentId),
    })),
  };
}

export function addPprOperation(draft: PprBopVersionDraft): PprBopVersionDraft {
  const id = nextId("operation", draft.operations.map((item) => item.id));
  const componentId = draft.components[0]?.id;
  const predecessor = draft.operations.at(-1);
  return {
    ...draft,
    operations: [...draft.operations, {
      id,
      name: "新工序",
      standardTimeMinutes: 1,
      componentRefs: componentId ? [{ componentId, role: "in-process", quantity: 1 }] : [],
    }],
    precedenceRelations: predecessor
      ? [...draft.precedenceRelations, {
        id: nextId("relation", draft.precedenceRelations.map((item) => item.id)),
        predecessorOperationId: predecessor.id,
        successorOperationId: id,
        minimumLagMinutes: 0,
      }]
      : draft.precedenceRelations,
  };
}

export function removePprOperation(draft: PprBopVersionDraft, operationId: string): PprBopVersionDraft {
  return {
    ...draft,
    operations: draft.operations.filter((item) => item.id !== operationId),
    precedenceRelations: draft.precedenceRelations.filter((item) =>
      item.predecessorOperationId !== operationId && item.successorOperationId !== operationId),
    resourceAssignments: draft.resourceAssignments.filter((item) => item.operationId !== operationId),
  };
}

export function addPprOperationComponentRef(draft: PprBopVersionDraft, operationId: string): PprBopVersionDraft {
  const operation = draft.operations.find((item) => item.id === operationId);
  const component = draft.components.find((item) =>
    !operation?.componentRefs.some((reference) => reference.componentId === item.id && reference.role === "in-process"));
  if (!operation || !component) return draft;
  return updateOperation(draft, operationId, {
    componentRefs: [...operation.componentRefs, { componentId: component.id, role: "in-process", quantity: 1 }],
  });
}

export function addPprPrecedenceRelation(draft: PprBopVersionDraft): PprBopVersionDraft {
  const pair = draft.operations.flatMap((predecessor, predecessorIndex) =>
    draft.operations
      .slice(predecessorIndex + 1)
      .map((successor) => [predecessor, successor] as const))
    .find(([predecessor, successor]) => !draft.precedenceRelations.some((relation) =>
      relation.predecessorOperationId === predecessor.id && relation.successorOperationId === successor.id));
  if (!pair) return draft;
  const [predecessor, successor] = pair;
  return {
    ...draft,
    precedenceRelations: [...draft.precedenceRelations, {
      id: nextId("relation", draft.precedenceRelations.map((item) => item.id)),
      predecessorOperationId: predecessor.id,
      successorOperationId: successor.id,
      minimumLagMinutes: 0,
    }],
  };
}

export function addPprResource(draft: PprBopVersionDraft, kind: PprResourceKind = "station"): PprBopVersionDraft {
  const id = nextId("resource", draft.resources.map((item) => item.id));
  const unassignedOperation = draft.operations.find((operation) =>
    !draft.resourceAssignments.some((assignment) => assignment.operationId === operation.id));
  return {
    ...draft,
    resources: [...draft.resources, {
      id,
      name: "新资源",
      kind,
      capacity: 1,
    }],
    resourceAssignments: unassignedOperation
      ? [...draft.resourceAssignments, {
        id: nextId("assignment", draft.resourceAssignments.map((item) => item.id)),
        operationId: unassignedOperation.id,
        resourceId: id,
        requiredCapacity: 1,
      }]
      : draft.resourceAssignments,
  };
}

export function removePprResource(draft: PprBopVersionDraft, resourceId: string): PprBopVersionDraft {
  return {
    ...draft,
    resources: draft.resources.filter((item) => item.id !== resourceId),
    resourceAssignments: draft.resourceAssignments.filter((item) => item.resourceId !== resourceId),
  };
}

/** Keep optional variant fields canonical so version comparisons do not report missing -> [] noise. */
export function setPprEntityVariantIds(
  draft: PprBopVersionDraft,
  entityType: PprVariantEntityType,
  entityId: string,
  variantIds: string[],
): PprBopVersionDraft {
  if (entityType === "component") {
    return { ...draft, components: draft.components.map((item) => item.id === entityId ? withVariantIds(item, variantIds) : item) };
  }
  if (entityType === "operation") {
    return { ...draft, operations: draft.operations.map((item) => item.id === entityId ? withVariantIds(item, variantIds) : item) };
  }
  return { ...draft, resources: draft.resources.map((item) => item.id === entityId ? withVariantIds(item, variantIds) : item) };
}

export function setPprPrecedenceRelationCondition(
  draft: PprBopVersionDraft,
  relationId: string,
  condition: PprCondition | undefined,
): PprBopVersionDraft {
  return {
    ...draft,
    precedenceRelations: draft.precedenceRelations.map((relation) => {
      if (relation.id !== relationId) return relation;
      const next = { ...relation };
      if (condition) next.condition = condition;
      else delete next.condition;
      return next;
    }),
  };
}

export function addPprResourceAssignment(draft: PprBopVersionDraft): PprBopVersionDraft {
  const pair = draft.operations.flatMap((operation) =>
    draft.resources.map((resource) => [operation, resource] as const))
    .find(([operation, resource]) => !draft.resourceAssignments.some((assignment) =>
      assignment.operationId === operation.id && assignment.resourceId === resource.id));
  if (!pair) return draft;
  const [operation, resource] = pair;
  return {
    ...draft,
    resourceAssignments: [...draft.resourceAssignments, {
      id: nextId("assignment", draft.resourceAssignments.map((item) => item.id)),
      operationId: operation.id,
      resourceId: resource.id,
      requiredCapacity: 1,
    }],
  };
}

/** 父级候选排除自身和全部后代，编辑阶段即阻止 BOM 环。 */
export function availablePprParents(draft: PprBopVersionDraft, componentId: string) {
  const blocked = new Set([componentId]);
  let changed = true;
  while (changed) {
    changed = false;
    draft.components.forEach((item) => {
      if (item.parentComponentId && blocked.has(item.parentComponentId) && !blocked.has(item.id)) {
        blocked.add(item.id);
        changed = true;
      }
    });
  }
  return draft.components.filter((item) => !blocked.has(item.id));
}

function updateOperation(
  draft: PprBopVersionDraft,
  operationId: string,
  patch: Partial<PprOperation>,
): PprBopVersionDraft {
  return {
    ...draft,
    operations: draft.operations.map((item) => item.id === operationId ? { ...item, ...patch } : item),
  };
}

function externalReferences(context: PprPlanReferenceContext): PprExternalReference[] {
  return [
    ...referenceOf("scene", context.sceneId),
    ...referenceOf("object", context.objectId),
    ...referenceOf("script", context.scriptId),
    ...referenceOf("study", context.studyId),
  ];
}

function referenceOf(kind: PprExternalReference["kind"], id: string | undefined): PprExternalReference[] {
  return id?.trim() ? [{ kind, id: id.trim() }] : [];
}

function nextId(prefix: string, ids: string[]): string {
  const occupied = new Set(ids);
  let sequence = ids.length + 1;
  while (occupied.has(`${prefix}-${sequence}`)) sequence += 1;
  return `${prefix}-${sequence}`;
}

function withVariantIds<T extends { variantIds?: string[] }>(value: T, variantIds: string[]): T {
  const next = { ...value };
  if (variantIds.length) next.variantIds = [...variantIds];
  else delete next.variantIds;
  return next;
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
