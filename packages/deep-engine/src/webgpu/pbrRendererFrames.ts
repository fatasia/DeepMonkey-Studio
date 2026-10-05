//! PBR 帧编排(原 PbrRenderer.renderPreparedFrame 私有方法域,整体迁出守住 800 行体量门)。
//! host 为类型层结构视图(运行时即 PbrRenderer 实例本体);成员语义与原类内一致,函数体逐字未改。
import { DeviceSession } from "./deviceSession.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";
import { uploadBuffer } from "./meshBuffers.js";
import { authoredShadowPipelines, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { openPbrRenderer } from "./pbrRendererBootstrap.js";
import { snapshotPipelineCompileRecords } from "./pipelineCompileSnapshot.js";
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
import type { SdfGiProductionRuntime } from "../gi/sdfGiProductionRuntime.js";
import { hasClusteredLights, resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";
import { MegaLightsFrameController, megaLightsFramePlanned } from "../lighting/megaLightsFrameController.js";
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
import { DynamicResolutionScaler,
  DEFAULT_RESOLUTION_SCALE_POLICY, type ResolutionScalePolicy } from "../postprocess/resolutionScaler.js";
import { internalRenderSize, temporalUpscaleActive } from "../postprocess/temporalUpscaleCpu.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses,
  createPbrFrameReceipt } from "./pbrFramePlanExecutor.js";
import type { PbrReceiptTimingAvailability } from "./pbrFrameReceipt.js";
import { computePbrFrameExecutionCoverage } from "./pbrFrameExecutionCoverage.js";
import { PbrFrameCapture } from "./pbrFrameCapture.js";
import type { PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";
import type { FrameCaptureSession } from "../r12/frameCapture.js";
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
import { createVirtualTextureFrameBridge, type VirtualTextureFrameBridge } from "./virtualTextureFrameBridge.js";
import { VirtualTextureTileLookupPass } from "./virtualTextureSampling.js";

import { driveVirtualTextures, validateFrame, collectVirtualShadowObjects, resolutionScaleMetrics,
  passTimingsMetrics, sampleAdaptiveQuality, captureForFrame, allocationPlanFor, executedCapturePassIds } from "./pbrRendererFrameSupport.js";
export { driveVirtualTextures, validateFrame } from "./pbrRendererFrameSupport.js";

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
  /** Brief-GI M2 生产 SDF GI dispatch;opt-in(features.sdfGi),默认不存在。 */
  readonly sdfGi: SdfGiProductionRuntime | undefined;
  /** M2 方向光 RT 阴影(opt-in features.rayTracedShadows):帧内 mask dispatch 钩子。 */
  readonly rtShadows: import("./rtShadowFrame.js").RtShadowFrameController | undefined;
  /**
   * B2 MegaLights M2 万灯 RIS 生产 dispatch(opt-in features.megaLights):帧编排内
   * 懒构造(PbrRenderer 构造器零改动),默认 undefined = 既有帧逐位零变化;路径
   * 决策 ≤64 本地灯走既有簇光快路径,零 dispatch。
   */
  megaLights: MegaLightsFrameController | undefined;
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
  /** A2C-P1 运行时 a2c 有效性探针(一次性;MSAA4 渲染器才持有,1x 恒 undefined)。 */
  readonly a2cProbe: import("./a2cFrameProbe.js").A2cFrameProbe | undefined;
  /** a2c 设备级自证探针(a2cDeviceProbe,场景无关判定):host 供 GPUDevice 时
   * 一次性前置判定;与场景探针互补——设备探针拦驱动层缺陷,场景探针拦使用侧。 */
  readonly a2cDeviceProbe: ((device: GPUDevice) => Promise<import("./a2cDeviceProbe.js").A2cDeviceProbeVerdict>) | undefined;
  /** a2c 设备探针 verdict 回调(桥作降级决策;渲染器只转发)。 */
  readonly onA2cDeviceProbeVerdict?: (frame: number, verdict: import("./a2cDeviceProbe.js").A2cDeviceProbeVerdict) => void;
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
  /** 宿主时钟注入(37c98eab 先例:runtime 模块不触全局 performance,时钟由宿主下发)。 */
  now(): number;
}

/** 原类私有帧编排(体逐字未改;this → host)。 */

/** a2c 设备探针每帧只跑一次的帧号去重(模块级;进程生命周期语义)。 */
const a2cDeviceProbeSettled = new Set<number>();

export function renderPreparedFrame(host: PbrRendererFrameHost, view: RenderView): FrameMetrics | undefined {
    const begin = host.now();
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
      // M3 消费接线:sdfGi 开启时探针 clipmap 由 SDF GI 发布(同步、每帧),F1 clipmap
      // 停驱 —— 消除异步发布对同步发布的覆盖竞争;关闭时 F1 行为逐位不变。
      if (!host.sdfGi) host.driveProbeClipmap(frameNumber, size, view.eye, history.cameraCut);
      // AA-M1 深度消费判定(主 pass 编码与计划对拍共用;必须在 captureForFrame 前得出):
      // 主 pass 之后读取/加载硬件深度的全部消费方 —— Hi-Z(采样 depthTexture)、
      // 透明 OIT(load 测试)、粒子/样条/作者网格(附件 load)、可见性合成、对象描边
      // (read-only 附件)、display 空间背景(equal 比较附件)。无消费方时 MSAA 深度
      // 直接 depthStoreOp:"discard";有消费方时 store + 主 pass 后深度 resolve pass。
      const particleBinding = host.particleRuntime?.current?.binding;
      const splatCount = host.splats?.current?.splatCount ?? 0;
      // B2 MegaLights M2 帧早段路径决策(与 encodeFrame 内部决策同一纯函数单源):
      // 仅 RIS 路径帧把 MSAA 深度纳入消费集(store+resolve);≤64 灯帧保持既有
      // discard 行为,逐位零变化。
      const megaLightsPlanned = megaLightsFramePlanned(host.features.megaLights && !directClear,
        sceneLighting.clustered);
      const depthConsumedAfterPass = !directClear && (host.features.occlusionCulling || drawProfile.hasTransparent || outlined
        || (host.particlePass !== undefined && particleBinding !== undefined) || splatCount > 0
        || view.authorGrid !== undefined || host.visibility !== undefined
        || view.panoramaBackground?.toneMapped === false || megaLightsPlanned);
      // The same cached plan powers explicit captures, the lightweight live
      // Frame Graph receipt, and the execution coverage readout. The plan is
      // key-cached (string compare per frame); only a feature/size change pays
      // plan construction. F1: receipts are now regular — every frame carries
      // pass order / executed set, while per-pass GPU timings stay on the
      // async gpuPassTimings channel.
      const capturePlan = captureForFrame(host, size, drawProfile.hasTransparent, postProcess, directClear !== undefined, depthConsumedAfterPass);
      if (host.frameCapture && capturePlan) {
        // begin() 返回 false = 会话被宿主门禁拒绝(如切换后关闭诊断):本帧
        // 跳过全部捕获侧 encode/readback/collect 工作,保持渲染循环原速。
        captureOpen = host.frameCapture.begin(`frame-${frameNumber}`, capturePlan.plan) !== false;
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
    // M2 方向光 RT 阴影(opt-in):mask dispatch 先于直接光绘制(同一 encoder)。
    // 深度为上一已提交帧的主帧 depth(mask 恒一帧延迟,与 TAA 抖动序列同构);
    // 钩子返回 undefined(pass 未就绪/降级/分辨率失配)时开关位已为 0,级联生效。
    if (host.rtShadows) {
      host.rtShadows.ensureSurface(size.width, size.height);
      void host.rtShadows.encodeFrame({ encoder, width: size.width, height: size.height,
        depthTexture: host.targets.depthTexture,
        viewProjection: frameState.depthViewProjection,
        lightDirection: sceneLighting.primary.rayDirectionWorld, extent: view.extent });
    }
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
    // Brief-GI M2/M3 生产 SDF GI dispatch(opt-in,默认关 = 运行时不存在,帧逐位零变化):
    // 场景 dirty(revision 变化)帧 GPU 距离场烘焙(失败回退 CPU 增量)+ 天光圆锥追踪
    // (静态层,烘焙一次);每帧按 ddgiUpdateBudget 同族预算分摊探针 SH 更新滑动窗口
    // (动态层)后物化探针场为 clipmap 采样纹理(M3 消费接线,同 encoder 写后读),
    // 并同步发布 group3 GI 绑定 —— 主 pass ambient 项自此真实消费探针记录。
    // 天空辐射 = 环境均值 × environmentIntensity(与 F1 ambient 合同同源,miss 方向
    // 同一口径);pass 为主 encoder 上的 compute,不依赖 HDR 链拓扑。
    if (host.sdfGi) {
      host.sdfGi.syncScene(host.packets.visibilityInputs());
      const sdfGiPlan = host.sdfGi.encodeFrame(encoder, {
        sceneRevision: host.packets.visibilityRevision,
        skyRadianceRgb: scalePbrEnvironmentRadiance(host.environmentAmbient, view.environmentIntensity),
        budgetProbes: host.adaptiveQuality?.state().knobs.ddgiUpdateBudget ?? 64,
      }, passTiming ?? undefined);
      host.lighting.setProbeClipmap(sdfGiPlan.published ? host.sdfGi.publishBinding : undefined);
    }
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
    // B2 Brief-MegaLights M2 生产 dispatch(opt-in features.megaLights,默认关 = 控制
    // 器不存在、帧逐位零变化):首帧懒构造于本编排(PbrRenderer 构造器零改动;构造
    // 失败 fail-closed 抛错,同 sdfGi 构造期语义)。路径决策单源 resolveDirectLightingPath:
    // ≤64 本地灯返回零命令(既有簇光快路径),超预算/强制才落 表面重建 + RIS 两趟 +
    // 加性合成进 HDR(depth 已就绪,后处理统一消费合成后结果)。IES 引用无表供给或
    // 灯数超 MAX_MEGA_LIGHTS(65535)即抛(fail-closed,不静默错光)。
    if (megaLightsPlanned) {
      host.megaLights ??= new MegaLightsFrameController(host.session);
      host.megaLights.encodeFrame({ encoder, width: size.width, height: size.height,
        colorView: host.targets.hdr,
        depthTexture: host.targets.depthTexture,
        depthViewProjection: frameState.depthViewProjection,
        worldToView: frameState.worldToView,
        lights: transformWorldLightsToView(sceneLighting.clustered, frameState.worldToView) });
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
    // A2C-P1 运行时有效性探针(一次性):首个含 a2c 批次的 MSAA 主 pass 帧后,把主 pass
    // target0 的 MSAA resolve(opaque-hdr,COPY_SRC 为既有 usage)读回,按 handoff 判据
    // (alpha 非 opaque 存在 && edgePixels ≤ 8·W ⇒ 无效)结算。直出 display 帧无 MSAA
    // 主通路(a2c 批次物理回退普通管线),不探测。渲染器只披露不决策。
    // a2c 设备级前置探针(一次性,场景无关):host 供自证函数且尚未出 verdict 时,
    // 用独立 64² 色图判定驱动层掩码是否生成——ineffective 时后续帧由宿主侧降级
    // (maskFallback),场景探针不再触发(有效/不确定则场景探针照常)。
    if (host.a2cDeviceProbe && !a2cDeviceProbeSettled.has(frameNumber)) {
      a2cDeviceProbeSettled.add(frameNumber);
      void host.a2cDeviceProbe(device).then(verdict => {
        host.onA2cDeviceProbeVerdict?.(frameNumber, verdict);
      }).catch(() => { /* fail-open:判定失败不影响渲染循环 */ });
    }
    const a2cProbePending = host.a2cProbe?.wantsProbe(drawProfile.hasAlphaToCoverage) === true && !directClear;
    if (a2cProbePending) host.a2cProbe!.beginFrame(frameNumber, device, encoder, host.targets.hdrTexture);
    timing?.resolve(encoder);
    passTiming?.resolve(encoder);
    const commands = encoder.finish();
    const encoded = host.performanceTelemetry.enabled ? host.now() : 0;
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
    // A2C-P1 探针:submit 已落队,读回异步结算后冻结判定(下一帧起经 FrameMetrics 披露)。
    if (a2cProbePending) host.a2cProbe!.collectAfterSubmit();
    host.postProcess.commitFrame(history.revision);
    const submitted = host.performanceTelemetry.enabled ? host.now() : 0;
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
    const a2cProbeMetrics = host.a2cProbe?.metrics();
    const metrics: FrameMetrics = { frame: ++host.frame, cpuSubmitMs: host.now() - begin, drawCalls, triangles, ...lodWork.snapshot(),
      width: size.width, height: size.height, resources: host.session.resourceCount, shadowUpdated, transientTextures: host.targets.transientStats,
      deviceResourceMemory: host.session.resourceMemory,
      ...(host.msaaMetrics ? { msaa: host.msaaMetrics } : {}),
      ...(a2cProbeMetrics ? { a2cProbe: a2cProbeMetrics } : {}),
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
          Math.max(host.now(), begin + 0.001), executedPasses,
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
      ...(host.contactShadows ? host.contactShadows.metrics : {}),
      ...(host.sdfGi ? host.sdfGi.metrics : {}),
      ...(host.megaLights ? { megaLights: host.megaLights.metrics } : {}) };
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
      host.a2cProbe?.cancelFrame();
      host.packets.cancelDeformationFrame();
      if (submitAttempted) host.packets.failLodFrame(); else host.packets.cancelLodFrame();
      host.lighting.invalidateAssignment(); host.localShadows.failFrame(); host.cameraHistory.cancelPendingFrame();
      if (!submitAttempted) host.clusterLodSlot?.cancelPendingFrame();
      if (hiZPlan) host.previousHiZ.failFrame(hiZPlan); host.pendingHiZ = undefined;
      throw error;
    }
  }
