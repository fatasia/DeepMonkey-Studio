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

export interface PprAnalysis {
  issues: PprIssue[];
  topologicalOrder: string[];
  schedule: PprScheduledOperation[];
  criticalPath: PprCriticalPath;
  resourceLoads: PprResourceLoad[];
  resourceConflicts: PprResourceConflict[];
}

export type PprChangeType = "added" | "removed" | "modified";
export type PprChangeEntityType = "component" | "operation" | "precedence" | "resource" | "assignment";

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
  code: "critical-path-increased" | "new-validation-error" | "resource-conflict-introduced" | "standard-time-increased";
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
