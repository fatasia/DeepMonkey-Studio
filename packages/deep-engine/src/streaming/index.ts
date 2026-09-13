export { ResourceResidencyController } from "./residencyController.js";
export { GpuResidencyExecutor } from "./gpuResidencyExecutor.js";
export { ResidencyStreamScheduler } from "./residencyStreamScheduler.js";
export type { ResidencyStreamFrameResult } from "./residencyStreamScheduler.js";
export { GpuResidentOwner } from "./gpuResidentLease.js";
export type { GpuResidentLease } from "./gpuResidentLease.js";
export {
  GpuResidencyExecutorError,
  type GpuResidencyExecutionResult,
  type GpuResidencyExecutorErrorCode,
  type GpuResidencyExecutorOptions,
  type GpuResidencyUploader,
  type GpuResidencyUploadFailure,
  type GpuResidencyUploadRequest,
  type GpuResidencyUploadResult,
  type GpuResidentResource,
} from "./gpuResidencyExecutorTypes.js";
export { DEEP_RESIDENCY_LIMITS } from "./validation.js";
export type {
  ResidentResourceState, ResidencyBudgets, ResidencyCommitResult, ResidencyEviction, ResidencyFramePlan,
  ResidencyRequest, ResidencySelection, ResidencySelectionReason, ResidencyUpload, StreamedResourceKind,
  StreamedResourceLevel, StreamedResourceProfile,
} from "./types.js";
