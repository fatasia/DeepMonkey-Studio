export type StreamedResourceKind = "geometry" | "texture";

/** Levels are ordered from finest (0) to coarsest. Each level is an independently uploadable resource. */
export interface StreamedResourceLevel {
  readonly level: number;
  readonly byteLength: number;
}

export interface StreamedResourceProfile {
  readonly id: string;
  readonly revision: number;
  readonly kind: StreamedResourceKind;
  readonly levels: readonly StreamedResourceLevel[];
}

export interface ResidencyRequest {
  readonly id: string;
  readonly desiredLevel: number;
  readonly priority?: number;
  readonly required?: boolean;
}

export interface ResidencyBudgets {
  readonly maxResidentBytes: number;
  readonly maxUploadBytesPerFrame: number;
  readonly maxResources?: number;
  readonly retainFrames?: number;
}

export type ResidencySelectionReason =
  | "requested"
  | "quality-reduced"
  | "resident-budget"
  | "upload-budget"
  | "transition-headroom";

export interface ResidencySelection {
  readonly id: string;
  readonly requestedLevel: number;
  readonly targetLevel: number | null;
  readonly reason: ResidencySelectionReason;
}

export interface ResidencyUpload {
  readonly id: string;
  readonly kind: StreamedResourceKind;
  readonly fromRevision: number | null;
  readonly fromLevel: number | null;
  readonly toRevision: number;
  readonly toLevel: number;
  readonly byteLength: number;
}

export interface ResidencyEviction {
  readonly id: string;
  readonly kind: StreamedResourceKind;
  readonly revision: number;
  readonly level: number;
  readonly byteLength: number;
  readonly phase: "before-upload" | "after-swap";
}

export interface ResidencyFramePlan {
  readonly id: number;
  readonly baseRevision: number;
  readonly frame: number;
  readonly selections: readonly ResidencySelection[];
  readonly uploads: readonly ResidencyUpload[];
  readonly evictions: readonly ResidencyEviction[];
  readonly residentBytesBefore: number;
  /** Expected confirmed bytes if every planned upload succeeds. Failed replacements keep their previous bytes. */
  readonly residentBytesAfter: number;
  readonly transitionPeakBytes: number;
  readonly uploadBytes: number;
}

export interface ResidentResourceState {
  readonly id: string;
  readonly kind: StreamedResourceKind;
  readonly revision: number;
  readonly level: number;
  readonly byteLength: number;
  readonly lastUsedFrame: number;
}

export interface ResidencyCommitResult {
  readonly revision: number;
  readonly residentBytes: number;
  readonly appliedUploads: readonly string[];
  readonly failedUploads: readonly string[];
  readonly evicted: readonly string[];
}
