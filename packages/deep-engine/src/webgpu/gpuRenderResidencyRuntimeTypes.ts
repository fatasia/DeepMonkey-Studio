import type { ResidencyDiagnosticsHooks } from "../residencyDiagnostics.js";
import type {
  GpuResidencyExecutionResult,
  GpuResidencyExecutorOptions,
  ResidencyCommitResult,
  ResidencyRequest,
  ResidencyStreamFrameResult,
  StreamedResourceKind,
  StreamedResourceLevel,
  StreamedResourceProfile,
} from "../streaming/index.js";

export interface GpuRenderResidencyRequest extends ResidencyRequest {
  readonly kind: StreamedResourceKind;
}

export interface GpuRenderResidencyLevel extends StreamedResourceLevel {
  /** Physical payload identity for this LOD/mip variant; defaults to the profile id. */
  readonly sourceId?: string;
}

export interface GpuRenderResidencyProfile extends Omit<StreamedResourceProfile, "levels"> {
  readonly levels: readonly GpuRenderResidencyLevel[];
}

export interface GpuRenderResidencyIdentity {
  readonly id: string;
  readonly kind: StreamedResourceKind;
}

export interface GpuRenderResidencyCommitResult extends Omit<ResidencyCommitResult,
  "appliedUploads" | "failedUploads" | "evicted"> {
  readonly appliedUploads: readonly GpuRenderResidencyIdentity[];
  readonly failedUploads: readonly GpuRenderResidencyIdentity[];
  readonly evicted: readonly GpuRenderResidencyIdentity[];
}

export interface GpuRenderResidencyExecutionResult extends Omit<GpuResidencyExecutionResult,
  "commit" | "uploadFailures" | "cancellationFailures"> {
  readonly commit: GpuRenderResidencyCommitResult;
  readonly uploadFailures: readonly Readonly<{ resource: GpuRenderResidencyIdentity; reason: unknown }>[];
  readonly cancellationFailures: readonly Readonly<{
    resource: GpuRenderResidencyIdentity; reason: unknown;
  }>[];
}

export interface GpuRenderResidencyFrameResult extends Omit<ResidencyStreamFrameResult, "execution"> {
  readonly execution?: GpuRenderResidencyExecutionResult;
}

export interface GpuRenderResidencyRuntimeOptions extends GpuResidencyExecutorOptions {
  /** Optional static meshlet data, separately bounded to 32 MiB across pending and leased geometry. */
  readonly meshlets?: boolean;
  /** Omit to keep diagnostics at zero clock reads and zero sample allocations. */
  readonly diagnostics?: ResidencyDiagnosticsHooks;
  /** Stable device identity shared with other diagnostics producers when aggregation is desired. */
  readonly deviceEpoch?: string;
}
