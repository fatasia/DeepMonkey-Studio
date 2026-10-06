//! PbrRendererFrameHost:帧编排(pbrRendererFrames)所需的宿主结构视图
//! (体量门拆分;接口逐字未改,消费方经 pbrRendererFrames re-export 保持原路径)。
import type { DeviceSession } from "./deviceSession.js";
import type { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";
import type { Pipelines } from "./pipelines.js";
import { buildPbrFrameExecutionPlan, collectActualPbrFramePasses } from "./pbrFramePlanExecutor.js";
import type { RenderTargets } from "./renderTargets.js";
import type { PacketBuffers } from "./packetBuffers.js";
import type { CameraFrameHistory } from "./cameraFrameHistory.js";
import type { PbrPostProcessChain } from "./pbrPostProcessChain.js";
import type { PbrTransparencyPass } from "./pbrTransparencyPass.js";
import type { ForwardPlusPbrRuntime } from "../lighting/forwardPlusPbrRuntime.js";
import type { PreviousHiZVisibility, PreviousHiZFramePlan } from "./previousHiZVisibility.js";
import type { PbrShadowState } from "./pbrShadowState.js";
import type { ContactShadowResources } from "../shadows/contactShadowResources.js";
import type { SdfGiProductionRuntime } from "../gi/sdfGiProductionRuntime.js";
import type { MegaLightsFrameController } from "../lighting/megaLightsFrameController.js";
import type { FrameMetrics, RenderView } from "./pbrRendererTypes.js";
import type { PbrRendererFeatures } from "./pbrRendererFeatures.js";
import type { PbrEnvironmentState } from "./pbrEnvironmentState.js";
import type { EnvironmentAmbientReader, EnvironmentAmbient } from "./environmentAmbientReader.js";
import type { PbrMainBindings } from "./pbrMainBindings.js";
import type { PbrOutputBindings } from "./pbrOutputBindings.js";
import type { PbrRendererDiagnostics } from "./pbrRendererDiagnostics.js";
import type { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import type { PbrGroundResources } from "./pbrGroundPass.js";
import type { PbrTransientTexturePool } from "./pbrTransientTexturePool.js";
import type { PbrDepthResolvePass } from "./pbrDepthResolve.js";
import type { DynamicResolutionScaler } from "../postprocess/resolutionScaler.js";
import type { PbrFrameReadbackResult } from "./pbrFrameCaptureReadback.js";
import type { RenderGraphCompileResult } from "../renderGraph.js";
import type { AdaptiveQualityController } from "./adaptiveQuality.js";
import type { ProbeSceneRadianceProducer } from "../rayTracing/probeSceneRadianceProducer.js";
import type { PbrParticlePass } from "./pbrParticlePass.js";
import type { GaussianSplatSceneOwner } from "./gaussianSplatSceneOwner.js";
import type { GpuParticleRuntime } from "./gpuParticleRuntime.js";
import type { ClusterLodRenderSlot } from "./clusterLodRenderSlot.js";
import type { VirtualTextureFrameBridge } from "./virtualTextureFrameBridge.js";
import type { VirtualTextureTileLookupPass } from "./virtualTextureSampling.js";
import type { VisibilityBufferPath } from "./visibilityBufferPass.js";
import type { StudioEnvironment } from "./studioEnvironment.js";
import type { PbrAutoExposureRuntime } from "./pbrAutoExposure.js";
import type { PbrFrameCapture } from "./pbrFrameCapture.js";

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
  /** B3 RT 阴影自动选路状态(与 rtShadows 同生命周期;undefined = 未接选路)。 */
  readonly rtShadowScheduling: import("./rtShadowScheduling.js").RtShadowSchedulingState | undefined;
  /** M2 供给收口(2026-10-06):已接入 shadowState 的 mask 视图 epoch(与 PbrRenderer 同名字段)。 */
  rtShadowMaskEpoch: number;
  /**
   * B2 MegaLights M2 万灯 RIS 生产 dispatch(opt-in features.megaLights):帧编排内
   * 懒构造(PbrRenderer 构造器零改动),默认 undefined = 既有帧逐位零变化;路径
   * 决策 ≤64 本地灯走既有簇光快路径,零 dispatch。
   */
  megaLights: MegaLightsFrameController | undefined;
  /**
   * B3 RT 反射 closest-hit 帧通道(opt-in features.rayTracedReflections):帧编排内
   * 懒构造(场景复用 rtShadows.packedScene——独立场景供给通道属下一切片);默认
   * undefined = 既有帧逐位零变化。当前切片为开关+管线挂载+帧计时披露,命中记录的
   * 生产消费(SSR 屏外合成)未接线,如实登记。
   */
  rtReflections: import("../rayTracing/rayTraceClosestFramePass.js").RayTraceClosestFramePass | undefined;
  /**
   * P1 RT specular GI·一次反弹 indirection(帧编排内懒构造,与 rtReflections 同生命周期
   * 门:features.rayTracedReflections × SSR 激活 × 环境可用;构造/编码失败 fail-closed
   * 置回 undefined 并如实披露,填充不发生 = 画面零变化)。消费 RT 阴影同族 staging 的
   * closest-hit 命中记录,写 rgba16float indirection 供 SSR 合成后屏外填充。
   */
  rtSpecularIndirection: import("../rayTracing/rtSpecularFramePasses.js").RtSpecularIndirectionPass | undefined;
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
