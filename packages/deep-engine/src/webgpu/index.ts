/// <reference types="@webgpu/types" />
export { DeviceSession } from "./deviceSession.js";
export { DeviceResourceBudgetError } from "./deviceResourceMemory.js";
export type { DeviceState, DeviceEvent } from "./deviceSession.js";
export { SharedShadowAtlasResources } from "./sharedShadowAtlasResources.js";
export type { SharedShadowAtlasBudgetEvidence, SharedShadowAtlasGpuResource,
  SharedShadowAtlasResourceUpdate } from "./sharedShadowAtlasResources.js";
export { ENGINE_TIMING_STAGES, EnginePerformanceTelemetry } from "./performanceTelemetry.js";
export type { EngineFrameTimingSample, EnginePerformanceTelemetrySnapshot,
  EngineTimingQuantiles, EngineTimingStage } from "./performanceTelemetry.js";
export { PbrRenderer } from "./pbrRenderer.js";
export { createHdrEnvironment } from "./hdrEnvironment.js";
export type { HdrEnvironment, HdrEnvironmentOptions } from "./hdrEnvironment.js";
export { createPbrEnvironment } from "./pbrEnvironmentSource.js";
export type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
export { PbrEnvironmentState } from "./pbrEnvironmentState.js";
export type { EnvironmentFactory, EnvironmentStageResult } from "./pbrEnvironmentState.js";
export type { RenderView, FrameMetrics, PbrRendererOptions } from "./pbrRenderer.js";
export { resolvePbrEnvironmentIntensity } from "./pbrEnvironmentIntensity.js";
export { DEFAULT_PBR_RENDERER_FEATURES, resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
export type { PbrRendererFeatureOptions, PbrRendererFeatures, PbrToneMapping } from "./pbrRendererFeatures.js";
export { applyPbrColorGradingLinear, NEUTRAL_PBR_COLOR_GRADING,
  resolvePbrColorGrading, STUDIO_PBR_COLOR_GRADING } from "./pbrColorGrading.js";
export type { PbrColorGrading, PbrColorGradingOptions } from "./pbrColorGrading.js";
export { applyPbrAuthorColorEffects, packPbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
export type { PbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";
export type { PbrPostProcessOverrides, PbrAuthorBloomOptions } from "./pbrPostProcessOverrides.js";
export type { Vec3 } from "./cameraMath.js";
export { CameraFrameHistory, jitterViewProjection } from "./cameraFrameHistory.js";
export type { CameraFrameHistoryResult, CameraFrameState } from "./cameraFrameHistory.js";
export { compilePbrFrameGraph, buildPbrFrameGraph } from "./pbrFrameGraph.js";
export type { PbrFrameGraphOptions } from "./pbrFrameGraph.js";
export { buildPbrFrameExecutionPlan, diffPlanAgainstActual, assertPlanMatchesActual,
  collectActualPbrFramePasses, createPbrFrameReceipt, createPbrPassTimingSample,
  createPbrPassUnavailableSample, pbrReceiptSampleWindow, pbrPassChannelName } from "./pbrFramePlanExecutor.js";
export type { PbrFrameExecutionPlan, PbrPlannedPass, PbrPlannedPassResource, PbrPlannedResourceLifetime,
  PbrPassMapping, PbrPlanMismatch, PbrPlanDiffResult, PbrFrameExecutionReceipt, PbrPassChannelSample,
  PbrPassTimingEntry } from "./pbrFramePlanExecutor.js";
export { PBR_FRAME_RESOURCE_CONTRACTS, resolvePbrFrameResourceSizes, resolvePbrFramePlanSurface,
  pbrFrameResourceContract, FRAME_PLAN_USAGES } from "./pbrFramePlanResources.js";
export type { PbrFrameResourceContract, PbrFrameResourceSizeRole, FramePlanUsage,
  PbrPassResourceClaim, PbrUnplannedAttachment, PbrActualPassDescription } from "./pbrFramePlanResources.js";
export { PbrTransientTexturePool, PBR_HISTORY_TRANSIENT_EXCLUDED, isPbrTransientPoolEligible,
  framePlanUsageFlags, transientTextureBytes, pbrTransientTextureKeyValue } from "./pbrTransientTexturePool.js";
export type { PbrTransientTextureKey, PbrTransientRequest, PbrTransientTextureHandle,
  PbrTransientPoolInvalidationReason, PbrTransientTexturePoolStats } from "./pbrTransientTexturePool.js";
export { MAX_EMISSIVE_STRENGTH } from "../renderPacket.js";
export type { RenderPacket, GeometryResource, PbrMaterial, RenderInstance, RenderLodLevel, RenderLodProfile,
  PreparedBatch, PreparedLodLevel, PreparedLodProfile, PreparedPacket,
  InstanceUpdate, TextureSlot, NormalTextureSlot, OcclusionTextureSlot, AlphaMode } from "../renderPacket.js";
export type { DecodedTexture, PreparedTextureFormat, TextureCompression, TextureCompressionFeature, TextureSampler, TextureSemantic } from "../textures/decodedTexture.js";
export { TextureResources } from "./textureResources.js";
export { GpuBufferResidencyUploader } from "./gpuBufferResidencyUploader.js";
export type { GpuBufferResidencySource, GpuBufferResidencySourceProvider } from "./gpuBufferResidencyUploader.js";
export { GpuResidencyRuntime } from "./gpuResidencyRuntime.js";
export type { GpuResidencyRuntimeOptions } from "./gpuResidencyRuntime.js";
export { GpuGeometryResidencyUploader } from "./gpuGeometryResidencyUploader.js";
export type { GpuGeometryResidencyHandle, GpuGeometryResidencySourceProvider } from "./gpuGeometryResidencyUploader.js";
export { GpuTextureResidencyUploader } from "./gpuTextureResidencyUploader.js";
export type { GpuTextureResidencyHandle, GpuTextureResidencySource, GpuTextureResidencySourceProvider,
  GpuTextureResidencyTexture } from "./gpuTextureResidencyUploader.js";
export { GpuRenderResidencyUploader } from "./gpuRenderResidencyUploader.js";
export type { GpuRenderResidencyHandle, GpuRenderResidencySource, GpuRenderResidencySourceId,
  GpuRenderResidencySourceProvider } from "./gpuRenderResidencyUploader.js";
export { GpuRenderResidencyRuntime } from "./gpuRenderResidencyRuntime.js";
export type { GpuRenderResidencyCommitResult, GpuRenderResidencyExecutionResult,
  GpuRenderResidencyFrameResult, GpuRenderResidencyIdentity, GpuRenderResidencyLevel,
  GpuRenderResidencyProfile, GpuRenderResidencyRequest,
  GpuRenderResidencyRuntimeOptions } from "./gpuRenderResidencyRuntime.js";
export type { GpuRenderResidencyAppliedFrameTelemetry, GpuRenderResidencyBudgetTelemetry,
  GpuRenderResidencyKindTelemetry, GpuRenderResidencyTelemetrySnapshot,
} from "./gpuRenderResidencyTelemetry.js";
export { createResidentPacketProjection } from "./residentPacketProjection.js";
export type { ResidentPacketBatch, ResidentPacketLeaseProvider, ResidentPacketProjection,
  ResidentPacketProjectionOptions, ResidentPacketTextureBinding,
  ResidentPacketTextureRole } from "./residentPacketProjection.js";
export { createPacketResidencyCatalog } from "./packetResidencyCatalog.js";
export type { PacketResidencyCatalog, PacketResidencyRegistrar } from "./packetResidencyCatalog.js";
export { createPacketResidencyLoader, PacketResidencyLoadError } from "./packetResidencyLoader.js";
export type { PacketResidencyLoader, PacketResidencyLoadErrorCode,
  PacketResidencyLoadOptions } from "./packetResidencyLoader.js";
export { createPacketResidencyDomain } from "./packetResidencyDomain.js";
export type { PacketResidencyDomain, PacketResidencyTicket } from "./packetResidencyDomain.js";
export { createRuntimePackageWebGpuPrewarmAdapter } from "./runtimePackagePrewarmAdapter.js";
export type { RuntimePackageWebGpuPrewarmOptions, RuntimePackageWebGpuRenderPublication } from "./runtimePackagePrewarmAdapter.js";
export type { PacketResidencySetEntry, PacketResidencySetLoadOptions,
  PacketResidencySetProjection } from "./packetResidencySet.js";
export { createPacketResidencyRequestPlanner,
  planPacketResidencyRequests } from "./packetResidencyRequestPlanner.js";
export type { PacketResidencyDemand,
  PacketResidencyRequestPlanOptions,
  PacketResidencyRequestPlanner } from "./packetResidencyRequestPlanner.js";
export { createPacketResidencyWorkingSet,
  PacketResidencyWorkingSetError } from "./packetResidencyWorkingSet.js";
export type { PacketResidencyWorkingSet, PacketResidencyWorkingSetErrorCode,
  PacketResidencyWorkingSetLoad,
  PacketResidencyWorkingSetOptions } from "./packetResidencyWorkingSet.js";
export { createPbrResidencyStream } from "./pbrResidencyStream.js";
export type { PbrResidencyFrameTarget, PbrResidencyStageResult,
  PbrResidencyStream, PbrResidencyStreamOptions } from "./pbrResidencyStream.js";
export { createSceneChunkResidency, SceneChunkResidencyError } from "./sceneChunkResidency.js";
export { stageSceneChunkFrame } from "./sceneChunkFrameStage.js";
export type { ResidentSceneChunk, ResidentSceneChunkFrame, SceneChunkResidency,
  SceneChunkResidencyDemand, SceneChunkResidencyErrorCode, SceneChunkResidencyFrameInput,
  SceneChunkResidencyMode, SceneChunkResidencyOptions } from "./sceneChunkResidency.js";
export { ResidentPacketPublisher } from "./residentPacketPublisher.js";
export type { ResidentPacketCandidate } from "./residentPacketPublisher.js";
export { createPacketGeometryBounds } from "./packetGeometryBounds.js";
export type { PacketGeometryBounds, PacketGeometryBoundsSource } from "./packetGeometryBounds.js";
export { createResidentPacketTextureLookup } from "./packetTextureLookup.js";
export type { PacketTextureLookup } from "./packetTextureLookup.js";
export { stageResidentPacketBuffers, commitResidentPacketBufferStage,
  discardResidentPacketBufferStage } from "./residentPacketBufferStaging.js";
export type { ResidentPacketBufferPublication, ResidentPacketBufferStagingContext,
  StagedResidentPacketBuffers } from "./residentPacketBufferStaging.js";
export type { StagedTextureSet, TextureBinding } from "./textureResources.js";
export { sphereMesh } from "./primitives.js";
export { sceneShader } from "./pbrShader.js";
export { GPU_CULL_INSTANCE_STRIDE, GPU_CULL_PREVIOUS_TRANSFORM_STRIDE, GPU_CULL_INDIRECT_STRIDE,
  GPU_FRUSTUM_CULL_WGSL, packCullingInstances, cpuFrustumCull, createGpuCullingPipelineContext,
  createGpuCullingSharedInputs, createGpuFrustumCulling } from "./gpuFrustumCulling.js";
export type { CullingInstance, Frustum, GpuCullingPhaseResources, GpuCullingPipelineContext, GpuCullingResources, GpuCullingSharedInputs } from "./gpuFrustumCulling.js";
export { HiZPyramid, HI_Z_COPY_WGSL, HI_Z_OUTPUT_FORMAT, HI_Z_REDUCE_WGSL, HI_Z_WORKGROUP_SIZE, hiZMipLevelCount } from "./hiZPyramid.js";
export type { HiZLevel, HiZOptions, HiZReduction, HiZResolvedReduction, HiZResult, HiZSource } from "./hiZPyramid.js";
export { HiZOcclusionCuller, HI_Z_OCCLUSION_MAX_INSTANCES, HI_Z_OCCLUSION_MIN_INSTANCES, HI_Z_OCCLUSION_WGSL,
  HI_Z_OCCLUSION_WORKGROUP_SIZE, hiZOcclusionMip, hiZOcclusionVisible, projectHiZOcclusionAabb } from "./hiZOcclusionCulling.js";
export type { HiZOcclusionDirectResult, HiZOcclusionIndirectResult, HiZOcclusionInput, HiZOcclusionOptions,
  HiZOcclusionProjection, HiZOcclusionResult, HiZOcclusionView } from "./hiZOcclusionCulling.js";
export { HiZInstanceCompactor, HI_Z_INSTANCE_COMPACTION_WGSL,
  HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE } from "./hiZInstanceCompactor.js";
export type { HiZInstanceCompactionInput, HiZInstanceCompactionResult } from "./hiZInstanceCompactor.js";
export { PreviousHiZVisibility } from "./previousHiZVisibility.js";
export type { PreviousHiZFallbackReason, PreviousHiZFrameInput,
  PreviousHiZFramePlan } from "./previousHiZVisibility.js";
export { MeshletCuller, MESHLET_CULL_WGSL, MESHLET_CULL_WORKGROUP_SIZE, meshletNormalConeVisible,
  meshletHiZClipTestable, meshletHiZVisible, nextMeshletCapacity } from "./meshletCulling.js";
export { meshletGpuInputByteLengths, meshletPlannerRecord, MESHLET_CULL_MAX_COUNT, MESHLET_CULL_MIN_COUNT,
  MESHLET_CULL_UNIFORM_SIZE, MESHLET_PLANNER_RECORD_STRIDE } from "./meshletCullingTypes.js";
export type { MeshletCullingDirectResult, MeshletCullingGpuResult, MeshletCullingInput,
  MeshletCullingOptions, MeshletCullingResult, MeshletCullingView } from "./meshletCullingTypes.js";
export { GpuSkinner, cpuSkinVertices, packJointPalette, prepareSkinningInput, GPU_SKINNING_INPUT_STRIDE,
  GPU_SKINNING_JOINT_STRIDE, GPU_SKINNING_OUTPUT_STRIDE, GPU_SKINNING_WGSL, GPU_SKINNING_WORKGROUP_SIZE } from "./gpuSkinning.js";
export type { GpuSkinningResult, PreparedSkinningInput, SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";
export { GpuMorphDeformer, assertMorphWeightRange, cpuDeformMorphVertices, packMorphWeights,
  prepareMorphInput, GPU_MORPH_DELTA_STRIDE, GPU_MORPH_FLAG_NORMAL, GPU_MORPH_FLAG_TANGENT,
  GPU_MORPH_VERTEX_STRIDE, GPU_MORPH_WGSL, GPU_MORPH_WORKGROUP_SIZE } from "./gpuMorphDeformation.js";
export type { GpuMorphResult, GpuMorphSource, GpuMorphWeights, PreparedMorphInput } from "./gpuMorphDeformation.js";
export {
  GpuMorphSkinner,
  cpuDeformMorphSkinVertices,
  prepareMorphSkinningInput,
  GPU_MORPH_SKINNING_INFLUENCE_STRIDE,
  GPU_MORPH_SKINNING_OUTPUT_STRIDE,
  GPU_MORPH_SKINNING_WGSL,
  GPU_MORPH_SKINNING_WORKGROUP_SIZE,
} from "./gpuMorphSkinning.js";
export type {
  GpuMorphSkinningResult,
  MorphSkinningDynamics,
  MorphSkinningSources,
  PreparedMorphSkinningInput,
} from "./gpuMorphSkinning.js";
export { WeightedOitPass, weightedOitColorTargets, WEIGHTED_OIT_COMPOSITE_WGSL,
  WEIGHTED_OIT_FRAGMENT_WGSL } from "./weightedOit.js";
export { WEIGHTED_OIT_ACCUMULATION_FORMAT, WEIGHTED_OIT_REVEALAGE_FORMAT } from "./weightedOitTypes.js";
export type { WeightedOitCompositeOptions, WeightedOitCompositeResult, WeightedOitSize,
  WeightedOitTargets } from "./weightedOitTypes.js";
export { MeshletIndexBuffer } from "./meshletIndexBuffer.js";
export { MeshletIndirectExecutor, MESHLET_INDIRECT_WGSL } from "./meshletIndirectExecutor.js";
export { MESHLET_INDIRECT_WORKGROUP_SIZE } from "./meshletIndirectWgsl.js";
export { MESHLET_DRAW_INDEXED_INDIRECT_STRIDE, MESHLET_INDIRECT_MAX_DRAWS,
  MESHLET_INDIRECT_PARAMETER_SIZE } from "./meshletIndirectTypes.js";
export type { MeshletBundleBindGroup, MeshletBundleExecution, MeshletBundleVertexBuffer,
  MeshletIndirectOptions, MeshletIndirectPlan, MeshletInstanceMapping,
  MeshletRenderBundleRequest } from "./meshletIndirectTypes.js";
export { GpuLodSelector } from "./gpuLodSelector.js";
export { packGpuLodScene } from "./gpuLodPacking.js";
export { decodeGpuLodRecords, selectGpuLodReference } from "./gpuLodReference.js";
export { cameraSignatureJumped, nextGpuLodCapacity, validateGpuLodCamera } from "./gpuLodValidation.js";
export { GPU_LOD_WGSL } from "./gpuLodWgsl.js";
export {
  GPU_LOD_FLAG_DRAWABLE, GPU_LOD_FLAG_HISTORY_RESET, GPU_LOD_FLAG_INVALID, GPU_LOD_FLAG_VISIBLE,
  GPU_LOD_LEVEL_STRIDE, GPU_LOD_MAX_LEVELS, GPU_LOD_MAX_OBJECTS, GPU_LOD_OBJECT_STRIDE,
  GPU_LOD_OUTPUT_STRIDE, GPU_LOD_UNAVAILABLE, GPU_LOD_UNIFORM_SIZE, GPU_LOD_WORKGROUP_SIZE,
} from "./gpuLodTypes.js";
export type { GpuLodInput, GpuLodLevelSource, GpuLodObjectSource, GpuLodReferenceRecord,
  GpuLodReferenceResult, GpuLodResult, GpuLodSelectorOptions, GpuLodView, PackedGpuLodScene } from "./gpuLodTypes.js";
export { ShaderPackageExecutor, ShaderPackageExecutorError } from "./shaderPackageExecutor.js";
export type {
  PreparedShaderPackage, PreparedShaderPackagePass, ShaderPackageExecutorState,
} from "./shaderPackageExecutor.js";
export { ShaderHotReloadRuntime } from "./hotReload.js";
export type {
  PublishedShaderPackage, ShaderHotReloadDiagnostic, ShaderHotReloadDiagnosticStage,
  ShaderHotReloadFrameBoundaryHook, ShaderHotReloadOptions, ShaderHotReloadPublishResult,
  ShaderHotReloadRequestResult, ShaderHotReloadRequestStatus, ShaderHotReloadState,
} from "./hotReloadTypes.js";
export * from "./webgpuProbeCaptureAdapter.js";
export * from "./webgpuProbeCaptureTypes.js";
export * from "./webgpuProbeCaptureWgsl.js";
export * from "./probeClipmapRuntime.js";
export * from "./probeClipmapPbrController.js";
export * from "./gpuParticleRuntime.js";
export * from "./gpuParticleTypes.js";
export * from "./gpuParticleWgsl.js";
export * from "./gpuParticleEmitters.js";
export * from "./gpuParticleBurstTypes.js";
export * from "./gpuParticleBurstWgsl.js";
export * from "./shaderAuthoringCompiler.js";
export { validatePanoramaBackground } from "./pbrPanoramaBackground.js";
export { validatePbrFog, snapshotPbrFog, packPbrFog, pbrFogFactor } from "./pbrFog.js";
export type { PbrFog, PbrFogColor } from "./pbrFog.js";
export { snapshotEditorOverlay, EDITOR_OVERLAY_MAX_VERTICES, type EditorOverlaySnapshot } from "./editorOverlayTypes.js";
export type { AuthorGridView } from "./authorGridTypes.js";
export { createBrowserImageDecoder, type DecodedImageHandle, type ImageDecoderHost } from "./browserImageDecoder.js";
