export { extractSdfCollisionMesh, sdfColliderPayloadToGrid, MAX_SDF_COLLISION_TRIANGLES,
  type SdfCollisionMesh } from "./sdfCollisionBridge.js";
export { buildSdfGrid, sampleSdfGrid, type SdfGrid, type SdfMesh } from "./sdfGrid.js";
export { querySdfGridGpu, SDF_QUERY_WGSL, type SdfQueryGpuInput } from "./sdfGpuQuery.js";
export { ClothSolver, type ClothSolverConfig, type ClothSnapshot, type ClothWind,
  type StretchStats } from "./clothSolver.js";
export { SoftBodySolver, type SoftBodySolverConfig, type SoftBodySnapshot,
  type VolumeStats } from "./softBodySolver.js";
export { createSoftBodyRuntimeSession, SoftBodyBudgetError, SOFT_BODY_BUDGETS,
  type SoftBodyRuntimeSession } from "./softBodyRuntimeHost.js";
export { dispatchClothGpuStep, dispatchSoftBodyGpuStep,
  type ClothGpuDispatchResult, type SoftBodyGpuDispatchResult } from "./softBodyGpuDispatch.js";
export { dispatchClothParallelGpuStep, dispatchClothStepAuto, clothParallelDispatchCount,
  ClothParallelDispatchError, snapshotClothKernelSwitchTelemetry, resetClothKernelSwitchTelemetry,
  type ClothParallelDispatchResult, type ClothKernelChoice, type ClothKernelUsed,
  type ClothKernelFallbackReason, type ClothKernelSwitchResult,
  type ClothKernelSwitchTelemetry } from "./softBodyGpuDispatch.clothParallel.js";
export { assertFinite, fingerprintFloat64, replayFromStep, runTicks,
  type FixedStepSim, type Vec3 } from "./physicsTypes.js";
