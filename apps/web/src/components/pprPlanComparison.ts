import type { PprBopVersion } from "@bim-studio/contracts";
import type { PprVersionComparison } from "@bim-studio/ppr-lite-engine";

export interface PprBoundVersionComparison {
  beforeVersionId: string;
  afterVersionId: string;
  activeVariantId: string;
  result: PprVersionComparison;
}

export function bindPprVersionComparison(
  beforeVersionId: string,
  afterVersionId: string,
  result: PprVersionComparison,
  activeVariantId = "",
): PprBoundVersionComparison {
  return { beforeVersionId, afterVersionId, activeVariantId, result };
}

/** Never expose a comparison under selectors different from the request that produced it. */
export function currentPprVersionComparison(
  comparison: PprBoundVersionComparison | undefined,
  beforeVersionId: string,
  afterVersionId: string,
  activeVariantId = "",
): PprBoundVersionComparison | undefined {
  return comparison?.beforeVersionId === beforeVersionId
    && comparison.afterVersionId === afterVersionId
    && comparison.activeVariantId === activeVariantId
    ? comparison
    : undefined;
}

/** Resolve labels only from the immutable snapshots that produced the comparison. */
export function pprComparisonEntityName(
  entityId: string,
  comparison: PprBoundVersionComparison,
  versions: readonly PprBopVersion[],
): string {
  const after = versions.find((version) => version.id === comparison.afterVersionId);
  const before = versions.find((version) => version.id === comparison.beforeVersionId);
  for (const snapshot of [after, before]) {
    if (!snapshot) continue;
    if (entityId === snapshot.planId) return snapshot.name || entityId;
    const entity = [...snapshot.components, ...snapshot.operations, ...snapshot.resources]
      .find((item) => item.id === entityId);
    if (entity) return entity.name || entityId;
  }
  return entityId;
}
