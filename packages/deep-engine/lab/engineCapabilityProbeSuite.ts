import { runGpuAffineBoundsProbe } from "./gpuAffineBoundsProbe.js";
import type { PbrRenderer } from "@bim-studio/deep-engine/webgpu";
import { verifyAmbientOcclusion } from "./ambientOcclusionProbe.js";
import { verifyAnimationRuntime } from "./animationRuntimeProbe.js";
import { runCascadedShadowProbe } from "./cascadedShadowProbe.js";
import { verifyCompressedTextureUpload } from "./compressedTextureProbe.js";
import { verifyDeepSlBaseColorTexture } from "./deepSlBaseColorTextureProbe.js";
import { verifyDeepSlMaterialModes } from "./deepSlMaterialModesProbe.js";
import { verifyDeepSlPbrPackage } from "./deepSlPbrProbe.js";
import { verifyDeepSlCsmPackage } from "./deepSlCsmProbe.js";
import { verifyDeepSlPbrTextureSlots } from "./deepSlPbrTextureSlotsProbe.js";
import { verifyDeepSlUnlit } from "./deepSlUnlitProbe.js";
import { verifyForwardPlusClusteredLighting } from "./forwardPlusClusteredLightingProbe.js";
import { verifyForwardPlusPbrLighting } from "./forwardPlusPbrLightingProbe.js";
import { verifyGpuFrustumCulling } from "./gpuFrustumCullingProbe.js";
import { verifyGpuResidencyTransactions } from "./gpuResidencyProbe.js";
import { verifyTransientBudget } from "./transientBudgetProbe.js";
import { verifyDeviceBudget } from "./deviceBudgetProbe.js";
import { verifyGpuMixedResidency } from "./gpuMixedResidencyProbe.js";
import { verifyGpuTextureMipResidency } from "./gpuTextureMipResidencyProbe.js";
import { runGpuLodSelectionProbe } from "./gpuLodSelectionProbe.js";
import { runGpuMorphDeformationProbe } from "./gpuMorphDeformationProbe.js";
import { runGpuMorphSkinningProbe } from "./gpuMorphSkinningProbe.js";
import { runGpuSkinningProbe } from "./gpuSkinningProbe.js";
import { runHiZOcclusionProbe } from "./hiZOcclusionProbe.js";
import { runHiZPyramidProbe } from "./hiZPyramidProbe.js";
import { runMeshletCullingProbe } from "./meshletCullingProbe.js";
import { runMeshletIndirectProbe } from "./meshletIndirectProbe.js";
import { runPacketShadowLodProbe } from "./packetShadowLodProbe.js";
import { runPacketLodParallelProbe } from "./packetLodParallelProbe.js";
import { verifyShaderPackageExecutor } from "./shaderPackageProbe.js";
import { verifyShaderHotReloadRuntime } from "./shaderHotReloadProbe.js";
import { verifyTemporalAa } from "./temporalAaProbe.js";
import { runWeightedOitProbe } from "./weightedOitProbe.js";
import { createProbeRunner } from "./probeExecution.js";
import { verifyBloomEnergy } from "./bloomEnergyProbe.js";
import { verifyGroundAlbedo } from "./groundAlbedoProbe.js";
import { verifyPbrResidentPacketFrameBoundary } from "./pbrResidentPacketFrameProbe.js";
import { verifyPbrPartialLodResidency } from "./pbrPartialLodResidencyProbe.js";
import { verifyPbrResidencyStream } from "./pbrResidencyStreamProbe.js";
import { verifySceneChunkResidency } from "./sceneChunkResidencyProbe.js";
import { verifyHdrEnvironment } from "./hdrEnvironmentProbe.js";
import { verifyRealAssetPixelSemantics } from "./realAssetPixelProbe.js";
import { runLocalSpotShadowProbe } from "./localSpotShadowProbe.js";
import { runProbeClipmapCaptureProbe } from "./probeClipmapCaptureProbe.js";
import { runProbeClipmapPbrProbe } from "./probeClipmapPbrProbe.js";
import { runGpuParticleProbe } from "./gpuParticleProbe.js";
import { runCombinedLoadWebGpuProbe } from "./combinedLoadWebGpuProbe.js";
import { verifyGltfAnimationTransitions } from "./gltfAnimationTransitionProbe.js";

export interface EngineCapabilityProbeSuiteResult {
  readonly records: readonly unknown[];
  readonly passed: boolean;
}

