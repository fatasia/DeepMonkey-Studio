export { extractSdfCollisionMesh, sdfColliderPayloadToGrid, MAX_SDF_COLLISION_TRIANGLES,
  type SdfCollisionMesh } from "./sdfCollisionBridge.js";
export { FixedStepClock, stepSimSeconds, type FixedStepClockConfig } from "./fixedStepDriver.js";
export { buildSdfGrid, sampleSdfGrid, type SdfGrid, type SdfMesh } from "./sdfGrid.js";
export { querySdfGridGpu, SDF_QUERY_WGSL, type SdfQueryGpuInput } from "./sdfGpuQuery.js";
export {
  createSdfCollisionProfile, sampleSdfCollision, createSdfQueryPointStream,
  fingerprintSdfQuerySamples, SDF_COLLISION_PROFILE_DEFAULT_ENABLED,
  SDF_COLLISION_MAX_QUERY_POINTS, SDF_QUERY_LCG_SEED, DEEP_SDF_COLLISION_QUERY_WGSL,
  SDF_QUERY_ENTRY, SDF_QUERY_WORKGROUP_SIZE, MAX_SDF_PROFILE_GRID_CELLS,
  estimateSdfCollisionMemory, packSdfQueryParams, querySdfCollisionsGpu,
  isSdfQueryNanBitPattern, collectSdfProfileComparison, validateSdfProfileAgainstRapierHull,
  deriveSdfProfileDistanceBound,
  type SdfCollisionProfile, type SdfCollisionProfileConfig, type SdfCollisionSample,
  type SdfCollisionProfileState, type SdfCollisionMemoryEstimate, type SdfCollisionGpuBatch,
  type SdfProfileTruthRow, type SdfProfileBudget, type SdfProfileRegion,
  type SdfProfileComparisonRow, type SdfProfileViolation, type SdfProfileComparisonTable,
} from "./sdfCollisionProfile.js";
export { ClothSolver, type ClothSolverConfig, type ClothSnapshot, type ClothWind,
  type StretchStats } from "./clothSolver.js";
export { createClothSelfCollision, createParticleSeparation, type ClothSelfCollisionConfig,
  type ClothSelfCollisionResolver, type ParticleSeparationConfig, type ParticleSeparationSet } from "./clothSelfCollision.js";
export { SoftBodySolver, type SoftBodySolverConfig, type SoftBodySnapshot,
  type VolumeStats } from "./softBodySolver.js";
export { colorSoftBodyVolumes, type SoftBodyVolumeColoring } from "./softBodyVolumeColoring.js";
export { createSoftBodySelfCollision, extractSoftBodySurfaceTopology,
  type SoftBodySelfCollisionConfig, type SoftBodySelfCollisionResolver,
  type SoftBodySurfaceTopology } from "./softBodySelfCollision.js";
export { createSoftBodyRuntimeSession, SoftBodyBudgetError, SOFT_BODY_BUDGETS,
  type SoftBodyRuntimeSession, type SoftBodyRuntimeOptions } from "./softBodyRuntimeHost.js";
export { dispatchClothGpuStep, dispatchSoftBodyGpuStep,
  type ClothGpuDispatchResult, type SoftBodyGpuDispatchResult } from "./softBodyGpuDispatch.js";
export { dispatchClothParallelGpuStep, dispatchClothStepAuto, clothParallelDispatchCount,
  ClothParallelDispatchError, snapshotClothKernelSwitchTelemetry, resetClothKernelSwitchTelemetry,
  noteClothParallelSessionStep,
  type ClothParallelDispatchResult, type ClothKernelChoice, type ClothKernelUsed,
  type ClothKernelFallbackReason, type ClothKernelSwitchResult,
  type ClothKernelSwitchTelemetry } from "./softBodyGpuDispatch.clothParallel.js";
export { dispatchSoftBodyParallelGpuStep, softBodyParallelDispatchCount,
  type SoftBodyParallelDispatchResult } from "./softBodyGpuDispatch.softbodyParallel.js";
export { SOFT_BODY_PARALLEL_SOLVER_WGSL, SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE,
  SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES,
  SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES, SOFT_BODY_PARALLEL_ENTRY_FINALIZE } from "./softBodyParallelSolverWgsl.js";
export { createClothGpuStepSession, type ClothGpuStepSession,
  type ClothGpuStepSessionOptions } from "./softBodyGpuDispatch.clothSession.js";
export { assertFinite, fingerprintFloat64, replayFromStep, runTicks,
  type FixedStepSim, type Vec3 } from "./physicsTypes.js";

export { projectSoftBodyRenderPacket, type SoftBodyRenderBinding } from "./softBodyRenderProjection.js";
