import type {
  PprBopVersion,
  PprComponent,
  PprExternalReference,
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
  PprWorkInstructionQualityCheck,
  PprWorkInstructionVisualReference,
} from "@bim-studio/contracts";
import type { PprIssue, PprIssueSeverity, PprValidatedVersion } from "./types.js";
import { pprQualityControlGaps, type PprQualityControlGap } from "./qualityControls.js";

export function validatePprBopVersion(version: PprBopVersion): PprValidatedVersion {
  const issues: PprIssue[] = [];
  const components = indexEntities(version.components, "component", issues);
  const operations = indexEntities(version.operations, "operation", issues);
  const resources = indexEntities(version.resources, "resource", issues);

  validateVersion(version, issues);
  version.components.forEach((component) => validateComponent(component, components, issues));
  version.operations.forEach((operation) => validateOperation(operation, components, version.references, issues));
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
  if (version.targetTaktMinutes !== undefined && !isPositive(version.targetTaktMinutes)) {
    addIssue(issues, "invalid-target-takt", "error", "version", version.id, "目标节拍必须是正有限分钟数。");
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

function validateOperation(
  operation: PprOperation,
  components: Map<string, PprComponent>,
  planReferences: PprExternalReference[] | undefined,
  issues: PprIssue[],
): void {
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
  validateWorkInstruction(operation, planReferences, issues);
}

function validateWorkInstruction(
  operation: PprOperation,
  planReferences: PprExternalReference[] | undefined,
  issues: PprIssue[],
): void {
  const instruction = operation.workInstruction;
  if (!instruction) {
    addIssue(issues, "missing-quality-control", "warning", "operation", operation.id, "工序尚未定义质量控制点，计划不能标记为质量就绪。");
    return;
  }

  if (!Array.isArray(instruction.steps) || instruction.steps.length === 0) {
    addIssue(issues, "missing-work-instruction-step", "error", "operation", operation.id, "电子作业指导书至少需要一个操作步骤。");
  } else {
    validateInstructionItems(instruction.steps, ["instruction"], "操作步骤", operation.id, issues);
  }
  validateInstructionItems(instruction.safetyNotes, ["note"], "安全注意", operation.id, issues);
  validateQualityControls(instruction.qualityChecks, operation.id, issues);

  const visualReferences = instruction.visualReferences;
  validateReferences(visualReferences, "operation", operation.id, issues);
  const availableReferences = new Set(
    [...(planReferences ?? []), ...(operation.references ?? [])]
      .filter(isVisualReference)
      .map(referenceKey),
  );
  visualReferences?.forEach((reference) => {
    if (!isVisualReference(reference)) {
      addIssue(issues, "invalid-work-instruction-visual-reference", "error", "operation", operation.id, "作业指导书视觉上下文只支持 scene 或 object ID。");
      return;
    }
    if (!availableReferences.has(referenceKey(reference))) {
      addIssue(issues, "unlinked-work-instruction-visual-reference", "warning", "operation", operation.id, `视觉上下文 ${reference.kind}:${reference.id} 未在计划或工序引用中登记。`);
    }
  });
}

function validateQualityControls(
  checks: unknown,
  operationId: string,
  issues: PprIssue[],
): void {
  if (!Array.isArray(checks)) {
    addIssue(issues, "invalid-work-instruction-structure", "error", "operation", operationId, "质量控制点必须是列表。");
    return;
  }
  if (checks.length === 0) {
    addIssue(issues, "missing-quality-control", "warning", "operation", operationId, "工序尚未定义质量控制点，计划不能标记为质量就绪。");
    return;
  }

  const ids = new Set<string>();
  checks.forEach((value) => {
    if (!isRecord(value) || !hasText(value.id) || ids.has(value.id)) {
      addIssue(issues, "invalid-quality-control", "error", "operation", operationId, "质量控制点 ID 必须非空且不重复。");
      return;
    }
    ids.add(value.id);
    const check = value as unknown as PprWorkInstructionQualityCheck;
    if (!hasText(check.checkpoint)) {
      addIssue(issues, "invalid-quality-control", "error", "operation", operationId, `质量控制点 ${check.id} 的特性名称不能为空。`);
    }
    validateQualitySpecification(check, operationId, issues);
    validateQualitySampling(check, operationId, issues);
    if (check.inspectionMethod !== undefined && !hasText(check.inspectionMethod)) {
      addIssue(issues, "invalid-quality-control-method", "error", "operation", operationId, `质量控制点 ${check.id} 的检测方法不能为空。`);
    }
    if (check.outOfControlReaction !== undefined && !hasText(check.outOfControlReaction)) {
      addIssue(issues, "invalid-quality-control-reaction", "error", "operation", operationId, `质量控制点 ${check.id} 的失控反应不能为空。`);
    }
    const gaps = pprQualityControlGaps(check);
    if (gaps.length) {
      addIssue(issues, "incomplete-quality-control", "warning", "operation", operationId, `质量控制点 ${check.checkpoint.trim() || check.id} 仍缺少：${gaps.map(qualityGapLabel).join("、")}。`);
    }
  });
}

function validateQualitySpecification(
  check: PprWorkInstructionQualityCheck,
  operationId: string,
  issues: PprIssue[],
): void {
  const hasLimits = check.lowerLimit !== undefined || check.upperLimit !== undefined;
  const hasTolerance = check.tolerance !== undefined;
  if (!check.specificationKind) {
    if (hasLimits || hasTolerance || check.targetValue !== undefined) {
      addIssue(issues, "invalid-quality-specification", "error", "operation", operationId, `质量控制点 ${check.id} 有数值规格但未声明上下限或公差模式。`);
    }
    return;
  }
  if (check.unit !== undefined && !hasText(check.unit)) {
    addIssue(issues, "invalid-quality-specification", "error", "operation", operationId, `质量控制点 ${check.id} 的单位不能为空。`);
  }
  if (check.specificationKind === "limits") {
    if (!isFiniteNumber(check.lowerLimit) || !isFiniteNumber(check.upperLimit) || check.lowerLimit > check.upperLimit) {
      addIssue(issues, "invalid-quality-limits", "error", "operation", operationId, `质量控制点 ${check.id} 的下限必须小于或等于上限。`);
      return;
    }
    if (hasTolerance) {
      addIssue(issues, "invalid-quality-specification", "error", "operation", operationId, `质量控制点 ${check.id} 不能同时使用上下限和公差。`);
    }
    if (check.targetValue !== undefined && (!isFiniteNumber(check.targetValue) || check.targetValue < check.lowerLimit || check.targetValue > check.upperLimit)) {
      addIssue(issues, "invalid-quality-target", "error", "operation", operationId, `质量控制点 ${check.id} 的目标值必须位于上下限之间。`);
    }
    return;
  }
  if (check.specificationKind === "tolerance") {
    if (!isFiniteNumber(check.targetValue) || !isFiniteNumber(check.tolerance) || check.tolerance <= 0) {
      addIssue(issues, "invalid-quality-tolerance", "error", "operation", operationId, `质量控制点 ${check.id} 的目标值必须有限且公差必须大于 0。`);
    }
    if (hasLimits) {
      addIssue(issues, "invalid-quality-specification", "error", "operation", operationId, `质量控制点 ${check.id} 不能同时使用公差和上下限。`);
    }
    return;
  }
  addIssue(issues, "invalid-quality-specification", "error", "operation", operationId, `质量控制点 ${check.id} 的规格模式无效。`);
}

function validateQualitySampling(
  check: PprWorkInstructionQualityCheck,
  operationId: string,
  issues: PprIssue[],
): void {
  const frequency = check.samplingFrequency;
  if (!frequency) return;
  const modes = ["every-item", "first-off", "every-n-items", "per-batch", "once-per-shift"];
  if (!isRecord(frequency) || !modes.includes(String(frequency.mode))) {
    addIssue(issues, "invalid-quality-sampling", "error", "operation", operationId, `质量控制点 ${check.id} 的抽检频率无效。`);
    return;
  }
  if (frequency.mode === "every-n-items") {
    if (!Number.isSafeInteger(frequency.interval) || Number(frequency.interval) <= 0) {
      addIssue(issues, "invalid-quality-sampling", "error", "operation", operationId, `质量控制点 ${check.id} 的抽检间隔必须是正整数件数。`);
    }
  } else if (frequency.interval !== undefined) {
    addIssue(issues, "invalid-quality-sampling", "error", "operation", operationId, `质量控制点 ${check.id} 仅“每 N 件”模式可以填写抽检间隔。`);
  }
}

const QUALITY_GAP_LABELS: Record<PprQualityControlGap, string> = {
  characteristic: "特性名称",
  specification: "目标与上下限/公差",
  "inspection-method": "检测方法",
  "sampling-frequency": "抽检频率",
  "reaction-plan": "失控反应",
};

function qualityGapLabel(gap: PprQualityControlGap): string {
  return QUALITY_GAP_LABELS[gap];
}

function validateInstructionItems(
  items: unknown,
  textFields: string[],
  label: string,
  operationId: string,
  issues: PprIssue[],
): void {
  if (!Array.isArray(items)) {
    addIssue(issues, "invalid-work-instruction-structure", "error", "operation", operationId, `${label}必须是列表。`);
    return;
  }
  const ids = new Set<string>();
  items.forEach((item) => {
    if (!isRecord(item) || !hasText(item.id) || ids.has(item.id)) {
      addIssue(issues, "invalid-work-instruction-item", "error", "operation", operationId, `${label} ID 必须非空且不重复。`);
      return;
    }
    ids.add(item.id);
    if (textFields.some((field) => !hasText(item[field]))) {
      addIssue(issues, "invalid-work-instruction-item", "error", "operation", operationId, `${label}内容不能为空。`);
    }
  });
}

function isVisualReference(reference: { kind: string; id: string }): reference is PprWorkInstructionVisualReference {
  return (reference.kind === "scene" || reference.kind === "object") && hasText(reference.id);
}

function referenceKey(reference: { kind: string; id: string }): string {
  return `${reference.kind}:${reference.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
