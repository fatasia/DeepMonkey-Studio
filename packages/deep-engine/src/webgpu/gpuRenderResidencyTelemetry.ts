import type { ResidentResourceState, ResidencyBudgets, StreamedResourceKind } from "../streaming/index.js";

export interface GpuRenderResidencyKindTelemetry {
  readonly residentBytes: number;
  readonly residentResourceCount: number;
}

export interface GpuRenderResidencyBudgetTelemetry {
  readonly maxResidentBytes: number;
  readonly maxUploadBytesPerFrame: number;
  readonly maxResources: number;
  readonly retainFrames: number;
  /** Confirmed drawable bytes divided by the logical resident-byte budget. */
  readonly residentByteUtilization: number;
  /** Confirmed plus leased retired bytes divided by the resident-byte budget. */
  readonly allocatedByteUtilization: number;
  readonly registeredResourceUtilization: number;
}

export interface GpuRenderResidencyAppliedFrameTelemetry {
  readonly frame: number;
  readonly generation: number;
  readonly residencyRevision: number;
  readonly requestedResourceCount: number;
  readonly uploadedResourceCount: number;
  readonly uploadedBytes: number;
  readonly evictedResourceCount: number;
  readonly failedUploadCount: number;
  readonly qualityReducedResourceCount: number;
  readonly uploadBudgetUtilization: number;
}

export interface GpuRenderResidencyTelemetrySnapshot {
  readonly disposed: boolean;
  readonly residencyRevision: number;
  readonly registeredResourceCount: number;
  readonly residentResourceCount: number;
  readonly residentBytes: number;
  readonly retiredBytes: number;
  /** Resident plus retired bytes still backed by a live GPU allocation. */
  readonly allocatedBytes: number;
  readonly geometry: GpuRenderResidencyKindTelemetry;
  readonly texture: GpuRenderResidencyKindTelemetry;
  readonly resources: readonly ResidentResourceState[];
  readonly budgets: GpuRenderResidencyBudgetTelemetry;
  readonly lastAppliedFrame?: GpuRenderResidencyAppliedFrameTelemetry;
}

export interface GpuRenderResidencyTelemetryInput {
  readonly disposed: boolean;
  readonly residencyRevision: number;
  readonly registeredResourceCount: number;
  readonly retiredBytes: number;
  readonly resources: readonly ResidentResourceState[];
  readonly budgets: Readonly<Required<ResidencyBudgets>>;
  readonly lastAppliedFrame?: GpuRenderResidencyAppliedFrameTelemetry;
}

export interface GpuRenderResidencyAppliedFrameInput extends Omit<
GpuRenderResidencyAppliedFrameTelemetry, "uploadBudgetUtilization"> {
  readonly maxUploadBytesPerFrame: number;
}

export function createGpuRenderResidencyAppliedFrameTelemetry(
  input: GpuRenderResidencyAppliedFrameInput,
): GpuRenderResidencyAppliedFrameTelemetry {
  return Object.freeze({
    frame: input.frame,
    generation: input.generation,
    residencyRevision: input.residencyRevision,
    requestedResourceCount: input.requestedResourceCount,
    uploadedResourceCount: input.uploadedResourceCount,
    uploadedBytes: input.uploadedBytes,
    evictedResourceCount: input.evictedResourceCount,
    failedUploadCount: input.failedUploadCount,
    qualityReducedResourceCount: input.qualityReducedResourceCount,
    uploadBudgetUtilization: ratio(input.uploadedBytes, input.maxUploadBytesPerFrame),
  });
}

export function createGpuRenderResidencyTelemetrySnapshot(
  input: GpuRenderResidencyTelemetryInput,
): GpuRenderResidencyTelemetrySnapshot {
  const resources = Object.freeze(input.resources.map(resource => Object.freeze({ ...resource })));
  const geometry = summarizeKind(resources, "geometry"), texture = summarizeKind(resources, "texture");
  const residentBytes = geometry.residentBytes + texture.residentBytes;
  const allocatedBytes = residentBytes + input.retiredBytes;
  const budgets = Object.freeze({
    ...input.budgets,
    residentByteUtilization: ratio(residentBytes, input.budgets.maxResidentBytes),
    allocatedByteUtilization: ratio(allocatedBytes, input.budgets.maxResidentBytes),
    registeredResourceUtilization: ratio(input.registeredResourceCount, input.budgets.maxResources),
  });
  return Object.freeze({
    disposed: input.disposed,
    residencyRevision: input.residencyRevision,
    registeredResourceCount: input.registeredResourceCount,
    residentResourceCount: resources.length,
    residentBytes,
    retiredBytes: input.retiredBytes,
    allocatedBytes,
    geometry,
    texture,
    resources,
    budgets,
    ...(input.lastAppliedFrame ? { lastAppliedFrame: input.lastAppliedFrame } : {}),
  });
}

function summarizeKind(resources: readonly ResidentResourceState[],
  kind: StreamedResourceKind): GpuRenderResidencyKindTelemetry {
  let residentBytes = 0, residentResourceCount = 0;
  for (const resource of resources) {
    if (resource.kind !== kind) continue;
    residentBytes += resource.byteLength; residentResourceCount += 1;
  }
  return Object.freeze({ residentBytes, residentResourceCount });
}

function ratio(value: number, maximum: number): number {
  return value === 0 ? 0 : value / maximum;
}
