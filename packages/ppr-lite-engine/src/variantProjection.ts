import type { PprBopVersion } from "@bim-studio/contracts";
import type { PprIssue, PprVariantEntitySet, PprVariantScope } from "./types.js";

export interface PprVariantProjection {
  version: PprBopVersion;
  scope: PprVariantScope;
  issues: PprIssue[];
}

export function collectPprVariantIds(version: Pick<PprBopVersion, "variantIds" | "components" | "operations" | "resources">): string[] {
  return [...new Set([
    ...(version.variantIds ?? []),
    ...version.components.flatMap((item) => item.variantIds ?? []),
    ...version.operations.flatMap((item) => item.variantIds ?? []),
    ...version.resources.flatMap((item) => item.variantIds ?? []),
  ].map((item) => item.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function projectPprVariant(version: PprBopVersion, requestedVariantId?: string): PprVariantProjection {
  const activeVariantId = requestedVariantId?.trim() || null;
  const availableVariantIds = collectPprVariantIds(version);
  // A legacy/base plan with no declarations applies to every variant. Once a
  // catalog exists, misspelled or undeclared selections must fail explicitly.
  const knownVariant = activeVariantId === null
    || availableVariantIds.length === 0
    || availableVariantIds.includes(activeVariantId);
  const applicable = (variantIds?: string[]) => activeVariantId === null
    || !variantIds?.length
    || variantIds.some((variantId) => variantId.trim() === activeVariantId);

  const components = version.components.filter((item) => applicable(item.variantIds));
  const operations = version.operations.filter((item) => applicable(item.variantIds));
  const resources = version.resources.filter((item) => applicable(item.variantIds));
  const componentIds = new Set(components.map((item) => item.id));
  const operationIds = new Set(operations.map((item) => item.id));
  const resourceIds = new Set(resources.map((item) => item.id));
  // A base analysis is also the validation boundary. Preserve broken references
  // so validation can report their real IDs instead of silently turning them into
  // generic "missing" messages. Filtering is only valid for an explicit variant.
  const precedenceRelations = activeVariantId === null
    ? version.precedenceRelations
    : version.precedenceRelations.filter((item) =>
      operationIds.has(item.predecessorOperationId) && operationIds.has(item.successorOperationId));
  const resourceAssignments = activeVariantId === null
    ? version.resourceAssignments
    : version.resourceAssignments.filter((item) =>
      operationIds.has(item.operationId) && resourceIds.has(item.resourceId));

  const projectedOperations = operations.map((operation) => ({
    ...operation,
    componentRefs: activeVariantId === null
      ? operation.componentRefs
      : operation.componentRefs.filter((reference) => componentIds.has(reference.componentId)),
  }));
  const projected: PprBopVersion = {
    ...structuredClone(version),
    components: structuredClone(components),
    operations: structuredClone(projectedOperations),
    precedenceRelations: structuredClone(precedenceRelations),
    resources: structuredClone(resources),
    resourceAssignments: structuredClone(resourceAssignments),
  };
  const included = entitySet(projected);
  const excluded = difference(entitySet(version), included);
  const unresolvedConditionIds = activeVariantId === null ? [] : collectConditionIds(projected);
  const issues: PprIssue[] = [];

  if (!knownVariant && activeVariantId) {
    issues.push({
      code: "unknown-active-variant",
      severity: "error",
      entityType: "version",
      entityId: version.id,
      message: `分析变体 ${activeVariantId} 未在当前版本声明。`,
    });
  }
  if (unresolvedConditionIds.length) {
    issues.push({
      code: "variant-condition-not-evaluated",
      severity: "warning",
      entityType: "version",
      entityId: version.id,
      message: `${unresolvedConditionIds.length} 项自由条件未自动执行；当前结果只按明确的变体 ID 过滤。`,
    });
  }

  return {
    version: projected,
    issues,
    scope: { activeVariantId, availableVariantIds, knownVariant, included, excluded, unresolvedConditionIds },
  };
}

function entitySet(version: PprBopVersion): PprVariantEntitySet {
  return {
    componentIds: version.components.map((item) => item.id),
    operationIds: version.operations.map((item) => item.id),
    precedenceRelationIds: version.precedenceRelations.map((item) => item.id),
    resourceIds: version.resources.map((item) => item.id),
    assignmentIds: version.resourceAssignments.map((item) => item.id),
  };
}

function difference(all: PprVariantEntitySet, included: PprVariantEntitySet): PprVariantEntitySet {
  const omitted = <T extends keyof PprVariantEntitySet>(key: T) => {
    const visible = new Set(included[key]);
    return all[key].filter((id) => !visible.has(id));
  };
  return {
    componentIds: omitted("componentIds"),
    operationIds: omitted("operationIds"),
    precedenceRelationIds: omitted("precedenceRelationIds"),
    resourceIds: omitted("resourceIds"),
    assignmentIds: omitted("assignmentIds"),
  };
}

function collectConditionIds(version: PprBopVersion): string[] {
  return [
    ...(version.condition ? [version.id] : []),
    ...version.components.filter((item) => item.condition).map((item) => item.id),
    ...version.operations.filter((item) => item.condition).map((item) => item.id),
    ...version.precedenceRelations.filter((item) => item.condition).map((item) => item.id),
    ...version.resources.filter((item) => item.condition).map((item) => item.id),
  ];
}
