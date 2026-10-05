import * as THREE from "three";
import type { DeepWebGpuBackend, ThreeProjectionBridge } from "@bim-studio/deep-engine/three-bridge";
import type { AuthoredQualityProfile } from "@bim-studio/deep-engine/webgpu";
import type { FrameCaptureSession, RenderPacket } from "@bim-studio/deep-engine";
import { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import { StudioDeepShadowSession } from "./StudioDeepShadowSession";
import { StudioDeepPerformance } from "./StudioDeepPerformance";
import { StudioDeformationPoseSync } from "./studioDeformationPoseSync";
import { StudioDeepOutlineSync } from "./studioDeepOutlineSync";
import { StudioDeepQualityTelemetrySampler, publishStudioQualityTelemetry } from "./StudioDeepQualityTelemetry";
import { publishStudioFrameCaptureSession, releaseStudioFrameCaptureSession } from "./studioFrameCaptureDiagnostics";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";
import type { PreparedStudioDeepEnvironment } from "./studioDeepEnvironmentSource";
import type { StudioDeepRenderView } from "./StudioDeepRenderView";
import type { TemporalFrameSettler } from "./temporalFrameSettler";
import type { ViewerEngine } from "./ViewerEngine";
import type { RendererBackend } from "./viewerTypes";
import { DeepCameraController, type CameraPose } from "./deepCameraController";
import { DeepCameraInputSession } from "./deepCameraInputSession";
import type { DeepGizmoInteraction } from "./deepGizmoInteraction";
import { flowProbe, recordProbeSample } from "./studioDeepWebGpuBridgeFlowProbe";
import { authorModelId, cameraSnapshot,
  type DeepRenderView, type RuntimeSession } from "./studioDeepWebGpuBridgeSceneHelpers";
import { markSwitchPhase } from "./studioDeepWebGpuBridgeFeatureToggles";
import type { StudioDeepWebGpuBridgeOptions } from "./studioDeepWebGpuBridgeOptions";

/**
 * StudioDeepWebGpuBridge 呈现域的内部状态视图。仅类型层映射(调用点以
 * `this as unknown as StudioDeepBridgePresentationHost` 传入桥实例),运行时
 * 零包装、字段读写语义与桥内完全一致;发布/释放/拾取/手势的实现整体迁入本模块。
 */
export interface StudioDeepBridgePresentationHost {
  readonly viewer: ViewerEngine;
  readonly options: StudioDeepWebGpuBridgeOptions;
  readonly authorCanvas: HTMLCanvasElement;
  readonly viewReader: StudioDeepRenderView;
  readonly temporalSettler: TemporalFrameSettler;
  readonly gizmoInteraction: DeepGizmoInteraction;
  readonly applyGesturePose: () => void;
  readonly renderDeepFrame: (authorMatricesCurrent?: boolean) => void;
  readonly renderPresentationFrame: () => void;
  readonly failRuntime: (reason: unknown) => void;
  readonly replaceRecoveredBackend: (backend: DeepWebGpuBackend) => void;
  readonly probeClipmapEnabled: () => boolean;
  readonly cancelCameraSettle: () => void;
  deepCanvas: HTMLCanvasElement | undefined;
  deepBackend: DeepWebGpuBackend | undefined;
  activeBackendValue: RendererBackend;
  generation: number;
  independentPacketPath: boolean;
  pendingDeformationPacket: RenderPacket | undefined;
  deformationSync: StudioDeformationPoseSync | undefined;
  outlineSync: StudioDeepOutlineSync | undefined;
  frameCaptureSession: FrameCaptureSession | undefined;
  performanceSource: StudioDeepPerformance | undefined;
  quality: StudioDeepQualityTelemetrySampler | undefined;
  qualityProfile: AuthoredQualityProfile | null;
  environmentSession: StudioDeepEnvironmentSession | undefined;
  shadowSession: StudioDeepShadowSession | undefined;
  failureReported: boolean;
  lastCameraSnapshot: readonly number[] | undefined;
  unsubscribeFrame: (() => void) | undefined;
  projectionBridge: ThreeProjectionBridge | undefined;
  syncPending: DeepWebGpuBackend | undefined;
  syncAgain: DeepWebGpuBackend | undefined;
  cameraFramesInFlight: number;
  pendingCameraView: DeepRenderView | undefined;
  cameraFramesSubmitted: number;
  cameraFramesCoalesced: number;
  cameraMaxInFlight: number;
  settledViewKey: string;
  lastDemandRevision: number;
  gestureActive: boolean;
  lastGestureTickAt: number | undefined;
  /** 控制器最后写回/采纳的姿态:区分"手势收敛中"与"宿主程序性变更"(与 WASM 桥同族)。 */
  lastAppliedPose: CameraPose | undefined;
  controller: DeepCameraController | undefined;
  inputSession: DeepCameraInputSession | undefined;
}
export function publishDeepPresentation(host: StudioDeepBridgePresentationHost, canvas: HTMLCanvasElement,
  backend: DeepWebGpuBackend, environment: PreparedStudioDeepEnvironment,
  shadowMapSize: number, frameCaptureSession: FrameCaptureSession | undefined): void {
    backend.setProbeClipmapEnabled(host.probeClipmapEnabled());
    const environmentSession = new StudioDeepEnvironmentSession({ scene: host.viewer.scene, initial: environment,
      readView: () => readStudioDeepEnvironmentView(host.viewer.scene, host.viewer.usesAuthorPostProcessing()),
      stage: (source, signal) => backend.stageEnvironment(source, signal),
      onReady: host.renderDeepFrame, onFailure: error => host.failRuntime(error) });
    // Publishing is the atomic handoff boundary. If retiring the previous
    // backend reports a cleanup error, the candidate must be retired too;
    // otherwise a failed switch leaks a live GPU device and canvas.
    try {
      releaseDeepPresentation(host);
    } catch (error) {
      try { backend.dispose(); } finally { canvas.remove(); }
      throw error;
    }
    canvas.style.visibility = "visible";
    canvas.style.opacity = "1";
    host.authorCanvas.style.opacity = "0";
    host.deepCanvas = canvas;
    host.deepBackend = backend;
    host.independentPacketPath = backend.usesIndependentPacket;
    host.deformationSync = host.independentPacketPath && host.pendingDeformationPacket
      ? StudioDeformationPoseSync.create(host.pendingDeformationPacket, host.viewer) : undefined;
    host.pendingDeformationPacket = undefined;
    if (host.deformationSync) {
      const { bound, unmatched } = host.deformationSync.diagnostics;
      markSwitchPhase(`deep-webgpu:deformation-sync-bound-${bound}-unmatched-${unmatched.length}`);
      for (const entry of unmatched) console.warn(`[Deep] 变形模型 ${entry.modelId} 未与 Three 对象配对，保持绑定姿态：${entry.reason}`);
    }
    host.outlineSync = host.independentPacketPath ? new StudioDeepOutlineSync() : undefined;
    host.viewer.setAuthorPacketIndependent(host.independentPacketPath);
    host.frameCaptureSession = frameCaptureSession;
    publishStudioFrameCaptureSession(frameCaptureSession);
    host.performanceSource = new StudioDeepPerformance(backend.runtime as ConstructorParameters<typeof StudioDeepPerformance>[0]);
    host.performanceSource.setDiagnosticsSource(() => {
      const diagnostics = backend.diagnostics;
      return diagnostics?.probeClipmap ? { probeClipmap: diagnostics.probeClipmap } : undefined;
    });
    host.viewer.setPresentationPerformanceSource(host.performanceSource);
    // T25:每个 Deep 会话一个采样器;先发布"等待采样"状态,面板立即可见会话存在。
    host.quality = new StudioDeepQualityTelemetrySampler(host.options.qualityTelemetry,
      host.qualityProfile, () => backend.chunkStreaming?.residentGpuBytes);
    publishStudioQualityTelemetry(host.quality.status());
    host.environmentSession = environmentSession;
    host.shadowSession = new StudioDeepShadowSession({ initialMapSize: shadowMapSize,
      stage: (mapSize, signal) => backend.stageShadowMapSize(mapSize, signal),
      onReady: host.renderDeepFrame, onFailure: error => host.failRuntime(error) });
    host.activeBackendValue = "webgpu";
    host.viewer.setPresentationRendererBackend("webgpu");
    host.viewer.setDeepPointerPick?.((origin, direction) => pickDeepPresentation(host, backend, origin, direction));
    host.failureReported = false;
    host.lastCameraSnapshot = cameraSnapshot(host.viewer);
    takeoverGesturePresentation(host);
    // 静止视口没有帧回调，设备丢失必须主动通知，不能等待下一次用户输入。
    const session = (backend.runtime as { session?: RuntimeSession }).session;
    const unsubscribeFatalLoss = backend.onFatalLoss?.(reason => {
      if (host.deepBackend === backend) host.failRuntime(new Error(reason.message));
    });
    const unsubscribeRecreated = backend.onDeviceRecreated?.(() => {
      if (host.deepBackend !== backend) return;
      host.replaceRecoveredBackend(backend);
    });
    const legacyLoss = session?.onFatalLoss === undefined && session?.device?.lost;
    if (legacyLoss) void legacyLoss.then((info) => {
      if (host.deepBackend === backend) host.failRuntime(new Error(info.message || info.reason));
    }).catch((reason) => {
      if (host.deepBackend === backend) host.failRuntime(reason);
    });
    const unsubscribeFrames = host.viewer.subscribePresentationFrames(host.renderPresentationFrame);
    const previousUnsubscribe = host.unsubscribeFrame;
    host.unsubscribeFrame = () => {
      unsubscribeFrames();
      previousUnsubscribe?.();
      unsubscribeFatalLoss?.();
      unsubscribeRecreated?.();
    };
  }

export function publishWebGlPresentation(host: StudioDeepBridgePresentationHost): void {
    host.generation++;
    host.authorCanvas.style.opacity = "1";
    host.activeBackendValue = "webgl";
    host.viewer.setPresentationRendererBackend("webgl");
    releaseDeepPresentation(host);
  }

export function releaseDeepPresentation(host: StudioDeepBridgePresentationHost): void {
    host.viewer.setDeepPointerPick?.(undefined);
    host.projectionBridge = undefined;
    host.deformationSync = undefined;
    host.outlineSync = undefined;
    host.independentPacketPath = false;
    host.viewer.setAuthorPacketIndependent(false);
    host.viewer.setPresentationPerformanceSource(undefined);
    host.quality = undefined;
    publishStudioQualityTelemetry(undefined);
    host.performanceSource?.dispose();
    host.performanceSource = undefined;
    host.temporalSettler.cancel();
    host.viewReader.reset();
    host.environmentSession?.dispose();
    host.environmentSession = undefined;
    host.shadowSession?.dispose();
    host.shadowSession = undefined;
    const unsubscribe = host.unsubscribeFrame;
    host.unsubscribeFrame = undefined;
    const backend = host.deepBackend;
    const canvas = host.deepCanvas;
    const frameCaptureSession = host.frameCaptureSession;
    host.deepBackend = undefined;
    host.deepCanvas = undefined;
    host.frameCaptureSession = undefined;
    releaseStudioFrameCaptureSession(frameCaptureSession);
    host.syncPending = undefined;
    host.syncAgain = undefined;
    releaseGesturePresentation(host);
    host.lastCameraSnapshot = undefined;
    host.cameraFramesInFlight = 0;
    host.pendingCameraView = undefined;
    host.cameraFramesSubmitted = 0;
    host.cameraFramesCoalesced = 0;
    host.cameraMaxInFlight = 0;
    host.settledViewKey = "";
    host.lastDemandRevision = -1;
    host.qualityProfile = null;
    host.cancelCameraSettle();
    const errors: unknown[] = [];
    for (const clean of [unsubscribe, () => backend?.dispose(), () => canvas?.remove()]) {
      try { clean?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Deep renderer cleanup failed.");
  }

export function pickDeepPresentation(host: StudioDeepBridgePresentationHost, backend: DeepWebGpuBackend,
  origin: readonly [number, number, number], direction: readonly [number, number, number]): import("./viewerEngineTypes").DeepPointerPickResult {
    const runtime = backend.runtime as unknown as {
      pick?: (origin: ArrayLike<number>, direction: ArrayLike<number>, options?: { maxHits?: number }) =>
        { available: false; reason: string } | { available: true; hits: readonly { instanceId: string; point: readonly [number, number, number]; distance: number }[]; degraded?: readonly string[] };
    };
    if (typeof runtime.pick !== "function") return { available: false, reason: "Deep runtime does not expose picking.", fallbackToAuthor: true };
    let result;
    const localOrigin = backend.worldToRenderLocal(origin);
    try { result = runtime.pick(localOrigin, direction, { maxHits: 1 }); }
    catch (reason) { return { available: false, reason: reason instanceof Error ? reason.message : String(reason), fallbackToAuthor: true }; }
    if (!result.available) return { available: false, reason: result.reason, fallbackToAuthor: true };
    const hit = result.hits[0];
    if (!hit) return result.degraded
      ? { available: true, degraded: result.degraded, fallbackToAuthor: false }
      : { available: true, fallbackToAuthor: false };
    const packetModelId = backend.modelIdForInstanceId(hit.instanceId);
    const source = host.projectionBridge?.sourceForInstanceId(hit.instanceId) as unknown as
      { userData?: Record<string, unknown>; parent?: unknown } | undefined;
    const modelId = packetModelId ?? (source ? authorModelId(source) : undefined);
    if (!modelId) return { available: true, degraded: [...(result.degraded ?? []), "node-mapping-unavailable:deep-hit-not-selectable"], fallbackToAuthor: true };
    const picked = { point: new THREE.Vector3(...hit.point), distance: hit.distance, objectName: modelId, modelId };
    return result.degraded
      ? { available: true, degraded: result.degraded, hit: picked, fallbackToAuthor: false }
      : { available: true, hit: picked, fallbackToAuthor: false };
  }

  /** 视口手势接管:Deep 画布持有输入,作者画布降级为透传目标(拾取/gizmo 零损失)。 */
export function takeoverGesturePresentation(host: StudioDeepBridgePresentationHost): void {
    const state = host.viewer.getCameraState?.();
    const controller = host.controller ??= new DeepCameraController({
      verticalFovDegrees: host.viewer.getCameraProjectionState?.().verticalFovDegrees ?? 50,
    });
    if (state) {
      controller.setPose([state.position.x, state.position.y, state.position.z],
        [state.target.x, state.target.y, state.target.z]);
      host.lastAppliedPose = controller.getPose();
    }
    if (host.viewer.enableViewportGestureTakeover?.() !== true || !host.deepCanvas) return;
    host.gestureActive = true;
    host.deepCanvas.style.pointerEvents = "auto";
    host.authorCanvas.style.pointerEvents = "none";
    host.inputSession ??= new DeepCameraInputSession(host.deepCanvas, controller, () => host.applyGesturePose(), {
      forwardTo: host.authorCanvas,
      suppressGesture: () => host.viewer.isViewportGestureSuppressed?.() === true,
      handleGizmoPointer: (phase, event) => {
        const consumed = host.gizmoInteraction.handle(phase, event);
        const probe = flowProbe();
        if (probe) recordProbeSample(probe, `gizmo:${phase}=${consumed ? 1 : 0}@${Math.round(event.clientX)},${Math.round(event.clientY)}`);
        return consumed;
      },
    });
    host.inputSession.attach();
  }

export function releaseGesturePresentation(host: StudioDeepBridgePresentationHost): void {
    if (!host.gestureActive) return;
    host.gestureActive = false;
    host.lastGestureTickAt = undefined;
    host.inputSession?.detach();
    if (host.deepCanvas) host.deepCanvas.style.pointerEvents = "none";
    host.authorCanvas.style.pointerEvents = "auto";
    host.viewer.disableViewportGestureTakeover?.();
  }
