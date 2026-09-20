export {
  THREE_COMPAT_PROFILE_SCHEMA_VERSION,
  validateThreeCompatibilityProfile,
} from "./threeProfile.js";
export type {
  ThreeClassCompatibility,
  ThreeCompatibilityLevel,
  ThreeCompatibilityProfile,
  ThreeProfileEvidence,
  ThreeProfileEvidenceSource,
  ThreeProfileIssue,
  ThreeProfileValidationResult,
} from "./threeProfile.js";

export { DeepSceneState, DeepSceneStateError } from "./sceneState.js";
export type {
  SceneObjectId,
  SceneObjectSnapshot,
  SceneStateSnapshot,
  SceneStateStats,
} from "./sceneState.js";
export type { TransformPatch, TransformState, Vector3State } from "./sceneTransform.js";

export { BENCHMARK_SAMPLE_SCHEMA_VERSION, channelMedianMs, createSampleWindow,
  validateSampleWindow } from "./benchmarkSampleSchema.js";
export type { ChannelSample, SampleChannel, SampleClockId, SampleValidationIssue,
  SampleWindow } from "./benchmarkSampleSchema.js";
export { compareBenchmarkWindows } from "./benchmarkWindowComparison.js";
export type { BenchmarkWindowPair, BenchmarkChannelGap } from "./benchmarkWindowComparison.js";

export { BENCHMARK_TRAJECTORY_SCHEMA_VERSION, createBenchmarkTrajectory, sampleTrajectoryPose,
  trajectoryActionsInWindow, validateBenchmarkTrajectory } from "./benchmarkAssetTrajectory.js";
export type { BenchmarkTrajectory, TrajectoryAction, TrajectoryCameraKey, TrajectoryCameraPose,
  TrajectoryEasing, TrajectoryValidationIssue } from "./benchmarkAssetTrajectory.js";

export { BENCHMARK_ASSET_MANIFEST_SCHEMA_VERSION, createBenchmarkAssetManifest,
  validateBenchmarkAssetManifest } from "./benchmarkAssetManifest.js";
export type { BenchmarkAssetLicense, BenchmarkAssetManifest, BenchmarkAssetSource,
  BenchmarkAssetTaskFixture, BenchmarkLoadClass, ManifestValidationIssue } from "./benchmarkAssetManifest.js";

export { RenderGraphBuilder } from "./renderGraph.js";
export type {
  RenderGraphCompileResult,
  RenderGraphIssue,
  RenderPassDescriptor,
  RenderResourceDescriptor,
  RenderResourceLifetime,
} from "./renderGraph.js";

export { FrameScheduler, FrameSchedulerError } from "./frameScheduler.js";
export type {
  FrameRunResult,
  FrameStageDescriptor,
  FrameStageStatus,
  FrameStageTrace,
} from "./frameScheduler.js";

export { FrameLoop } from "./frameLoop.js";
export type {
  FrameLoopAdvanceResult,
  FrameLoopAdvanceStatus,
  FrameLoopDiagnostics,
  FrameLoopMode,
  FrameLoopStage,
  FrameLoopStageContext,
  FrameLoopStageTrace,
} from "./frameLoop.js";

export { PriorityEventQueue } from "./priorityEventQueue.js";
export type {
  EngineEvent,
  EngineEventEnqueueResult,
  EngineEventPriority,
  PriorityEventQueueDiagnostics,
  QueuedEngineEvent,
} from "./priorityEventQueue.js";

export { BackendSwitchCoordinator } from "./backendSwitch.js";
export type { BackendPreparation, BackendRevisionBarrier, BackendStateRevision,
  BackendSwitchResult, SwitchableBackend } from "./backendSwitch.js";
export { BackendPreferenceController } from "./backendPreference.js";
export { resolveRayTracingCapability } from "./rayTracingCapability.js";
export type { RayTracingBackend, RayTracingCapability } from "./rayTracingCapability.js";
export type { BackendPreferenceResult, BackendPreferenceSnapshot,
  BackendPreferenceStore } from "./backendPreference.js";
