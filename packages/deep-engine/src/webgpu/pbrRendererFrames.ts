//! PBR 帧编排(原 PbrRenderer.renderPreparedFrame 私有方法域,整体迁出守住 800 行体量门)。
//! host 为类型层结构视图(运行时即 PbrRenderer 实例本体);成员语义与原类内一致,函数体逐字未改。
import * as THREE from "three";
import { DeviceSession } from "./deviceSession.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";
import { uploadBuffer } from "./meshBuffers.js";
import { authoredShadowPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { openPbrRenderer } from "./pbrRendererBootstrap.js";
import { snapshotPipelineCompileRecords } from "./pipelineCompileSnapshot.js";
import { validatePbrFrame } from "./validatePbrFrame.js";
import { RenderTargets } from "./renderTargets.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import { PacketBuffers } from "./packetBuffers.js";
import type { InstanceUpdate, RenderPacket } from "../renderPacket.js";
import { pickScene, pickingUnavailable, type PickOptions, type PickResult } from "./picking.js";
import { spherePacket } from "./spherePacket.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PbrPostProcessChain, type PbrPostProcessInput } from "./pbrPostProcessChain.js";
import { resolvePbrPostProcessOverrides } from "./pbrPostProcessOverrides.js";
import { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import { pbrVisibilityInput } from "./pbrVisibilityInput.js";
import { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import { transformWorldLightsToView } from "../lighting/worldLights.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { scalePbrEnvironmentRadiance } from "./pbrEnvironmentIntensity.js";
import { PreviousHiZVisibility, type PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import { PbrShadowState } from "./pbrShadowState.js";
import { ContactShadowResources, describeContactShadowPass, describeContactApplyPass } from "../shadows/contactShadowResources.js";
import { hasClusteredLights, resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import { resolveDeepGiProducerDirectionCount } from "../lighting/probeRadianceDirectionGate.js";
import type { FrameMetrics, PbrRendererOptions, RenderView } from "./pbrRendererTypes.js";
import { abortableGpu } from "./gpuAbort.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import { createPbrEnvironment, type PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import { PbrEnvironmentState, type EnvironmentStageResult } from "./pbrEnvironmentState.js";
import { PbrMainBindings } from "./pbrMainBindings.js";
import { PbrLodWork } from "./pbrLodWork.js";
import { runResourceCleanup } from "./resourceCleanup.js";
import { PbrOutputBindings, type PbrPresentReceipt } from "./pbrOutputBindings.js";
import { PbrRendererDiagnostics } from "./pbrRendererDiagnostics.js";
import { validatePbrRenderView } from "./pbrRenderViewValidation.js";
import { beginPbrOpaquePass } from "./pbrOpaquePass.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { pbrDirectDisplayClear } from "./pbrDirectDisplay.js";
import { createPbrGround, drawPbrGround, type PbrGroundResources } from "./pbrGroundPass.js";
import { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import type { PbrTransientTextureHandle } from "./pbrTransientTextureTypes.js";
import type { SurfaceSize } from "./surfaceSize.js";
import { PbrDepthResolvePass } from "./pbrDepthResolve.js";
import { DynamicResolutionScaler, internalResolutionReport,
  DEFAULT_RESOLUTION_SCALE_POLICY, type ResolutionScalePolicy } from "../postprocess/resolutionScaler.js";
import { internalRenderSize, temporalUpscaleActive } from "../postprocess/temporalUpscaleCpu.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses, assertPlanMatchesActual,
  createPbrFrameReceipt, pbrFramePassTimingsUnavailable } from "./pbrFramePlanExecutor.js";
import type { PbrFramePassTimings, PbrReceiptTimingAvailability } from "./pbrFrameReceipt.js";
import { computePbrFrameExecutionCoverage } from "./pbrFrameExecutionCoverage.js";
import { PbrFrameCapture } from "./pbrFrameCapture.js";
import type { PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";
import type { FrameCaptureSession } from "../r12/frameCapture.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { pbrGodRaysFrame } from "./pbrGodRaysFrame.js";
import { encodeRenderGraphEncoderGroup } from "./renderGraphEncoderExecutor.js";
import type { RenderGraphCompileResult } from "../renderGraph.js";
import { AdaptiveQualityController, adaptiveShadowMapSize } from "./adaptiveQuality.js";
import type { CascadedShadowQualityTier } from "../shadows/shadowQuality.js";
import { ProbeClipmapPbrController, type ProbeClipmapPbrTarget } from "./probeClipmapPbrController.js";
import { ProbeSceneRadianceProducer } from "../rayTracing/probeSceneRadianceProducer.js";
import { EnvironmentAmbientReader, type EnvironmentAmbient } from "./environmentAmbientReader.js";
import { PbrParticlePass } from "./pbrParticlePass.js";
import { GaussianSplatSceneOwner, type SplatStageResult } from "./gaussianSplatSceneOwner.js";
import type { SplatCloud } from "../gaussianSplat/decodeSplatPly.js";
import { pbrSplatFrame } from "./pbrSplatFrame.js";
import { createGpuParticleRuntimeFromEmitters, submitGpuParticleEmitterFrame } from "./gpuParticleEmitters.js";
import type { GpuParticleRuntime } from "./gpuParticleRuntime.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";
import { VisibilityBufferPath } from "./visibilityBufferPass.js";
import { SoftRasterizeFallback } from "./softRasterizeFallback.js";
import { ClusterLodRenderSlot, type ClusterLodSceneStaging } from "./clusterLodRenderSlot.js";
import { resolveClusterLodSlotOption } from "./clusterLodSlotSupport.js";
import { PbrAutoExposureRuntime } from "./pbrAutoExposure.js";
import { createVirtualTextureFrameBridge, virtualTextureUvBounds, type VirtualTextureFrameBridge,
  type VirtualTextureFeedbackEntry, type VirtualTextureFrameMetrics } from "./virtualTextureFrameBridge.js";
import { VirtualTextureTileLookupPass } from "./virtualTextureSampling.js";
import type { VirtualShadowDynamicInput, VirtualShadowObjectInput } from "../shadows/virtualShadowPages.js";
import type { CachedPacketGeometry } from "./packetBufferTypes.js";

export interface PbrRendererFrameHost {
  readonly adaptiveQuality: AdaptiveQualityController | undefined;
  adaptiveShadowSize: number | undefined;
  adaptiveShadowStage: AbortController | undefined;
  allocationPlan: RenderGraphCompileResult | undefined;
  allocationPlanKey: string | undefined;
  ambientEnvironment: StudioEnvironment | undefined;
  ambientReader: EnvironmentAmbientReader | undefined;
  readonly autoExposure: PbrAutoExposureRuntime | undefined;
  readonly cameraHistory: CameraFrameHistory;
  captureActualPasses: ReturnType<typeof collectActualPbrFramePasses> | undefined;
  capturePlan: ReturnType<typeof buildPbrFrameExecutionPlan> | undefined;
  capturePlanKey: string | undefined;
  clusterLodSlot: ClusterLodRenderSlot | undefined;
  readonly contactShadows: ContactShadowResources | undefined;
  readonly deviceEpoch: RendererDeviceEpoch;
  readonly depthResolve: PbrDepthResolvePass | undefined;
  readonly diagnostics: PbrRendererDiagnostics;
  readonly gpuTimer: PbrRendererDiagnostics["gpuTimer"];
  driveParticles(frame: number, flow: RenderView["particleFlow"]): void;
  driveProbeClipmap(frame: number, size: { readonly width: number; readonly height: number }, eye: readonly [number, number, number], cameraCut: boolean): void;
  readonly environment: PbrEnvironmentState;
  environmentAmbient: EnvironmentAmbient;
  features: PbrRendererFeatures;
  frame: number;
  readonly frameBuffer: GPUBuffer;
  readonly frameCapture: PbrFrameCapture | undefined;
  readonly frameData: Float32Array<ArrayBuffer>;
  readonly ground: PbrGroundResources;
  historyDirty: boolean;
  lastAuthorShadowSize: number | undefined;
  lastFrameReadback: Promise<readonly PbrFrameReadbackResult[]> | undefined;
  readonly lighting: ForwardPlusPbrRuntime;
  /** AA-M1:主 pass 生效采样数(bootstrap 能力探针结果;1x 渲染器逐字节回旧行为)。 */
  readonly mainSampleCount: 1 | 4;
  readonly msaaMetrics: FrameMetrics["msaa"];
  readonly localShadows: LocalSpotShadowRuntime;
  readonly mainBindings: PbrMainBindings;
  readonly outputs: PbrOutputBindings;
  readonly particlePass: PbrParticlePass | undefined;
  readonly particleRuntime: GpuParticleRuntime | undefined;
  pendingHiZ: PreviousHiZFramePlan | undefined;
  readonly packets: PacketBuffers;
  readonly performanceTelemetry: PbrRendererDiagnostics["performance"];
  readonly pipelines: Pipelines;
  readonly postProcess: PbrPostProcessChain;
  readonly preparationGroupIndex: number;
  readonly preparationPlan: RenderGraphCompileResult;
  previousAmbientOcclusion: boolean | undefined;
  previousFrameCameraCut: boolean;
  readonly previousHiZ: PreviousHiZVisibility;
  previousTemporalLights: RenderView["lights"];
  probeRadianceProducer: ProbeSceneRadianceProducer | undefined;
  refreshAdaptiveShadowRequest(authorShadowSize: number | undefined): void;
  render(view: RenderView): FrameMetrics | undefined;
  resolutionScale: number;
  resolutionScaleRevision: number;
  readonly resolutionScaler: DynamicResolutionScaler | undefined;
  readonly session: DeviceSession;
  sceneChanged(): void;
  shadowDirty: boolean;
  readonly shadowState: PbrShadowState;
  /** B1 Brief-VSM 主阴影档(缺省 undefined = 级联回退档)。 */
  readonly shadowMode: "virtual" | "cascaded";
  readonly virtualShadows: import("./virtualShadowResources.js").VirtualShadowResources | undefined;
  readonly virtualShadowFallbackReason: string | undefined;
  readonly shadows: PbrShadowState["current"];
  splats: GaussianSplatSceneOwner | undefined;
  stageAdaptiveShadow(mapSize: number): void;
  readonly targets: RenderTargets;
  temporalLightRevision: number;
  readonly transientTextures: PbrTransientTexturePool;
  readonly transparency: PbrTransparencyPass;
  readonly virtualTextures: VirtualTextureFrameBridge | undefined;
  readonly virtualTileLookup: VirtualTextureTileLookupPass | undefined;
  readonly visibility: VisibilityBufferPath | undefined;
  readonly writeGeometryBuffers: boolean;
}

/** 原类私有帧编排(体逐字未改;this → host)。 */
/** batch 球体 → 屏幕圆盘像素面积(静态代理):focal = height/2 / tan(fov/2),
 *  透视深取 clip w;w≤0 或 NDC z 出 [0,1](WebGPU 口径)显式 0 = 不产反馈。 */
function virtualTextureScreenPixels(geometry: CachedPacketGeometry, viewProjection: Float32Array,
  verticalFovRadians: number, size: { readonly width: number; readonly height: number }): number {
  const [cx, cy, cz] = geometry.center;
  const w = viewProjection[3]! * cx + viewProjection[7]! * cy + viewProjection[11]! * cz + viewProjection[15]!;
  if (!(w > 0)) return 0;
  const z = viewProjection[2]! * cx + viewProjection[6]! * cy + viewProjection[10]! * cz + viewProjection[14]!;
  if (z < 0 || z > w) return 0;
  const focal = size.height / (2 * Math.tan(verticalFovRadians / 2));
  const radiusPx = geometry.radius * focal / w;
  return Math.PI * radiusPx * radiusPx;
}

export function renderPreparedFrame(host: PbrRendererFrameHost, view: RenderView): FrameMetrics | undefined {
    const begin = performance.now();
    if (host.session.state !== "ready") return undefined;
    if (host.session.hasErrors) throw new Error("GPU validation failed; inspect device diagnostics.");
    validatePbrRenderView(view);
    // F8 自动曝光(opt-in):环境 mip 亮度静态代理(零 readback)→ ±EV 包络 →
    // 时域平滑(帧间收敛上限防闪烁)。无可靠亮度时 advance 返回 undefined,保持
    // 调用方固定启发式 view.exposure(fail-closed);原因见 FrameMetrics.autoExposure。
    if (host.autoExposure !== undefined) {
      const exposureFrame = host.autoExposure.advance(begin, host.previousFrameCameraCut);
      if (exposureFrame !== undefined) view = { ...view, exposure: exposureFrame.exposure };
    }
    const postProcess = resolvePbrPostProcessOverrides(view.postProcess, host.features);
    if (host.previousAmbientOcclusion !== undefined && host.previousAmbientOcclusion !== postProcess.ambientOcclusion) {
      host.historyDirty = true;
    }
    if (host.environment.beginFrame(candidate => host.mainBindings.setEnvironment(candidate))) host.historyDirty = true;
    if (view.lights !== host.previousTemporalLights) {
      host.previousTemporalLights = view.lights; host.temporalLightRevision += 1;
    }
    const sceneLighting = resolvePbrSceneLighting(view.lights);
    if (host.mainBindings.update(view.lights, view.fog)) host.historyDirty = true;
    // F1 scene-radiance latch: the producer packs whatever was latest at capture encode time,
    // so probes shade with the same primary light the raster pass uses. The ambient term is
    // the environment's GPU-read average — the F1 slice-2 contract (d1626b2f), which
    // supersedes slice-1's transitional [0,0,0] start. It stays zero only until the first
    // readback lands, and a zero total energy still fails closed (no dark volume is ever
    // published). Miss directions record host ambient as physical sky radiance; do not
    // revert it to a hard zero (that regresses outdoor probes' sky fill).
    // F5-L4: the average is scaled by the SAME authored environmentIntensity the display
    // applies to `environmentIrradiance` before GI blending (scalePbrEnvironmentRadiance —
    // "CPU reference for IBL radiance before BRDF evaluation and GI blending"). Feeding the
    // raw average made every miss direction carry `1/intensity`× the IBL energy the valid
    // probes replace, so "GI on" rendered a door-independent wash (sealed-room sentinel
    // leakRatio ≈ 1 regardless of probe content).
    const currentEnvironment = host.environment.current;
    if (host.probeRadianceProducer && host.ambientEnvironment !== currentEnvironment
      && !host.ambientReader?.busy) {
      host.ambientEnvironment = currentEnvironment;
      host.ambientReader ??= new EnvironmentAmbientReader(host.session);
      void host.ambientReader.read(currentEnvironment).then(ambient => {
        host.environmentAmbient = ambient;
      }).catch(() => { /* keep the last committed average; capture stays fail-closed */ });
    }
    host.probeRadianceProducer?.syncLighting({
      primary: { surfaceToLightWorld: [...sceneLighting.primary.surfaceToLightWorld],
        color: [...sceneLighting.primary.color], intensity: sceneLighting.primary.intensity },
      ambient: scalePbrEnvironmentRadiance(host.environmentAmbient, view.environmentIntensity) });
    if (host.pendingHiZ) { host.previousHiZ.failFrame(host.pendingHiZ); host.pendingHiZ = undefined; }
    host.packets.failLodFrame();
    host.packets.cancelDeformationFrame();
    host.cameraHistory.cancelPendingFrame();
    try {
      if (host.packets.publishResidentProjection()) host.sceneChanged();
    } catch (error) {
      host.sceneChanged(); throw error;
    }
    if (host.resolutionScaler && host.frame > 0) {
      // 前一帧的 CPU 编码时间驱动缩放决策；无样本（首帧/诊断关闭）保持 1 不猜测。
      const previousCpu = host.diagnostics.performance.snapshot().stages["frame-encode"];
      const frameMs = previousCpu?.p50Ms;
      if (frameMs !== undefined) {
        const decision = host.resolutionScaler.observe(frameMs);
        if (decision.scale !== host.resolutionScale) {
          host.resolutionScale = decision.scale;
          host.resolutionScaleRevision += 1;
        }
      }
    }
    // F4 时域超分联动:激活(特性开 + scale<1)时画布保持全分辨率、渲染目标按 scale
    // 降档,链尾上采样核重建到画布;未激活沿用原口径(画布即渲染分辨率,浏览器拉伸)。
    const upscaling = temporalUpscaleActive(host.features.temporalUpscale, host.resolutionScale);
    const surface = host.session.resize(view.width, view.height,
      view.pixelRatio * (upscaling ? 1 : host.resolutionScale));
    if (!surface) return undefined;
    const size = upscaling ? internalRenderSize(surface, host.resolutionScale) : surface;
    const authorShadowSize = sceneLighting.primary.shadow?.mapSize;
    if (authorShadowSize !== host.lastAuthorShadowSize) {
      host.lastAuthorShadowSize = authorShadowSize;
      // A fresh author request supersedes any adaptive shadow request still in flight.
      host.adaptiveShadowSize = undefined;
    }
    host.refreshAdaptiveShadowRequest(authorShadowSize);
    const desiredShadowSize = host.adaptiveShadowSize ?? authorShadowSize;
    if (desiredShadowSize !== undefined && desiredShadowSize !== authorShadowSize
      && host.adaptiveShadowStage === undefined
      && desiredShadowSize !== host.shadowState.current.selection.profile.options.shadowMapSize) {
      host.stageAdaptiveShadow(desiredShadowSize);
    }
    if (host.shadowState.publish(desiredShadowSize, candidate => host.mainBindings.setShadows(candidate, host.environment.current))) host.sceneChanged();
    const drawProfile = host.packets.drawProfile();
    // B1 Brief-VSM:虚拟档帧签名 —— 直出 display 快路径只有单级联 legacy 采样语义,
    // 无法消费页表,虚拟档请求存在时强制走完整 HDR 链(fail-closed,不静默降质)。
    const virtualShadowRequested = host.shadowMode === "virtual" && host.virtualShadows !== undefined
      && !sceneLighting.primary.shadow;
    const outlined = host.packets.hasOutline();
    const directClear = outlined || host.session.hdrCanvasActive || drawProfile.hasDeformation || view.authorGrid || host.particleRuntime || host.splats?.current?.splatCount || virtualShadowRequested
      ? undefined : pbrDirectDisplayClear(view, host.features, drawProfile.hasTransparent, host.writeGeometryBuffers);
    const directionalDisplay = directClear !== undefined && !host.lighting.hasProbeClipmap && !hasClusteredLights(sceneLighting.clustered)
      && !drawProfile.hasMaterialTextures && host.pipelines.displayDirectionalMain !== undefined;
    const frameState = updatePbrFrameUniforms(host.session.device.queue, host.cameraHistory, view,
      size.width, size.height, host.historyDirty, { frameBuffer: host.frameBuffer, outputBuffer: host.outputs.buffer,
        groundInstance: host.ground.instance, frameData: host.frameData, outputData: host.outputs.data, groundData: host.ground.data },
      sceneLighting.primary, host.features);
    const history = frameState.history;
    host.previousFrameCameraCut = history.cameraCut;
    const hiZPlan = host.features.occlusionCulling ? host.previousHiZ.beginFrame({
      frameRevision: history.revision, sceneRevision: host.packets.visibilityRevision,
      depthViewProjection: frameState.depthViewProjection, stableViewProjection: frameState.stableViewProjection, cameraPosition: view.eye,
      viewport: [size.width, size.height], reversedZ: false, cameraCut: history.cameraCut,
    }) : undefined;
    host.pendingHiZ = hiZPlan;
    const device = host.session.device;
    let submitAttempted = false;
    let particleReactive: PbrTransientTextureHandle | undefined;
    let captureOpen = false;
    try {
      const frameNumber = host.frame + 1;
      host.driveParticles(frameNumber, view.particleFlow);
      host.driveProbeClipmap(frameNumber, size, view.eye, history.cameraCut);
      // AA-M1 深度消费判定(主 pass 编码与计划对拍共用;必须在 captureForFrame 前得出):
      // 主 pass 之后读取/加载硬件深度的全部消费方 —— Hi-Z(采样 depthTexture)、
      // 透明 OIT(load 测试)、粒子/样条/作者网格(附件 load)、可见性合成、对象描边
      // (read-only 附件)、display 空间背景(equal 比较附件)。无消费方时 MSAA 深度
      // 直接 depthStoreOp:"discard";有消费方时 store + 主 pass 后深度 resolve pass。
      const particleBinding = host.particleRuntime?.current?.binding;
      const splatCount = host.splats?.current?.splatCount ?? 0;
      const depthConsumedAfterPass = !directClear && (host.features.occlusionCulling || drawProfile.hasTransparent || outlined
        || (host.particlePass !== undefined && particleBinding !== undefined) || splatCount > 0
        || view.authorGrid !== undefined || host.visibility !== undefined
        || view.panoramaBackground?.toneMapped === false);
      // The same cached plan powers explicit captures, the lightweight live
      // Frame Graph receipt, and the execution coverage readout. The plan is
      // key-cached (string compare per frame); only a feature/size change pays
      // plan construction. F1: receipts are now regular — every frame carries
      // pass order / executed set, while per-pass GPU timings stay on the
      // async gpuPassTimings channel.
      const capturePlan = captureForFrame(host, size, drawProfile.hasTransparent, postProcess, directClear !== undefined, depthConsumedAfterPass);
      if (host.frameCapture && capturePlan) {
        host.frameCapture.begin(`frame-${frameNumber}`, capturePlan.plan);
        captureOpen = true;
      }
      const allocationPlan = allocationPlanFor(host, drawProfile.hasTransparent, postProcess, directClear !== undefined);
      // Capture can append readbacks outside the production graph; keep its resources physically distinct.
      // 直出 display 帧不经 MSAA 主通路,不分配 MSAA 附件(第 4 参)。
      host.targets.beginFrame(size, host.frameCapture ? [] : allocationPlan.resources, host.writeGeometryBuffers,
        !directClear);
    let lighting: ReturnType<ForwardPlusPbrRuntime["prepareAndEncode"]> | undefined;
    // Static packets have no deformation work. Encode their light assignment in the main
    // command buffer instead of allocating and submitting an empty parallel encoder.
    const preparation = directionalDisplay || !drawProfile.hasDeformation ? undefined : encodeRenderGraphEncoderGroup(device,
      host.preparationPlan, host.preparationGroupIndex, new Map([
        ["deform", ({ encoder }) => host.packets.encodeDeformation(encoder)],
        ["cluster-lights", ({ encoder }) => {
          lighting = host.lighting.prepareAndEncode(encoder, { viewportWidth: size.width, viewportHeight: size.height,
            near: frameState.projection.near, far: frameState.projection.far,
            verticalFovRadians: frameState.projection.verticalFovRadians,
            lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
        }],
      ]), { encoderLabelPrefix: "Deep PBR prepare" });
    const encoder = device.createCommandEncoder({ label: "Deep frame" });
    // F4 虚拟纹理逐帧推进(opt-in):batch 级反馈代理 → 预算驻留 → tile-lookup 消费
    // 编码,全部挂主 encoder;驻留时钟独立自增(渲染失败重试帧不破坏单调合同)。
    const virtualTexturesMetrics = host.virtualTextures
      ? driveVirtualTextures(host, frameState, size, encoder) : undefined;
    // G1-S1 簇级槽位：选层 compute pass + 读回拷贝追加到主 encoder（相机静止时零工作）。
    // 仅 plain HDR 帧签名可执行；MRT/directDisplay 记录 sticky fallback（不静默降级）。
    const clusterLod = host.clusterLodSlot;
    const clusterLodSupported = clusterLod !== undefined && !directClear && !host.writeGeometryBuffers;
    if (clusterLod && !clusterLodSupported) clusterLod.noteFrameSignatureUnsupported();
    if (clusterLod && clusterLodSupported && !clusterLod.hasFallback()) {
      clusterLod.updateCameraFromView(view, size.height, frameState.projection.verticalFovRadians);
      clusterLod.setViewProjection(frameState.depthViewProjection);
      clusterLod.encodeFrame(encoder);
    }
    if (!preparation && drawProfile.hasDeformation) host.packets.encodeDeformation(encoder);
    if (!preparation && !directionalDisplay) lighting = host.lighting.prepareAndEncode(encoder, {
      viewportWidth: size.width, viewportHeight: size.height,
      near: frameState.projection.near, far: frameState.projection.far,
      verticalFovRadians: frameState.projection.verticalFovRadians,
      lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView),
    });
    const visibility = pbrVisibilityInput(view, frameState.projection, size.width, size.height, history.cameraCut,
      host.adaptiveQuality?.state().knobs.lodDetailScale ?? 1);
    const previousHiZ = hiZPlan ? host.previousHiZ.occlusionView(hiZPlan) : undefined;
    const mainFrustum = visibility.frustum, lodStats = host.packets.encodeLod(encoder,
      previousHiZ ? { ...visibility.lod, previousHiZ } : visibility.lod);
    const lodWork = new PbrLodWork(lodStats);
    const hasTransparent = drawProfile.hasTransparent;
    const detailedTiming = directClear === undefined && !view.editorOverlay?.vertices.length;
    // F1 逐 pass 计时:pass 清单取自同一帧的执行计划 ∩ executed 集合(单一 pass 身份
    // 来源,禁止第二套)。scope 不可用(不支持/槽忙/超容)时回退帧级三段计时。
    const executedPasses = executedCapturePassIds(host, directClear !== undefined, postProcess, hasTransparent, upscaling);
    const passTiming = capturePlan && host.gpuTimer.passTimingEnabled ? host.gpuTimer.beginPasses(host.frame + 1,
      capturePlan.plan.mappedPassIds.filter(passId => executedPasses.has(passId))) : undefined;
    const timing = passTiming ? undefined : host.gpuTimer.begin(host.frame + 1, detailedTiming);
    const timingStart = timing ? { timestampWrites: { querySet: timing.queries, beginningOfPassWriteIndex: 0 } } : {};
    // B1 Brief-VSM 主阴影档分派:virtual = 三环 clipmap 页物化(逐帧 Top-K,动态页
    // 最高优先);级联保持回退档 —— author 阴影/虚拟未装配/构造失败/动态禁用均回级联,
    // 不静默。级联 prepare 以 enabled=false 保活(重启用时自动失效重建)。
    const primaryShadowEnabled = sceneLighting.primary.castShadow !== false;
    const virtualShadowActive = virtualShadowRequested && primaryShadowEnabled;
    const shadowFrame = host.shadows.prepare({ eye: view.eye, target: view.target, ...(view.up ? { up: view.up } : {}),
      verticalFovRadians: frameState.projection.verticalFovRadians, aspect: size.width / size.height,
      near: frameState.projection.near, far: frameState.projection.far, extent: view.extent,
      lightDirection: sceneLighting.primary.rayDirectionWorld, ...(sceneLighting.primary.shadow ? { authored: sceneLighting.primary.shadow, viewportHeight: size.height } : {}) }, host.shadowDirty, !virtualShadowActive && primaryShadowEnabled);
    let shadowUpdated = shadowFrame.render;
    let drawCalls = view.panoramaBackground ? 1 : 0, triangles = drawCalls;
    let virtualShadowMetrics: FrameMetrics["virtualShadow"] | undefined;
    if (virtualShadowActive && host.virtualShadows) {
      const shadowInputs = collectVirtualShadowObjects(host, frameState, size);
      const virtualPlan = host.virtualShadows.prepare({ eye: view.eye, target: view.target,
        ...(view.up ? { up: view.up } : {}), verticalFovRadians: frameState.projection.verticalFovRadians,
        aspect: size.width / size.height, near: frameState.projection.near, far: frameState.projection.far,
        extent: view.extent, lightDirection: sceneLighting.primary.rayDirectionWorld,
        sceneRevision: host.packets.visibilityRevision, objects: shadowInputs.objects,
        ...(shadowInputs.dynamic.length ? { dynamicObjects: shadowInputs.dynamic } : {}) },
        host.shadowDirty, true);
      let pageDrawCalls = 0, pageRenderPasses = 0;
      if (virtualPlan.render) {
        // 页管线变体:shadowPipelines 键同名替换为写 r32float 光深的页物化管线,
        // 其余管线槽沿用主管线集(packetDraw 只在 shadow 相位消费 shadowPipelines)。
        const pagePipelines: PbrRendererFrameHost["pipelines"] = { ...host.pipelines,
          shadowPipelines: host.pipelines.pageShadowPipelines };
        const pageStats = host.virtualShadows.encodePages(encoder, host.packets, pagePipelines,
          virtualPlan, timingStart);
        pageDrawCalls = pageStats.drawCalls; pageRenderPasses = pageStats.passes;
        drawCalls += pageStats.drawCalls; triangles += pageStats.triangles;
        shadowUpdated = true;
      }
      // 页表/atlas 挂入组 0:必须无条件(驻留页在零物化帧也要被采样)且先于主 pass
      // 捕获组 0 绑定组(迟挂 = 采样占位 → 全受光)。绑定引用稳定,内容经 writeBuffer 更新。
      host.mainBindings.setVirtualFrameBinding(host.virtualShadows.frameVirtualBinding);
      virtualShadowMetrics = { mode: "virtual",
        ...(host.virtualShadowFallbackReason ? { fallbackReason: host.virtualShadowFallbackReason } : {}),
        materializedPages: virtualPlan.stats.materializedPages, requestPages: virtualPlan.stats.requestPages,
        deferredByBudget: virtualPlan.stats.deferredByBudget,
        dynamicInvalidated: virtualPlan.stats.dynamicInvalidated,
        residentPages: virtualPlan.stats.residentPages, evictedPages: virtualPlan.stats.evictedPages,
        estimatedCostMs: virtualPlan.stats.estimatedCostMs,
        budgetUtilization: virtualPlan.stats.budgetUtilization,
        pageDrawCalls, pageRenderPasses };
    }
    if (shadowUpdated && !virtualShadowActive) {
      const shadowLodStats = host.packets.encodeShadowLod(encoder, shadowFrame.plan);
      lodWork.add(shadowLodStats);
      shadowFrame.plan.cascades.forEach((cascade, index) => {
        host.packets.encodeCulling(encoder, viewProjectionFrustum(cascade.viewProjection), "shadow", undefined, index);
        const shadow = encoder.beginRenderPass({ label: `Deep shadow cascade ${index}`,
          ...(index === 0 ? timingStart : {}), colorAttachments: [], depthStencilAttachment: {
            view: host.shadows.layerViews[index]!, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store",
          } });
        shadow.setPipeline(host.pipelines.shadow);
        shadow.setBindGroup(0, host.shadows.frameBindings[index]!);
        const stats = host.packets.draw(shadow, sceneLighting.primary.shadow ? authoredShadowPipelines(host.pipelines) : host.pipelines, "shadow", undefined, true, index, false, !!sceneLighting.primary.shadow);
        drawCalls += stats.drawCalls; triangles += stats.triangles;
        shadow.end();
      });
    }
    const localShadow = lighting ? host.localShadows.prepareAndEncode(encoder, host.packets, host.pipelines, sceneLighting.clustered,
      host.shadowDirty, !shadowUpdated && timing ? timingStart.timestampWrites : undefined) : { rendered: false, drawCalls: 0, triangles: 0 };
    shadowUpdated ||= localShadow.rendered; drawCalls += localShadow.drawCalls; triangles += localShadow.triangles;
    lodWork.add(localShadow);
    const opaqueCulling = host.packets.encodeCulling(encoder, mainFrustum, "opaque",
      { sceneRevision: host.packets.visibilityRevision, ...(previousHiZ ? { previousHiZ } : {}) });
    if (!hasTransparent) host.transparency.clearReactiveMask();
    let present: PbrPresentReceipt | undefined = directClear ? host.outputs.acquirePresent(host.performanceTelemetry.enabled) : undefined;
    const mainTimestamps = directClear && timing && !view.editorOverlay?.vertices.length ? { querySet: timing.queries,
      ...(!shadowUpdated ? { beginningOfPassWriteIndex: 0 } : {}), endOfPassWriteIndex: 1 }
      : timing && !directClear ? { querySet: timing.queries,
        ...(!shadowUpdated ? { beginningOfPassWriteIndex: 0 } : {}), endOfPassWriteIndex: 2 }
        : !shadowUpdated && timing ? timingStart.timestampWrites : undefined;
    passTiming?.beginMarker(encoder, "opaque");
    // B1 Brief-VSM:group 2 绑定按档分派(虚拟档=页表+页 atlas;级联档=级联数组)。
    const shadowBinding = virtualShadowActive && host.virtualShadows ? host.virtualShadows.binding
      : host.shadows.binding;
    const main = beginPbrOpaquePass(encoder, { targets: host.targets, background: directClear ?? view.background,
      writeGeometryBuffers: host.writeGeometryBuffers, drawBackground: host.mainBindings.prepareBackground(view, host.environment.current, size.width / size.height, host.writeGeometryBuffers, host.mainSampleCount),
      ...(present ? { directDisplayView: present.view } : {}), ...(mainTimestamps ? { timestampWrites: mainTimestamps } : {}),
      depthConsumedAfterPass });
    main.setPipeline(directClear ? host.pipelines.displayMain! : host.pipelines.main);
    main.setBindGroup(0, host.mainBindings.binding);
    main.setBindGroup(2, shadowBinding);
    if (lighting) main.setBindGroup(lighting.bindGroupIndex, lighting.bindGroup);
    const stats = host.packets.draw(main, host.pipelines, directClear ? "display" : "opaque", undefined, true, 0, directionalDisplay);
    drawCalls += stats.drawCalls; triangles += stats.triangles;
    const groundStats = drawPbrGround(host.features.groundPlane, main,
      directClear && directionalDisplay ? host.pipelines.displayDirectionalMain! : directClear ? host.pipelines.displayMain! : host.pipelines.main,
      host.ground.mesh, host.ground.instance, directClear !== undefined);
    drawCalls += groundStats.drawCalls; triangles += groundStats.triangles;
    // G1-S1：簇级前沿 bundle（executeBundles 计 1 次绘制调用；GPU indirect 命令数在
    // metrics.clusterLod.draws 如实报告）。选层为一帧延迟：首帧 warming 不绘制。
    if (clusterLod && clusterLodSupported && !clusterLod.hasFallback()) {
      const clusterLodStats = clusterLod.draw(main);
      if (clusterLodStats) { drawCalls += 1; triangles += clusterLodStats.triangles; }
    }
    main.end();
    passTiming?.endMarker(encoder, "opaque");
    // AA-M1:主 pass 后仍有深度消费方时,先把 MSAA 深度(sample-0)还原到 1x 主帧深度;
    // 透明/粒子/网格/描边/Hi-Z/display 背景等既有消费方全部继续读单采样纹理,零改动。
    if (host.depthResolve && !directClear && depthConsumedAfterPass) {
      passTiming?.beginMarker(encoder, "depth-resolve");
      host.depthResolve.encode(encoder, host.targets.depthMsaa!, host.targets.depth);
      passTiming?.endMarker(encoder, "depth-resolve");
    }
    // MRT 主通路(AO/SSR/TAA/雾的存在前提)必有 linear-depth 消费方;r32float 无硬件
    // resolve,由 compute(sample-0)从 4x 附件还原到 1x 主帧目标。
    if (host.depthResolve && !directClear && host.targets.msaaActive && host.writeGeometryBuffers) {
      passTiming?.beginMarker(encoder, "linear-depth-resolve");
      host.depthResolve.encodeLinearDepth(encoder, host.targets.linearDepthMsaa!, host.targets.linearDepth,
        size.width, size.height);
      passTiming?.endMarker(encoder, "linear-depth-resolve");
    }
    // Particle simulation commits asynchronously; consume the latest committed binding here.
    // A one-frame simulation-to-render latency avoids queue stalls and keeps particle count
    // fully GPU-driven (drawIndirect never reads instance count back to JS).
    if (host.features.temporalAa && ((host.particlePass && particleBinding) || splatCount)) {
      particleReactive = host.transientTextures.acquire({ resourceId: "particle-reactive", format: "r8unorm",
        width: size.width, height: size.height, sampleCount: 1,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    }
    if (host.particlePass && particleBinding) {
      // TAA 开启时才分配响应掩码目标；粒子 alpha 覆盖写入第二目标供时域降反馈。
      host.particlePass.encode({ encoder, colorView: host.targets.hdr, depthView: host.targets.depth,
        width: size.width, height: size.height,
        camera: { viewProjection: [...frameState.depthViewProjection],
          cameraRight: [frameState.worldToView[0]!, frameState.worldToView[4]!, frameState.worldToView[8]!],
          cameraUp: [frameState.worldToView[1]!, frameState.worldToView[5]!, frameState.worldToView[9]!] },
        binding: particleBinding, ...(particleReactive ? { reactiveView: particleReactive.view } : {}) });
      drawCalls++;
    }
    if (splatCount) {
      const count = host.splats!.encode({ encoder, color: host.targets.hdr, depth: host.targets.depth,
        frame: pbrSplatFrame(frameState.worldToView, frameState.depthViewProjection, view.eye,
          size.width, size.height, frameState.projection.verticalFovRadians, frameState.projection.near, view.cameraWorldPosition),
        ...(particleReactive ? { reactiveView: particleReactive.view, clearReactive: !particleBinding } : {}) });
      if (count) { drawCalls++; triangles += count * 2; }
    }
    const gridTriangles = host.ground.author.encode(encoder, host.targets.hdr, host.targets.depth, frameState.depthViewProjection, frameState.worldToView, view.authorGrid);
    if (gridTriangles) { drawCalls++; triangles += gridTriangles; }
    // P0-2 可见性合成（opt-in）：仅 HDR 管线路径；directDisplay 与 authorGrid 快路径保持逐字节不变。
    if (host.visibility && !directClear) {
      host.visibility.encodeComposite(encoder, { hdrView: host.targets.hdr, depthView: host.targets.depth,
        width: size.width, height: size.height, frameData: host.frameData, inputs: host.packets.visibilityInputs() });
    }
    // The chain owns override resolution. Keep the resolved snapshot above for
    // capture planning, but do not feed it back as if it were author input.
    const postProcessInput: PbrPostProcessInput = { encoder, targets: host.targets, revision: history.revision,
      ...(postProcess.volumetricFog && postProcess.volumetricFogProfile.godRaysStrength !== undefined
        ? { godRays: { ...pbrGodRaysFrame(sceneLighting.primary, frameState.worldToView),
          shadows: virtualShadowActive && host.virtualShadows ? host.virtualShadows.godRaysSource()
            : host.shadows.godRaysSource() } } : {}),
      ...(view.postProcess === undefined ? {} : { postProcess: view.postProcess }),
      ...(outlined ? { outline: { viewProjection: frameState.stableViewProjection,
        draw: (pass: GPURenderPassEncoder) => host.packets.drawOutline(pass) } } : {}),
      extent: view.extent, verticalFovRadians: frameState.projection.verticalFovRadians,
      cameraCut: history.cameraCut, currentJitter: history.currentJitter,
      previousJitter: history.previousJitter, materialRevision: host.packets.visibilityRevision,
      lightRevision: host.temporalLightRevision, exposure: view.exposure,
      // T07: the flag now reports real reactive (no-motion-target) region presence:
      // weighted-OIT transparency and GPU particles never write the motion target.
      // Per-pixel mask supply stays unwired until the reactive-mask pass joins the
      // frame plan (see docs/reports/deep-core/T07-implementation.md).
      reactiveMaskAvailable: false,
      // C11:SSR 替换分数与主着色器共用同一 DFG(environment.brdf)。
      ...(host.environment.current ? { brdfLut: host.environment.current.brdf } : {}),
      surfaceWidth: size.width, surfaceHeight: size.height,
      ...(host.adaptiveQuality ? { adaptiveQuality: host.adaptiveQuality.state().knobs } : {}),
      ...(passTiming ? { passTiming } : {}) };
    const opaqueEffects: ReturnType<PbrPostProcessChain["encodeOpaque"]> = directClear
      ? { color: host.targets.hdrTexture, passCount: 0 } : host.postProcess.encodeOpaque(postProcessInput);
    if (hiZPlan && !opaqueEffects.hiZ) throw new Error("Hi-Z visibility enabled without a produced depth pyramid.");
    let temporalInput = opaqueEffects.color;
    if (hasTransparent) {
      const transparentStats = host.transparency.encode({ encoder, opaqueColor: opaqueEffects.color,
        hdrColor: host.targets.hdrTexture, hdrView: host.targets.hdr, depthView: host.targets.depth,
        ...(passTiming ? { passTiming } : {}),
        ...(particleReactive ? { reactiveTarget: { texture: particleReactive.texture, view: particleReactive.view } } : {}),
        viewOf: texture => host.outputs.view(texture), draw: pass => {
          pass.setBindGroup(0, host.mainBindings.binding); pass.setBindGroup(2, shadowBinding);

          pass.setBindGroup(lighting!.bindGroupIndex, lighting!.bindGroup);
          return host.packets.draw(pass, host.pipelines, "transparent", undefined, true);
        } });
      temporalInput = transparentStats.color;
      drawCalls += transparentStats.drawCalls; triangles += transparentStats.triangles;
    }
    const finalEffects = directClear ? { color: temporalInput, passCount: 0 }
      : host.postProcess.encodeFinal({ ...postProcessInput,
        reactiveMaskAvailable: host.transparency.currentReactiveMask !== undefined || particleReactive !== undefined,
        ...(host.transparency.currentReactiveMask ? { reactiveMask: host.transparency.currentReactiveMask }
          : particleReactive ? { reactiveMask: particleReactive.texture } : {}) }, temporalInput);
    if (finalEffects.outline) { drawCalls += finalEffects.outline.drawCalls; }
    // C10 接触阴影(AO 同款管线形态):主 pass 写完 linear-depth 后短距步进生成
    // 半分辨率遮蔽贴,apply 将其乘回最终 HDR(整帧衰减,语义同 SSAO 合成)。
    // 相机切换帧强度归零(fail-closed)。opt-in:features.contactShadows,默认关闭。
    let presentColor = finalEffects.color;
    let contactApplied = false;
    if (host.contactShadows && !directClear) {
      const contactFrame = host.contactShadows.prepare({
        verticalFovRadians: frameState.projection.verticalFovRadians,
        aspect: size.width / size.height, near: frameState.projection.near, far: frameState.projection.far,
        worldToView: [...frameState.worldToView],
        lightDirectionWorld: sceneLighting.primary.rayDirectionWorld,
        extent: view.extent, width: size.width, height: size.height, cameraCut: history.cameraCut,
      }, host.shadowDirty, true);
      const applied = host.contactShadows.encode(encoder, contactFrame, host.targets.linearDepth,
        finalEffects.color, passTiming ?? undefined);
      presentColor = applied.texture;
      contactApplied = true;
    }
    let presentInput = finalEffects.color;
    let upscaleMetrics: FrameMetrics["temporalUpscale"] | undefined;
    if (!directClear) {
      if (contactApplied) presentInput = presentColor;
      // F4 时域超分:激活时链尾重建到画布全分辨率,输出即 present 输入与读回落点。
      if (upscaling) {
        passTiming?.beginMarker(encoder, "temporal-upscale");
        const upscaled = host.postProcess.encodeUpscale({
          encoder, targets: host.targets, revision: history.revision, extent: view.extent,
          cameraCut: history.cameraCut, currentJitter: history.currentJitter,
          previousJitter: history.previousJitter,
          // Reactive mask 与 encodeFinal 同源(透明 OIT/粒子两路,照 638-640 现成模式):
          // 带反应遮罩的像素历史降权,防止超分把透明/粒子变化拖出鬼影。
          ...(host.transparency.currentReactiveMask ? { reactiveMask: host.transparency.currentReactiveMask }
            : particleReactive ? { reactiveMask: particleReactive.texture } : {}),
          displayWidth: surface.width, displayHeight: surface.height,
        }, presentInput);
        if (!upscaled) throw new Error("Temporal upscale is active but the pass is unavailable.");
        presentInput = upscaled.texture;
        presentColor = upscaled.texture;
        upscaleMetrics = Object.freeze({ displayWidth: upscaled.width, displayHeight: upscaled.height,
          historyUsed: upscaled.historyUsed, invalidation: upscaled.invalidation });
        passTiming?.endMarker(encoder, "temporal-upscale");
        drawCalls += 1; triangles += 1;
      }
      passTiming?.beginMarker(encoder, "present");
      present = host.outputs.present(encoder, presentInput, view.authorColorEffects, host.performanceTelemetry.enabled,
        view.editorOverlay?.vertices.length ? undefined : timing?.queries, host.frameCapture !== undefined,
        detailedTiming && timing !== undefined);
      passTiming?.endMarker(encoder, "present");
      drawCalls += host.features.spatialAa ? 2 : 1; triangles += host.features.spatialAa ? 2 : 1;
    }
    if (host.mainBindings.encodeDisplayBackground(encoder, present!.view, host.targets.depth, view,
      host.environment.current, size.width / size.height)) { drawCalls++; triangles++;
    }
    const overlayTriangles = host.outputs.encodeEditorOverlay(encoder, present!.view, view.editorOverlay, timing?.queries);
    if (overlayTriangles) { drawCalls++; triangles += overlayTriangles; }
    if (host.frameCapture && captureOpen) {
      host.frameCapture.encodeReadbacks(encoder, device, {
        "present-color": presentColor,
        "opaque-hdr": host.targets.hdrTexture,
        "linear-depth": host.targets.linearDepthTexture,
      });
    }
    timing?.resolve(encoder);
    passTiming?.resolve(encoder);
    const commands = encoder.finish();
    const encoded = host.performanceTelemetry.enabled ? performance.now() : 0;
    if (host.frameCapture && captureOpen) {
      const executedPassIds = executedPasses;
      host.frameCapture.recordPasses(host.captureActualPasses ?? [], executedPassIds, present?.sourceMapRefs);
      host.frameCapture.mark("submit", "queue.submit");
    }
    submitAttempted = true; device.queue.submit([...(preparation?.commandBuffers ?? []), commands]);
    // G1-S1：读回本帧选层槽位并派生下一帧命令；异常走槽位 sticky fallback，不打断渲染循环。
    if (clusterLod && clusterLodSupported) void clusterLod.ingest().catch(error => clusterLod.noteIngestFailure(error));
    // TAA 已在 submit 前读取响应掩码；队列有序保证提交后释放可安全回池复用。
    if (particleReactive) { host.transientTextures.release(particleReactive); particleReactive = undefined; }
    host.targets.commitFrame();
    if (host.frameCapture && captureOpen) host.lastFrameReadback = host.frameCapture.collectReadbacksAfterSubmit();
    host.postProcess.commitFrame(history.revision);
    const submitted = host.performanceTelemetry.enabled ? performance.now() : 0;
    if (host.frameCapture && captureOpen) {
      host.frameCapture.mark("submitted", "queue submitted");
      host.frameCapture.end();
      captureOpen = false;
    }
    host.packets.commitLodFrame();
    host.shadows.commit(); host.localShadows.commit();
    host.cameraHistory.commitFrame(history);
    host.previousAmbientOcclusion = postProcess.ambientOcclusion;
    if (hiZPlan) host.previousHiZ.commitFrame(hiZPlan, opaqueEffects.hiZ!);
    host.pendingHiZ = undefined;
    host.packets.commitFrame();
    timing?.read();
    passTiming?.read();
    host.shadowDirty = false; host.historyDirty = false;
    host.diagnostics.recordFrame(frameNumber, begin, encoded, submitted, present!.acquireMs);
    const metrics: FrameMetrics = { frame: ++host.frame, cpuSubmitMs: performance.now() - begin, drawCalls, triangles, ...lodWork.snapshot(),
      width: size.width, height: size.height, resources: host.session.resourceCount, shadowUpdated, transientTextures: host.targets.transientStats,
      deviceResourceMemory: host.session.resourceMemory,
      ...(host.msaaMetrics ? { msaa: host.msaaMetrics } : {}),
      ...(host.autoExposure ? { autoExposure: host.autoExposure.metrics() } : {}),
      ...(clusterLod ? { clusterLod: clusterLod.metrics() } : {}),
      cameraCut: history.cameraCut, postProcessPasses: opaqueEffects.passCount + finalEffects.passCount + (hasTransparent ? 2 + Number(host.transparency.currentReactiveMask !== undefined) : 0) + (upscaling ? 1 : 0) + (!directClear && host.outputs.spatialAaActive ? 1 : 0),
      weightedOit: hasTransparent,
      hiZMipLevels: opaqueEffects.hiZ?.mipLevelCount ?? 0,
      occlusionCulling: opaqueCulling.occlusionBatches > 0,
      frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches, lodSelectionBatches: lodStats.selectionBatches, lodIndirectDraws: lodStats.indirectDraws,
      lightCount: lighting?.lightCount ?? 0, lightClusters: lighting?.grid.clusterCount ?? 0,
      ...(capturePlan ? {
        // F1 常规帧图回执(非 timing):每帧记录 pass 序与本帧真实编码覆盖;逐 pass
        // 毫秒随读回异步完成,发布在 gpuPassTimings(带实测帧号)。本回执的 samples
        // 对缺测 pass 保持显式 unavailable(注明异步发布/未请求),不伪零。
        frameGraphReceipt: createPbrFrameReceipt(frameNumber, capturePlan.plan, [], begin,
          Math.max(performance.now(), begin + 0.001), executedPasses,
          (host.gpuTimer.passTimingEnabled ? "deferred-to-gpu-pass-timings" : "not-requested") satisfies PbrReceiptTimingAvailability),
        // F1 真实执行 coverage:登记 vs 编码差集读数(量,非时),与回执同源。
        frameExecutionCoverage: computePbrFrameExecutionCoverage(capturePlan.plan, executedPasses, frameNumber),
        // F1 可见绘制量读出:主 pass 包体 CPU 编码量 + 本帧剔除批计数。
        // GPU 逐实例幸存数需读回(=新同步),不提供,T01 visibleInstances 不伪测。
        visibleDraws: { drawCalls: stats.drawCalls, triangles: stats.triangles,
          frustumCulledBatches: opaqueCulling.frustumBatches, hiZOccludedBatches: opaqueCulling.occlusionBatches },
      } : {}),
      ...(host.gpuTimer.passTimingEnabled ? { gpuPassTimings: passTimingsMetrics(host, frameNumber) } : {}),
      ...(host.resolutionScale === 1 ? {} : { resolutionScale: resolutionScaleMetrics(host, surface) }),
      ...(upscaleMetrics ? { temporalUpscale: upscaleMetrics } : {}),
      ...(finalEffects.outline ? { outline: finalEffects.outline } : {}),
      ...host.shadows.metrics,
      ...(host.virtualShadows ? host.virtualShadows.metrics : {}),
      ...(virtualShadowMetrics ? { virtualShadow: virtualShadowMetrics } : {}),
      ...(virtualTexturesMetrics ? { virtualTextures: virtualTexturesMetrics } : {}),
      ...(host.contactShadows ? host.contactShadows.metrics : {}) };
    sampleAdaptiveQuality(host, metrics);
    if (!host.adaptiveQuality) return metrics;
    const hotspots = host.adaptiveQuality.hotspotSummary();
    return { ...metrics, adaptiveQuality: host.adaptiveQuality.state(),
      ...(hotspots.length ? { adaptiveHotspots: hotspots } : {}) };
    } catch (error) {
      if (captureOpen) host.frameCapture?.cancel();
      host.postProcess.cancelFrame(history.revision);
      host.transparency.cancelFrame();
      if (particleReactive) { host.transientTextures.release(particleReactive); particleReactive = undefined; }
      host.targets.failFrame();
      host.packets.cancelDeformationFrame();
      if (submitAttempted) host.packets.failLodFrame(); else host.packets.cancelLodFrame();
      host.lighting.invalidateAssignment(); host.localShadows.failFrame(); host.cameraHistory.cancelPendingFrame();
      if (!submitAttempted) host.clusterLodSlot?.cancelPendingFrame();
      if (hiZPlan) host.previousHiZ.failFrame(hiZPlan); host.pendingHiZ = undefined;
      throw error;
    }
  }
  /** F4 虚拟纹理逐帧推进:batch 级反馈代理 → 预算驻留 → tile-lookup 消费编码。
   *  fallback/atlas 未就绪时跳过消费编码,遥测仍逐帧回报(fail-closed,不静默)。 */
export function driveVirtualTextures(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }, encoder: GPUCommandEncoder):
    VirtualTextureFrameMetrics | undefined {
    const bridge = host.virtualTextures!;
    const metrics = bridge.observeFrame(collectVirtualTextureFeedback(host, frameState, size));
    const atlas = bridge.atlasTexture;
    if (atlas === undefined || bridge.fallbackActive) return metrics;
    const lookup = host.virtualTileLookup!;
    const sampled = lookup.encode(encoder, { atlasView: lookup.viewOf(atlas),
      atlasEdge: bridge.atlasEdgeTexels, catalog: bridge.textureCatalog(),
      layerOfPage: (textureId, tileX, tileY, mip) => bridge.layerOfPage(textureId, tileX, tileY, mip),
      packing: bridge.packPageTable(),
      samples: bridge.samples });
    return { ...metrics, sampling: { dispatches: sampled.dispatches, samples: sampled.samples,
      skipped: sampled.skipped } };
  }

  /** batch 级反馈条目:材质纹理槽 × UV 仿射包围域 × 球盘投影屏幕像素×实例数。
   *  静态代理口径(同 autoExposure 先例):不新增 GPU 往返;不做逐实例精确视锥剔除
   *  (背向/越远裁剪由 w≤0 与 NDC z 出界剔除),覆盖高估由反馈读取器 tile 聚合兜底。 */
function collectVirtualTextureFeedback(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }): VirtualTextureFeedbackEntry[] {    const inputs = host.packets.visibilityInputs();
    const entries: VirtualTextureFeedbackEntry[] = [];
    for (const batch of inputs.batches.values()) {
      const textures = batch.source.textures;
      if (!textures) continue;
      const geometry = inputs.geometries.get(batch.source.geometry);
      const screenPixels = geometry === undefined ? 0 : virtualTextureScreenPixels(geometry,
        frameState.depthViewProjection, frameState.projection.verticalFovRadians, size) * batch.source.count;
      if (!(screenPixels > 0)) continue;
      for (const slot of [textures.baseColor, textures.metallicRoughness, textures.normal,
        textures.occlusion, textures.emissive]) {
        if (!slot) continue;
        const bounds = virtualTextureUvBounds(slot.uvTransform);
        entries.push({ textureId: slot.texture, ...bounds, screenPixels });
      }
    }
    return entries;
  }

  /**
   * B1 Brief-VSM 物化输入:实例级世界点(从 batch.data 打包行提取,场景修订缓存)→
   * 环投影误差对象。几何局部包围对页物化无意义(整批共享同一 geometry,实例分布
   * 决定页分布);每帧 3 环投影一次,大批按 cap 采样控制 CPU 成本。
   * 动态输入取变形批保守包络(与剔除同源,零额外估算)。
   */
const virtualShadowObjectCache = new WeakMap<object, { revision: number;
    points: Float32Array<ArrayBuffer>; radii: Float32Array<ArrayBuffer> }>();
const VIRTUAL_SHADOW_INSTANCE_STRIDE = 36;
const VIRTUAL_SHADOW_MAX_SAMPLES_PER_BATCH = 4096;
function collectVirtualShadowObjects(host: PbrRendererFrameHost, frameState: ReturnType<typeof updatePbrFrameUniforms>,
    size: { readonly width: number; readonly height: number }): {
    readonly objects: VirtualShadowObjectInput[];
    readonly dynamic: VirtualShadowDynamicInput[];
  } {
    const inputs = host.packets.visibilityInputs();
    const revision = host.packets.visibilityRevision;
    let cache = virtualShadowObjectCache.get(inputs.batches);
    if (!cache || cache.revision !== revision) {
      const xs: number[] = [], radii: number[] = [];
      for (const batch of inputs.batches.values()) {
        if (batch.source.castShadow === false) continue;
        const geometry = inputs.geometries.get(batch.source.geometry);
        if (!geometry || !batch.source.data) continue;
        const data = batch.source.data, stride = VIRTUAL_SHADOW_INSTANCE_STRIDE;
        const count = Math.min(batch.source.count, VIRTUAL_SHADOW_MAX_SAMPLES_PER_BATCH);
        const step = Math.max(1, batch.source.count / count);
        for (let index = 0; index < batch.source.count; index += step) {
          const base = Math.floor(index) * stride;
          // 行主序仿射:world = row·p;平移 = 行 w 分量;尺度 ≈ 行 xyz 范数最大者。
          const tx = data[base + 3]!, ty = data[base + 7]!, tz = data[base + 11]!;
          const s0 = Math.hypot(data[base]!, data[base + 4]!, data[base + 8]!);
          const s1 = Math.hypot(data[base + 1]!, data[base + 5]!, data[base + 9]!);
          const s2 = Math.hypot(data[base + 2]!, data[base + 6]!, data[base + 10]!);
          xs.push(tx, ty, tz);
          radii.push(Math.max(s0, s1, s2) * geometry.radius);
        }
      }
      cache = { revision, points: Float32Array.from(xs), radii: Float32Array.from(radii) };
      virtualShadowObjectCache.set(inputs.batches, cache);
    }
    const viewProjection = frameState.depthViewProjection;
    const tanHalfFov = Math.tan(frameState.projection.verticalFovRadians / 2);
    const focal = size.height / (2 * tanHalfFov);
    const objects: VirtualShadowObjectInput[] = [];
    for (let index = 0; index < cache.points.length / 3; index++) {
      const x = cache.points[index * 3]!, y = cache.points[index * 3 + 1]!, z = cache.points[index * 3 + 2]!;
      const w = viewProjection[3]! * x + viewProjection[7]! * y + viewProjection[11]! * z + viewProjection[15]!;
      if (!(w > 0)) continue;
      const clipZ = viewProjection[2]! * x + viewProjection[6]! * y + viewProjection[10]! * z + viewProjection[14]!;
      if (clipZ < 0 || clipZ > w) continue;
      const radius = cache.radii[index]!;
      const radiusPx = radius * focal / w;
      objects.push({ x, y, z, radius,
        screenPixels: Math.PI * radiusPx * radiusPx,
        desiredWorldTexel: 2 * w * tanHalfFov / size.height });
    }
    const dynamic: VirtualShadowDynamicInput[] = [];
    for (const envelope of host.packets.dynamicBoundsEnvelope().values()) {
      dynamic.push({ x: envelope.center[0]!, y: envelope.center[1]!, z: envelope.center[2]!,
        radius: envelope.radius });
    }
    return { objects, dynamic };
  }

function resolutionScaleMetrics(host: PbrRendererFrameHost, surface: { readonly width: number; readonly height: number }): FrameMetrics["resolutionScale"] | undefined {
    if (host.resolutionScaler === undefined || host.resolutionScale === 1) return undefined;
    // 质量槽位保持 measured=false：真实画质数字须来自 GPU 序列联测，不许发明。
    // surface 传画布尺寸:超分激活时 internalWidth/Height 就是真实渲染分辨率。
    return { revision: host.resolutionScaleRevision,
      ...internalResolutionReport(host.resolutionScale, surface.width, surface.height) };
  }

  /** F1:最新完成读回的逐 pass 计时;尚无读回时显式 unavailable,不伪零。 */
function passTimingsMetrics(host: PbrRendererFrameHost, frameNumber: number): PbrFramePassTimings {
    const latest = host.diagnostics.latestPassTimings;
    if (latest) return latest;
    const reason = !host.gpuTimer.enabled ? "诊断采样未启用,逐 pass GPU 计时未采集"
      : !host.gpuTimer.supported ? "设备不支持 timestamp-query,逐 pass GPU 计时不可用"
        : "等待首个逐 pass GPU 时间戳读回";
    return pbrFramePassTimingsUnavailable(frameNumber, reason);
  }

function sampleAdaptiveQuality(host: PbrRendererFrameHost, metrics: FrameMetrics): void {
    if (!host.adaptiveQuality) return;
    const snapshot = host.performanceTelemetry.snapshot();
    const cpu = snapshot.stages["frame-encode"], gpu = snapshot.stages["gpu-frame"];
    if (!cpu) return;
    const samples = host.performanceTelemetry.samples("frame-encode");
    host.adaptiveQuality.sample({ frame: metrics.frame, sampleCount: cpu.samples, cpuP95Ms: cpu.p95Ms, cpuP99Ms: cpu.p99Ms,
      ...(gpu ? { gpuP95Ms: gpu.p95Ms, gpuP99Ms: gpu.p99Ms } : {}),
      longFrameCount: samples.filter(value => value > 33.34).length,
      width: metrics.width, height: metrics.height, drawCalls: metrics.drawCalls, triangles: metrics.triangles,
      memory: metrics.deviceResourceMemory ?? host.session.resourceMemory });
  }
function captureForFrame(host: PbrRendererFrameHost, size: { readonly width: number; readonly height: number }, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean, depthResolved: boolean): {
    readonly plan: ReturnType<typeof buildPbrFrameExecutionPlan>;
    readonly actual: ReturnType<typeof collectActualPbrFramePasses>;
  } {
    // AA-M1:MSAA 通路状态进计划键 —— 回执/对拍声明随主 pass 附件形态切换。
    const msaaMainPass = host.targets.msaaActive && !directDisplay;
    const key = `${size.width}x${size.height}:${transparency ? "transparent" : "opaque"}`
      + `:ao=${postProcess.ambientOcclusion ? 1 : 0}:ssr=${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:fog=${postProcess.volumetricFog ? 1 : 0}:god=${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:bloom=${postProcess.bloom ? 1 : 0}:direct=${directDisplay ? 1 : 0}`
      + `:msaa=${msaaMainPass ? host.mainSampleCount : 1}`
      + `:cs=${host.features.contactShadows ? 1 : 0}:up=${host.features.temporalUpscale ? 1 : 0}:hdr=${host.session.hdrCanvasActive ? 1 : 0}`;
    if (host.capturePlanKey !== key || !host.capturePlan || !host.captureActualPasses) {
      const captureFeatures: PbrRendererFeatures = Object.freeze({ ...host.features,
        ambientOcclusion: postProcess.ambientOcclusion,
        screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog,
        bloom: postProcess.bloom,
        spatialAa: host.outputs.spatialAaActive,
      });
      const opaqueColorResource = postProcess.ambientOcclusion ? "ao-hdr" : "opaque-hdr";
      const plan = buildPbrFrameExecutionPlan(size, { transparency, features: captureFeatures,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        directDisplay, writeGeometryBuffers: host.writeGeometryBuffers, hdrDisplay: host.session.hdrCanvasActive });
      const presentInputResource = host.features.temporalUpscale && !directDisplay ? "upscale-hdr"
        : host.features.contactShadows ? "contact-hdr"
        : postProcess.bloom ? "bloom-hdr"
        : host.features.temporalAa ? "temporal-hdr" : postProcess.screenSpaceReflection ? "ssr-hdr"
          : postProcess.volumetricFog ? "volumetric-fog-hdr"
          : transparency ? "composited-hdr" : opaqueColorResource;
      const actual = collectActualPbrFramePasses(captureFeatures, transparency,
        { opaqueColorResource, presentInputResource, directDisplay, writeGeometryBuffers: host.writeGeometryBuffers,
          godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
          bloom: postProcess.bloom, hdrDisplay: host.session.hdrCanvasActive,
          msaa: msaaMainPass, depthResolved: msaaMainPass && depthResolved });
      assertPlanMatchesActual(plan, actual);
      host.capturePlan = plan;
      host.captureActualPasses = actual;
      host.capturePlanKey = key;
    }
    return { plan: host.capturePlan, actual: host.captureActualPasses };
  }
function allocationPlanFor(host: PbrRendererFrameHost, transparency: boolean,
    postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>, directDisplay: boolean): RenderGraphCompileResult {
    const key = `${transparency ? 1 : 0}:${postProcess.ambientOcclusion ? 1 : 0}:${postProcess.screenSpaceReflection ? 1 : 0}`
      + `:${postProcess.volumetricFog ? 1 : 0}:${postProcess.volumetricFogProfile.godRaysStrength !== undefined ? 1 : 0}:${postProcess.bloom ? 1 : 0}:${directDisplay ? 1 : 0}`;
    if (host.allocationPlanKey !== key || !host.allocationPlan) {
      host.allocationPlan = compilePbrFrameGraph({ transparency, features: { ...host.features,
        ambientOcclusion: postProcess.ambientOcclusion, screenSpaceReflection: postProcess.screenSpaceReflection,
        volumetricFog: postProcess.volumetricFog, bloom: postProcess.bloom }, directDisplay,
        godRays: postProcess.volumetricFogProfile.godRaysStrength !== undefined,
        writeGeometryBuffers: host.writeGeometryBuffers });
      if (!host.allocationPlan.valid) throw new Error("PBR transient allocation graph is invalid.");
      host.allocationPlanKey = key;
    }
    return host.allocationPlan;
  }
function executedCapturePassIds(host: PbrRendererFrameHost, directClear: boolean, postProcess: ReturnType<typeof resolvePbrPostProcessOverrides>,
    transparency: boolean, upscaling: boolean): ReadonlySet<string> {
    const ids = new Set<string>(["opaque"]);
    if (directClear) return ids;
    if (postProcess.ambientOcclusion) { ids.add("ambient-occlusion"); ids.add("apply-ambient-occlusion"); }
    if (postProcess.screenSpaceReflection) { ids.add("screen-space-reflection-trace"); ids.add("screen-space-reflection-composite"); }
    if (transparency) { ids.add("transparent-oit"); ids.add("composite-oit"); }
    if (postProcess.volumetricFog) { ids.add("volumetric-fog-march"); ids.add("volumetric-fog-composite"); }
    if (host.features.temporalAa) ids.add("temporal-aa");
    // F4:超分编码门 = 特性位 && 实际降档(encodeUpscale 调用点的同一 upscaling 谓词,
    // 单一真值来源)。执行集若只看特性位,coverage/回执会在"特性开但 scale=1"帧
    // 谎报 temporal-upscale 已执行;此时它如实落入 notExecutedMappedPassIds(合法跳过显式可见)。
    if (host.features.temporalUpscale && upscaling) ids.add("temporal-upscale");
    if (postProcess.bloom) ids.add("bloom");
    ids.add("present");
    return ids;
  }
/** 原类公共方法:帧校验即真实 render 一帧并断言零校验错误。 */
export async function validateFrame(host: PbrRendererFrameHost, view: RenderView): Promise<FrameMetrics> {
  host.deviceEpoch?.assertCurrent(host.session.device);
  return validatePbrFrame(host.session, () => host.render(view), () => {
    host.previousHiZ.invalidate(); host.shadows.invalidate(); host.localShadows.invalidate();
    host.virtualShadows?.invalidate();
    host.shadowDirty = true; host.historyDirty = true;
  });
}
