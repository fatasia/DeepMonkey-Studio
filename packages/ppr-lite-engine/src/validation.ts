import type {
  PprBopVersion,
  PprComponent,
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
} from "@bim-studio/contracts";
import type { PprIssue, PprIssueSeverity, PprValidatedVersion } from "./types.js";

export function validatePprBopVersion(version: PprBopVersion): PprValidatedVersion {
  const issues: PprIssue[] = [];
  const components = indexEntities(version.components, "component", issues);
  const operations = indexEntities(version.operations, "operation", issues);
  const resources = indexEntities(version.resources, "resource", issues);

  validateVersion(version, issues);
  version.components.forEach((component) => validateComponent(component, components, issues));
  version.operations.forEach((operation) => validateOperation(operation, components, issues));
  version.resources.forEach((resource) => validateResource(resource, issues));

  const relations = validateRelations(version.precedenceRelations, operations, issues);
  const assignments = validateAssignments(version.resourceAssignments, operations, resources, issues);
  inspectIsolatedEntities(version, relations, assignments, issues);
  inspectComponentCycles(version.components, components, issues);

  return { issues, components, operations, resources, relations, assignments };
}

function validateVersion(version: PprBopVersion, issues: PprIssue[]): void {
  if (!hasText(version.id) || !hasText(version.planId) || !hasText(version.version) || !hasText(version.name)) {
    addIssue(issues, "invalid-version", "error", "version", version.id || "(missing)", "版本 ID、计划 ID、版本号和名称不能为空。");
  }
  if (!isIsoDate(version.createdAt)) {
    addIssue(issues, "invalid-created-at", "error", "version", version.id, "createdAt 必须是有效 ISO 日期时间。");
  }
  validateVariants(version.variantIds, "version", version.id, issues);
  validateCondition(version.condition, "version", version.id, issues);
  validateReferences(version.references, "version", version.id, issues);
}

function validateComponent(component: PprComponent, components: Map<string, PprComponent>, issues: PprIssue[]): void {
  if (!hasText(component.name)) {
    addIssue(issues, "invalid-component", "error", "component", component.id, "零部件名称不能为空。");
  }
  if (component.kind !== "product" && component.kind !== "part") {
    addIssue(issues, "invalid-component-kind", "error", "component", component.id, "零部件类型必须是 product 或 part。");
  }
  if (component.parentComponentId && !components.has(component.parentComponentId)) {
    addIssue(issues, "missing-parent-component", "error", "component", component.id, "零部件父级引用不存在。");
  }
  validateVariants(component.variantIds, "component", component.id, issues);
  validateCondition(component.condition, "component", component.id, issues);
  validateReferences(component.references, "component", component.id, issues);
}

function validateOperation(operation: PprOperation, components: Map<string, PprComponent>, issues: PprIssue[]): void {
  if (!hasText(operation.name)) {
    addIssue(issues, "invalid-operation", "error", "operation", operation.id, "工序名称不能为空。");
  }
  if (!isPositive(operation.standardTimeMinutes)) {
    addIssue(issues, "invalid-standard-time", "error", "operation", operation.id, "标准工时必须是正有限分钟数。");
  }
  if (!operation.componentRefs.length) {
    addIssue(issues, "missing-component-reference", "error", "operation", operation.id, "工序至少需要一个产品或零部件引用。");
  }

  const roles = new Set<string>();
  for (const reference of operation.componentRefs) {
    if (!components.has(reference.componentId)) {
      addIssue(issues, "missing-component-reference", "error", "operation", operation.id, `工序引用了不存在的零部件 ${reference.componentId}。`);
    }
    if (!["input", "output", "in-process"].includes(reference.role)) {
      addIssue(issues, "invalid-component-role", "error", "operation", operation.id, "零部件引用角色无效。");
    }
    if (!isPositive(reference.quantity ?? 1)) {
      addIssue(issues, "invalid-component-quantity", "error", "operation", operation.id, "零部件数量必须是正有限数。");
    }
    roles.add(`${reference.componentId}:${reference.role}`);
  }
  if (roles.size !== operation.componentRefs.length) {
    addIssue(issues, "duplicate-component-reference", "warning", "operation", operation.id, "同一工序存在重复的零部件角色引用。");
  }
  validateVariants(operation.variantIds, "operation", operation.id, issues);
  validateCondition(operation.condition, "operation", operation.id, issues);
  validateReferences(operation.references, "operation", operation.id, issues);
}

function validateResource(resource: PprResource, issues: PprIssue[]): void {
  if (!hasText(resource.name)) {
    addIssue(issues, "invalid-resource", "error", "resource", resource.id, "资源名称不能为空。");
  }
  if (!["station", "equipment", "robot", "tool", "person"].includes(resource.kind)) {
    addIssue(issues, "invalid-resource-kind", "error", "resource", resource.id, "资源类型无效。");
  }
  if (!isPositive(resource.capacity ?? 1)) {
    addIssue(issues, "invalid-resource-capacity", "error", "resource", resource.id, "资源能力必须是正有限数。");
  }
  validateVariants(resource.variantIds, "resource", resource.id, issues);
  validateCondition(resource.condition, "resource", resource.id, issues);
  validateReferences(resource.references, "resource", resource.id, issues);
}