export { MAX_EMISSIVE_STRENGTH, prepareInstanceUpdate, prepareRenderPacket } from "./renderPacket.js";
export type {
  AlphaMode,
  GeometryFeatures,
  GeometryResource,
  InstanceUpdate,
  NormalTextureSlot,
  OcclusionTextureSlot,
  PbrMaterial,
  PreparedBatch,
  PreparedLodLevel,
  PreparedLodProfile,
  PreparedMaterialTextures,
  PreparedPacket,
  PreparedTextureSlot,
  RenderInstance,
  RenderLodLevel,
  RenderLodProfile,
  RenderPacket,
  TextureSlot,
} from "./renderPacket.js";
export type { DecodedTexture, PreparedTextureFormat, TextureCompression, TextureCompressionFeature, TextureSampler, TextureSemantic } from "./textures/decodedTexture.js";
export { inspectKtx2Container, selectKtx2TranscodeTarget, transcodeKtx2Texture } from "./textures/ktx2Transcode.js";
export type { EncodedKtx2Texture, Ktx2ContainerInfo, Ktx2SourceProfile, Ktx2TranscodeOptions, Ktx2TranscodePreference, Ktx2TranscodeRequest, Ktx2TranscodeResult, Ktx2TranscodeTarget, Ktx2Transcoder } from "./textures/ktx2Transcode.js";
export { createBasisKtx2Transcoder } from "./textures/basisKtx2Transcoder.js";
export type { BasisImageLevelInfo, BasisKtx2File, BasisKtx2Module, BasisKtx2TranscoderOptions } from "./textures/basisKtx2Transcoder.js";
export { decodeRadianceHdr } from "./textures/radianceHdr.js";
export type { RadianceHdrDecodeOptions, RadianceHdrImage } from "./textures/radianceHdr.js";
export { prepareHdrEnvironmentUpload } from "./textures/hdrEnvironmentUpload.js";
export type { HdrEnvironmentUpload, HdrEnvironmentUploadOptions } from "./textures/hdrEnvironmentUpload.js";
export { resolveRayTracingDecision, validateRayTracingCapabilities } from "./rayTracingCapabilities.js";
export type { RayTracingCapabilities, RayTracingDecision, RayTracingFallback, RayTracingFeature, RayTracingTier } from "./rayTracingCapabilities.js";

export { DEEP_2D_DISPLAY_LIST_BUDGETS, DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, validateDeep2dDisplayList } from "./deep2dDisplayList.js";
export type {
  Deep2dAtlasIdentity,
  Deep2dBakedGlyph,
  Deep2dColor,
  Deep2dCommand,
  Deep2dDisplayList,
  Deep2dDisplayListAtlas,
  Deep2dDisplayListIssue,
  Deep2dDisplayListIssueCode,
  Deep2dDisplayListValidationResult,
  Deep2dMatrix,
  Deep2dPathVerb,
  Deep2dResource,
} from "./deep2dDisplayList.js";

export * from "./chartIr.js";
export * from "./chartDataUpdate.js";
export * from "./chartDataApply.js";
export * from "./chartSimulation.js";
export { parseChartIR, validateChartIR } from "./chartIrReader.js";
export * from "./echartsOptionCompat.js";
export * from "./retainedUi.js";
export * from "./hostCapabilities.js";
export * from "./adapterN1/index.js";
export * from "./benchmarkContract.js";
export * from "./competitiveBenchmark.js";
export * from "./assetCompatibility.js";
export * from "./assetPackage.js";
export * from "./assetPackageValidation.js";
export * from "./assetPackageStoreTypes.js";
export * from "./assetPackageStoreExecutor.js";
export * from "./assetReimport.js";
export * from "./assetReimportCoordinatorTypes.js";
export * from "./assetReimportCoordinator.js";
export * from "./packagePurity.js";
export * from "./residencyDiagnostics.js";
export * from "./assetBakePlan.js";
export * from "./assetBakeResidency.js";
export * from "./geometry/index.js";
export * from "./spatial/index.js";
export * from "./scene/index.js";
export * from "./animation/index.js";
export * from "./morph/index.js";
export * from "./lighting/index.js";
export * from "./postprocess/index.js";
export * from "./streaming/index.js";
export * from "./shadows/index.js";
export * from "./runtimePackage/index.js";
export * from "./fog/index.js";
export * from "./r12/frameCapture.js";
