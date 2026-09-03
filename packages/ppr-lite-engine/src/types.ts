import type {
  PprComponent,
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
} from "@bim-studio/contracts";

export type PprIssueSeverity = "error" | "warning";

export interface PprIssue {
  code: string;
  severity: PprIssueSeverity;
  entityType: "version" | "component" | "operation" | "precedence" | "resource" | "assignment";
  entityId: string;
  message: string;
}

export interface PprScheduledOperation {
  operationId: string;
  startMinutes: number;
  endMinutes: number;
  criticalPredecessorId?: string;
}

export interface PprCriticalPath {
  operationIds: string[];
  durationMinutes: number;
}

export interface PprResourceLoad {
  resourceId: string;
  assignedMinutes: number;
  availableMinutes: number;
  utilization: number;
}

export interface PprResourceConflict {
  resourceId: string;
  startMinutes: number;
  endMinutes: number;
  operationIds: string[];
  requiredCapacity: number;
  availableCapacity: number;
}

export interface PprStationBalance {
  resourceId: string;
  operationIds: string[];
  assignedMinutes: number;
  stationUnits: number;
  loadPerUnitMinutes: number;
  taktUtilization: number | null;
  status: "not-configured" | "underloaded" | "balanced" | "overloaded";
}

export interface PprLineBalance {
  targetTaktMinutes: number | null;
  totalWorkContentMinutes: number;
  configuredStationUnits: number;
  theoreticalMinimumStationUnits: number | null;
  balanceEfficiency: number | null;
  stationLoads: PprStationBalance[];
  unassignedOperationIds: string[];
  overloadedResourceIds: string[];
}

export interface PprVariantEntitySet {
  componentIds: string[];
  operationIds: string[];
  precedenceRelationIds: string[];
  resourceIds: string[];
  assignmentIds: string[];
}

/** Explicit variant filtering only. Free-form conditions remain visible evidence and are never guessed. */
export interface PprVariantScope {
  activeVariantId: string | null;
  availableVariantIds: string[];
  knownVariant: boolean;
  included: PprVariantEntitySet;
  excluded: PprVariantEntitySet;
  unresolvedConditionIds: string[];
}

export interface PprQualityControlCoverage {
  operationCount: number;
  coveredOperationCount: number;
  completeOperationCount: number;
  controlPointCount: number;
  completeControlPointCount: number;
  missingOperationIds: string[];
  incompleteOperationIds: string[];
  qualityPlanReady: boolean;
  /** Definition evidence only; this does not claim measurement capture or SPC execution. */
  evidenceScope: "control-plan-definition-only";
}

export interface PprAnalysis {
  issues: PprIssue[];
  topologicalOrder: string[];
  schedule: PprScheduledOperation[];
  criticalPath: PprCriticalPath;
  resourceLoads: PprResourceLoad[];
  resourceConflicts: PprResourceConflict[];
  lineBalance: PprLineBalance;
  variantScope: PprVariantScope;
  qualityControl: PprQualityControlCoverage;
}

export type PprChangeType = "added" | "removed" | "modified";
export type PprChangeEntityType = "plan" | "component" | "operation" | "precedence" | "resource" | "assignment";

export interface PprVersionChange {
  entityType: PprChangeEntityType;
  entityId: string;
  changeType: PprChangeType;
  changedFields: string[];
}

export interface PprVersionImpact {
  componentIds: string[];
  operationIds: string[];
  resourceIds: string[];
}

export interface PprRegression {
  code: "critical-path-increased" | "new-validation-error" | "resource-conflict-introduced" | "standard-time-increased" | "takt-overload-introduced";
  message: string;
  entityIds: string[];
}

export interface PprVersionComparison {
  before: PprAnalysis;
  after: PprAnalysis;
  changes: PprVersionChange[];
  impact: PprVersionImpact;
  regressions: PprRegression[];
}

export interface PprValidatedVersion {
  issues: PprIssue[];
  components: Map<string, PprComponent>;
  operations: Map<string, PprOperation>;
  resources: Map<string, PprResource>;
  relations: PprPrecedenceRelation[];
  assignments: PprOperationResourceAssignment[];
}
