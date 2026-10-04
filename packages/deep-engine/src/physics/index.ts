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
export { PhysicsDebugRecorder, fingerprintFloat32, comparePhysicsDebugRecordingTicks,
  estimatePhysicsDebugRecorderBytes, parsePhysicsDebugRecordingJson,
  PHYSICS_DEBUG_RECORDING_SCHEMA, PHYSICS_DEBUG_RECORDING_SCHEMA_VERSION,
  PHYSICS_DEBUG_POSE_STRIDE, PHYSICS_DEBUG_CONTACT_STRIDE, PHYSICS_DEBUG_JOINT_STRIDE,
  PHYSICS_DEBUG_DEFAULT_BYTE_BUDGET, PHYSICS_DEBUG_DEFAULT_MAX_BODIES,
  PHYSICS_DEBUG_DEFAULT_MAX_CONTACTS_PER_TICK, PHYSICS_DEBUG_DEFAULT_MAX_JOINTS_PER_TICK,
  PHYSICS_DEBUG_MAX_MARKS, PHYSICS_DEBUG_SEMANTIC_COLORS,
  PHYSICS_DEBUG_DEFAULT_COMPARE_TOLERANCE,
  type PhysicsDebugRecorderConfig, type PhysicsDebugRecorderEstimate,
  type PhysicsDebugRecorderTickInput, type PhysicsDebugRecordOutcome,
  type PhysicsDebugMark, type PhysicsDebugTickSnapshot,
  type PhysicsDebugCompareTolerance, type PhysicsDebugCompareTickRow,
  type PhysicsDebugCompareResult, type ParsedPhysicsDebugRecording } from "./debugRecorder.js";

export { projectSoftBodyRenderPacket, type SoftBodyRenderBinding } from "./softBodyRenderProjection.js";

export { buildPreFracture, planTotalMass, type PreFracturePlan, type FracturePiece,
  type FractureConnection } from "./fractureReference.js";
export { FractureSolver, energyLedgerResidual, locateImpactPiece,
  type FracturePropagationConfig, type ImpactInput, type FractureBreakEvent,
  type FragmentActivationEvent, type FractureSolverSnapshot } from "./fractureDynamics.js";
export { pacejkaTireForce, tireLongitudinalStiffness, tirePeakSlip, tireStiffnessB,
  engineTorqueAt, wheelSpeedToEngineRpm, gearboxStep, gearboxDriveForce,
  type TireModelConfig, type TireForce, type EngineConfig, type GearboxConfig,
  type GearboxState } from "./vehicleTire.js";
export { VehicleDynamicsSim, computeStaticPose, createDefaultVehicleConfig,
  type VehicleConfig, type DriverInput, type VehicleSnapshot } from "./vehicleDynamics.js";