export async function runEngineCapabilityProbeSuite(
  renderer: PbrRenderer, canvas: HTMLCanvasElement,
  signal?: AbortSignal, progress?: (name: string) => void,
): Promise<EngineCapabilityProbeSuiteResult> {
  const session = renderer.session;
  const probe = createProbeRunner(signal, progress);
  const packageProbe = await probe("Shader 包", () => verifyShaderPackageExecutor(session.device));
  const shaderHotReloadProbe = await probe("Shader 热重载", verifyShaderHotReloadRuntime);
  const deepSlPbrProbe = await probe("DeepSL PBR", () => verifyDeepSlPbrPackage(session.device));
  const deepSlCsmProbe = await probe("DeepSL 级联阴影包", () => verifyDeepSlCsmPackage(session.device));
  const materialModesProbe = await probe("材质模式", () => verifyDeepSlMaterialModes(session.device));
  const baseColorTextureProbe = await probe("基础色纹理", () => verifyDeepSlBaseColorTexture(session.device));
  const pbrTextureSlotsProbe = await probe("PBR 纹理槽", () => verifyDeepSlPbrTextureSlots(session.device));
  const unlitProbe = await probe("DeepSL Unlit", () => verifyDeepSlUnlit(session.device));
  const cullingProbe = await probe("视锥剔除", () => verifyGpuFrustumCulling(session.device));
  const affineBoundsProbe = await probe("仿射包围球", () => runGpuAffineBoundsProbe(session));
  const compressedTextureProbe = await probe("压缩纹理", () => verifyCompressedTextureUpload(session));
  const hiZProbe = await probe("Hi-Z 深度", () => runHiZPyramidProbe(session));
  const hiZOcclusionProbe = await probe("Hi-Z 遮挡", () => runHiZOcclusionProbe(session));
  const meshletCullingProbe = await probe("Meshlet 剔除", () => runMeshletCullingProbe(session));
  const meshletIndirectProbe = await probe("Meshlet 绘制", () => runMeshletIndirectProbe(session));
  const cascadedShadowProbe = await probe("级联阴影", () => runCascadedShadowProbe(session));
  const localSpotShadowProbe = await probe("局部聚光阴影", () => runLocalSpotShadowProbe(session));
  const probeClipmapCaptureProbe = await probe("GI Probe Clipmap", () => runProbeClipmapCaptureProbe(session));
  const probeClipmapPbrProbe = await probe("GI Probe PBR 接线", () => runProbeClipmapPbrProbe(renderer, canvas, signal));
  const gpuParticleProbe = await probe("GPU 粒子", () => runGpuParticleProbe(session));
  const forwardPlusProbe = await probe("光照分簇", () => verifyForwardPlusClusteredLighting(session));
  const forwardPlusPbrProbe = await probe("分簇 PBR", () => verifyForwardPlusPbrLighting(session));
  const animationProbe = await probe("动画", verifyAnimationRuntime);
  const animationTransitionProbe = new URLSearchParams(location.search).get("animationTransitions") === "1"
    ? await probe("动画嵌套过渡", verifyGltfAnimationTransitions)
    : Object.freeze({ action: "gltf-animation-transition", success: true, skipped: true,
      reason: "Run the dedicated browser gate with ?animationTransitions=1." });
  const gpuSkinningProbe = await probe("GPU 蒙皮", () => runGpuSkinningProbe(session));
  const gpuMorphProbe = await probe("GPU Morph", () => runGpuMorphDeformationProbe(session));
  const gpuMorphSkinningProbe = await probe("Morph 与蒙皮", () => runGpuMorphSkinningProbe(session));
  const gpuLodSelectionProbe = await probe("GPU LOD 选择", () => runGpuLodSelectionProbe(session));
  const packetLodParallelProbe = await probe("LOD 并行绘制", () => runPacketLodParallelProbe(session));
  const packetShadowLodProbe = await probe("阴影 LOD", () => runPacketShadowLodProbe(session));
  const weightedOitProbe = await probe("透明合成", () => runWeightedOitProbe(session));
  const ambientOcclusionProbe = await probe("环境遮蔽", () => verifyAmbientOcclusion(session));
  const temporalAaProbe = await probe("时域抗锯齿", () => verifyTemporalAa(session));
  const bloomEnergyProbe = await probe("HDR 辉光能量", () => verifyBloomEnergy(session));
  const groundAlbedoProbe = await probe("地面反照率", () => verifyGroundAlbedo(session));
  const hdrEnvironmentProbe = await probe("真实 HDRI 环境", () => verifyHdrEnvironment(session));
  const gpuResidencyProbe = await probe("GPU 驻留事务", () => verifyGpuResidencyTransactions(session));
  const transientBudgetProbe = await probe("临时纹理预算", () => verifyTransientBudget(session));
  const deviceBudgetProbe = await probe("设备资源准入", () => verifyDeviceBudget());
  const gpuMixedResidencyProbe = await probe("GPU 混合驻留", () => verifyGpuMixedResidency(session));
  const gpuTextureMipResidencyProbe = await probe("纹理 Mip 驻留", () => verifyGpuTextureMipResidency(session));
  const residentPacketFrameProbe = await probe("PBR 驻留包帧边界", () =>
    verifyPbrResidentPacketFrameBoundary(renderer, canvas));
  const partialLodResidencyProbe = await probe("PBR 部分 LOD 驻留", () =>
    verifyPbrPartialLodResidency(renderer, canvas));
  const residencyStreamProbe = await probe("PBR 驻留流", () => verifyPbrResidencyStream(renderer, canvas));
  const sceneChunkResidencyProbe = await probe("大场景 Chunk 驻留", () =>
    verifySceneChunkResidency(renderer, canvas));
  const realAssetPixelProbe = new URLSearchParams(location.search).get("realAssetPixels") === "1"
    ? await probe("真实 glTF 像素语义", () => verifyRealAssetPixelSemantics(renderer, canvas, signal))
    : Object.freeze({ action: "real-gltf-pixel-semantics", success: true, skipped: true,
      reason: "Run the dedicated browser gate with ?realAssetPixels=1." });
  const combinedLoadProbe = new URLSearchParams(location.search).get("combinedLoad") === "1"
    ? await probe("组合大场景负载", () => runCombinedLoadWebGpuProbe(session, signal))
    : Object.freeze({ action: "combined-large-scene-load", success: true, skipped: true,
      reason: "Run the dedicated browser gate with ?combinedLoad=1." });

  const records = Object.freeze([
    packageProbe,
    shaderHotReloadProbe,
    deepSlPbrProbe,
    deepSlCsmProbe,
    materialModesProbe,
    baseColorTextureProbe,
    pbrTextureSlotsProbe,
    unlitProbe,
    cullingProbe,
    { action: "gpu-affine-bounds", success: affineBoundsProbe.passed, ...affineBoundsProbe },
    compressedTextureProbe,
    { action: "hi-z-pyramid", success: hiZProbe.passed, ...hiZProbe },
    { action: "hi-z-occlusion-culling", success: hiZOcclusionProbe.passed, ...hiZOcclusionProbe },
    { action: "meshlet-gpu-culling", success: meshletCullingProbe.passed, ...meshletCullingProbe },
    { action: "meshlet-indirect-draw", success: meshletIndirectProbe.passed, ...meshletIndirectProbe },
    cascadedShadowProbe,
    localSpotShadowProbe,
    probeClipmapCaptureProbe,
    probeClipmapPbrProbe,
    gpuParticleProbe,
    forwardPlusProbe,
    forwardPlusPbrProbe,
    animationProbe,
    animationTransitionProbe,
    gpuSkinningProbe,
    gpuMorphProbe,
    gpuMorphSkinningProbe,
    { action: "gpu-lod-selection", success: gpuLodSelectionProbe.passed, ...gpuLodSelectionProbe },
    { action: "packet-lod-parallel", success: packetLodParallelProbe.passed, ...packetLodParallelProbe },
    { action: "packet-shadow-lod", success: packetShadowLodProbe.passed, ...packetShadowLodProbe },
    weightedOitProbe,
    ambientOcclusionProbe,
    temporalAaProbe,
    bloomEnergyProbe,
    groundAlbedoProbe,
    hdrEnvironmentProbe,
    gpuResidencyProbe,
    transientBudgetProbe,
    deviceBudgetProbe,
    gpuMixedResidencyProbe,
    gpuTextureMipResidencyProbe,
    residentPacketFrameProbe,
    partialLodResidencyProbe,
    residencyStreamProbe,
    sceneChunkResidencyProbe,
    realAssetPixelProbe,
    combinedLoadProbe,
  ]);
  const passed = Boolean(packageProbe.success && shaderHotReloadProbe.success && deepSlPbrProbe.success && deepSlCsmProbe.success
    && materialModesProbe.success && baseColorTextureProbe.success
    && pbrTextureSlotsProbe.success && unlitProbe.success && cullingProbe.success && affineBoundsProbe.passed && compressedTextureProbe.success
    && hiZProbe.passed && hiZOcclusionProbe.passed && meshletCullingProbe.passed
    && meshletIndirectProbe.passed && cascadedShadowProbe.success && localSpotShadowProbe.success
    && probeClipmapCaptureProbe.success && probeClipmapPbrProbe.success
    && gpuParticleProbe.success && forwardPlusProbe.success
    && forwardPlusPbrProbe.success && animationProbe.success && animationTransitionProbe.success
    && gpuSkinningProbe.success && gpuMorphProbe.success
    && gpuMorphSkinningProbe.success
    && gpuLodSelectionProbe.passed && packetLodParallelProbe.passed && packetShadowLodProbe.passed
    && weightedOitProbe.success && ambientOcclusionProbe.success
    && temporalAaProbe.success && bloomEnergyProbe.success && groundAlbedoProbe.success && hdrEnvironmentProbe.success
    && gpuResidencyProbe.success && transientBudgetProbe.success && deviceBudgetProbe.success && gpuMixedResidencyProbe.success && gpuTextureMipResidencyProbe.success
    && residentPacketFrameProbe.success && partialLodResidencyProbe.success && residencyStreamProbe.success
    && sceneChunkResidencyProbe.success && realAssetPixelProbe.success && combinedLoadProbe.success);
  return Object.freeze({ records, passed });
}