function validateRelations(relations: PprPrecedenceRelation[], operations: Map<string, PprOperation>, issues: PprIssue[]): PprPrecedenceRelation[] {
  const ids = new Set<string>();
  return relations.filter((relation) => {
    if (!claimId(relation.id, ids, "precedence", issues)) return false;
    validateCondition(relation.condition, "precedence", relation.id, issues);
    if (!operations.has(relation.predecessorOperationId) || !operations.has(relation.successorOperationId)) {
      addIssue(issues, "missing-operation-reference", "error", "precedence", relation.id, "前置关系引用了不存在的工序。");
      return false;
    }
    if (!isNonNegative(relation.minimumLagMinutes)) {
      addIssue(issues, "invalid-lag", "error", "precedence", relation.id, "最小等待时间必须是非负有限分钟数。");
      return false;
    }
    return true;
  });
}

function validateAssignments(assignments: PprOperationResourceAssignment[], operations: Map<string, PprOperation>, resources: Map<string, PprResource>, issues: PprIssue[]): PprOperationResourceAssignment[] {
  const ids = new Set<string>();
  return assignments.filter((assignment) => {
    if (!claimId(assignment.id, ids, "assignment", issues)) return false;
    if (!operations.has(assignment.operationId) || !resources.has(assignment.resourceId)) {
      addIssue(issues, "missing-assignment-reference", "error", "assignment", assignment.id, "资源分配引用了不存在的工序或资源。");
      return false;
    }
    if (!isPositive(assignment.requiredCapacity ?? 1)) {
      addIssue(issues, "invalid-required-capacity", "error", "assignment", assignment.id, "资源占用单位必须是正有限数。");
      return false;
    }
    return true;
  });
}

function inspectIsolatedEntities(version: PprBopVersion, relations: PprPrecedenceRelation[], assignments: PprOperationResourceAssignment[], issues: PprIssue[]): void {
  const connectedOperations = new Set(relations.flatMap((item) => [item.predecessorOperationId, item.successorOperationId]));
  if (version.operations.length > 1) {
    version.operations.filter((operation) => !connectedOperations.has(operation.id)).forEach((operation) => {
      addIssue(issues, "isolated-operation", "warning", "operation", operation.id, "工序没有前置或后续关系。");
    });
  }

  const referencedComponents = new Set(version.operations.flatMap((operation) => operation.componentRefs.map((reference) => reference.componentId)));
  const parentComponents = new Set(version.components.flatMap((component) => component.parentComponentId ? [component.parentComponentId] : []));
  version.components.filter((component) => !referencedComponents.has(component.id) && !parentComponents.has(component.id)).forEach((component) => {
    addIssue(issues, "isolated-component", "warning", "component", component.id, "零部件未被任何工序引用，也不是其他零部件的父级。");
  });

  const assignedResources = new Set(assignments.map((assignment) => assignment.resourceId));
  version.resources.filter((resource) => !assignedResources.has(resource.id)).forEach((resource) => {
    addIssue(issues, "unused-resource", "warning", "resource", resource.id, "资源没有被任何工序分配。");
  });
}

function inspectComponentCycles(components: PprComponent[], byId: Map<string, PprComponent>, issues: PprIssue[]): void {
  components.forEach((component) => {
    const seen = new Set<string>();
    let current: PprComponent | undefined = component;
    while (current?.parentComponentId) {
      if (seen.has(current.id)) {
        addIssue(issues, "component-cycle", "error", "component", component.id, "零部件父级关系存在环。");
        return;
      }
      seen.add(current.id);
      current = byId.get(current.parentComponentId);
    }
  });
}

function indexEntities<T extends { id: string }>(items: T[], entityType: PprIssue["entityType"], issues: PprIssue[]): Map<string, T> {
  const indexed = new Map<string, T>();
  items.forEach((item) => {
    if (claimId(item.id, indexed, entityType, issues)) indexed.set(item.id, item);
  });
  return indexed;
}

function claimId(id: string, collection: Set<string> | Map<string, unknown>, entityType: PprIssue["entityType"], issues: PprIssue[]): boolean {
  if (!hasText(id)) {
    addIssue(issues, "invalid-id", "error", entityType, "(missing)", "ID 不能为空。");
    return false;
  }
  if (collection.has(id)) {
    addIssue(issues, "duplicate-id", "error", entityType, id, "ID 在同一集合中重复。");
    return false;
  }
  if (collection instanceof Set) collection.add(id);
  return true;
}

function validateVariants(variantIds: string[] | undefined, entityType: PprIssue["entityType"], entityId: string, issues: PprIssue[]): void {
  if (variantIds && (variantIds.some((variantId) => !hasText(variantId)) || new Set(variantIds).size !== variantIds.length)) {
    addIssue(issues, "invalid-variants", "error", entityType, entityId, "适用变体 ID 必须非空且不重复。");
  }
}

function validateCondition(condition: { expression: string } | undefined, entityType: PprIssue["entityType"], entityId: string, issues: PprIssue[]): void {
  if (condition && !hasText(condition.expression)) {
    addIssue(issues, "invalid-condition", "error", entityType, entityId, "适用条件表达式不能为空。");
  }
}

function validateReferences(references: { kind: string; id: string }[] | undefined, entityType: PprIssue["entityType"], entityId: string, issues: PprIssue[]): void {
  const seen = new Set<string>();
  references?.forEach((reference) => {
    const key = `${reference.kind}:${reference.id}`;
    if (!["scene", "object", "script", "study"].includes(reference.kind) || !hasText(reference.id) || seen.has(key)) {
      addIssue(issues, "invalid-external-reference", "error", entityType, entityId, "外部引用必须是唯一且有效的 scene/object/script/study ID。");
    }
    seen.add(key);
  });
}

function addIssue(issues: PprIssue[], code: string, severity: PprIssueSeverity, entityType: PprIssue["entityType"], entityId: string, message: string): void {
  issues.push({ code, severity, entityType, entityId, message });
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

function isIsoDate(value: string): boolean {
  return hasText(value) && Number.isFinite(Date.parse(value));
}
