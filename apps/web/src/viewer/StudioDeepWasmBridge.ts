import * as THREE from "three";
import type { CameraState } from "@bim-studio/contracts";
import type { RendererBackend } from "./viewerTypes";
import { captureAuthorStyle, createDeepCanvas, prepareAuthorInputCanvas, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";
import { DeepCameraController, sameHostCameraPose, type CameraPose } from "./deepCameraController";
import { DeepCameraInputSession } from "./deepCameraInputSession";
import { DeepGizmoInteraction, type DeepGizmoInteractionHost } from "./deepGizmoInteraction";
import { StudioWasmPackageCache } from "./StudioWasmPackageCache";
import type { StudioWasmCompiledPackage } from "./studioWasmCompilationClient";

/** 视口手势接管期间的引擎中立相机姿态(世界单位)。 */
export type ViewportCameraPose = CameraPose;

export interface DeepWasmRuntimeModule {
  default(input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<unknown>;
  set_scene_package(bytes: Uint8Array): void;
  set_scene_package_with_expected_hash?(bytes: Uint8Array, expectedHash: string): void;
  compute_runtime_package_canonical_hash?(bytes: Uint8Array): string;
  prepare_scene_package?(bytes: Uint8Array, expectedHash?: string, signal?: AbortSignal): Promise<number>;
  discard_prepared_scene_package?(id: number): void;
  start_prepared_scene_viewer?(id: number, canvas?: HTMLCanvasElement | null): number;
  update_prepared_scene_viewer?(handle: number, id: number): void;
  start_scene_viewer(canvas?: HTMLCanvasElement | null): number;
  stop_scene_viewer(handle: number): void;
  set_scene_viewer_paused?(handle: number, paused: boolean): void;
  update_scene_viewer(handle: number, bytes: Uint8Array): void;
  update_scene_viewer_with_expected_hash?(handle: number, bytes: Uint8Array, expectedHash: string): void;
  update_editor_overlay?(handle: number, revision: number, vertices: Float32Array): void;
  set_viewer_camera(handle: number, positionX: number, positionY: number, positionZ: number,
    targetX: number, targetY: number, targetZ: number, focal: number, near: number, far: number): void;
  viewer_ready_generation(): number;
  scene_viewer_memory_bytes?(): number;
  viewer_failure_message(): string | undefined;
  viewer_physics_pose(handle: number, instanceId: string): Promise<string>;
}

export interface DeepWasmPhysicsPose {
  readonly instanceId: string;
  readonly fixedStep: number;
  readonly translation: readonly [number, number, number];
}

export interface StudioDeepWasmBridgeOptions {
  readonly compilePackage: (signal: AbortSignal) => Promise<StudioWasmCompiledPackage>;
  /** Host scene version, independent of camera and editor selection. */
  readonly packageKey?: () => string | undefined;
  readonly onPackageAccepted?: (compiled: StudioWasmCompiledPackage, key: string) => void;
  readonly loadModule?: () => Promise<DeepWasmRuntimeModule>;
  readonly preparationTimeoutMs?: number;
  readonly onRuntimeFailure?: (error: Error) => void;
  readonly readEditorOverlay?: (width: number, height: number, pixelRatio: number) => { revision: number; vertices: Float32Array };
}

/** Engine-neutral author seam used while the editor authority migrates off Three. */
export interface StudioDeepWasmAuthorHost {
  readonly renderer: { readonly domElement: HTMLCanvasElement };
  readonly camera?: THREE.PerspectiveCamera;
  getCameraState(): CameraState;
  getCameraProjectionState(): { readonly verticalFovDegrees: number; readonly near: number; readonly far: number };
  setPresentationRendererBackend(backend: RendererBackend): void;
  subscribePresentationFrames(listener: () => void): () => void;
  /** 视口手势接管:宿主停用 OrbitControls 并返回 true;接管期间经 applyViewportCameraPose 写回姿态。 */
  enableViewportGestureTakeover?(): boolean;
  disableViewportGestureTakeover?(): void;
  /** gizmo 拖拽进行中时抑制视口手势(转发仍发生)。 */
  isViewportGestureSuppressed?(): boolean;
  applyViewportCameraPose?(pose: ViewportCameraPose): void;
  getDeepTransformGizmoInput?(): import("./deepOverlayPrimitives").DeepTransformGizmoInput | undefined;
  getSelectionTransform?(): import("@bim-studio/contracts").ModelTransform | undefined;
  applySelectionTransform?(transform: import("@bim-studio/contracts").ModelTransform): void;
  isSelectionLocked?(): boolean;
  requestRender?(): void;
  setContinuousRender?(reason: string, active: boolean): void;
}

export interface StudioWasmSwitchResult {
  readonly status: "switched" | "unchanged" | "cancelled" | "failed";
  readonly activeBackend: RendererBackend;
  readonly error?: string;
}

const MODULE_URL = `${import.meta.env.BASE_URL}engine-wasm/deep_engine_wasm.js`;

/** Full WASM presentation surface behind an engine-neutral author seam. */
export class StudioDeepWasmBridge {
  private readonly authorCanvas: HTMLCanvasElement;
  private readonly authorStyle: AuthorCanvasStyle;
  private module: DeepWasmRuntimeModule | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private handle: number | undefined;
  private activeBackendValue: RendererBackend = "webgl";
  private pending: AbortController | undefined;
  private unsubscribeFrame: (() => void) | undefined;
  private cameraFrame: number | undefined;
  private lastCameraSnapshot: readonly number[] | undefined;
  private lastOverlayRevision = -1;
  private generation = 0;
  private closed = false;
  private controller: DeepCameraController | undefined;
  private inputSession: DeepCameraInputSession | undefined;
  private gestureActive = false;
  private lastGestureTickAt: number | undefined;
  /** 控制器最后写回/采纳的姿态:区分"手势收敛中"与"宿主程序性变更"。 */
  private lastAppliedPose: CameraPose | undefined;
  private readonly gizmoInteraction: DeepGizmoInteraction | undefined;
  private readonly packageCache = new StudioWasmPackageCache();
  private acceptedPackageKey: string | undefined;
  private warmup: Promise<StudioWasmSwitchResult> | undefined;

  /** Prepare an owned, hidden renderer without changing author input or presentation. */
  prewarm(signal: AbortSignal): Promise<StudioWasmSwitchResult> {
    if (this.warmup) return this.warmup;
    if (this.pending) return Promise.resolve(this.result("cancelled"));
    if (this.activeBackendValue === "wasm") return Promise.resolve(this.result("unchanged"));
    signal.throwIfAborted();
    const abort = () => this.cancelPendingSwitch();
    signal.addEventListener("abort", abort, { once: true });
    const task = this.runSwitch("wasm", undefined, true).finally(() => {
      signal.removeEventListener("abort", abort);
      if (this.warmup === task) this.warmup = undefined;
    });
    this.warmup = task;
    return task;
  }

  constructor(
    private readonly viewer: StudioDeepWasmAuthorHost,
    private readonly container: HTMLElement,
    private readonly options: StudioDeepWasmBridgeOptions,
  ) {
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    this.gizmoInteraction = isDeepGizmoHost(viewer)
      ? new DeepGizmoInteraction(viewer, () => this.authorCanvas.getBoundingClientRect())
      : undefined;
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }
  get memoryBytes(): number { return this.module?.scene_viewer_memory_bytes?.() ?? -1; }

  async physicsPose(instanceId: string): Promise<DeepWasmPhysicsPose> {
    if (this.activeBackendValue !== "wasm" || !this.module || this.handle === undefined) {
      throw new Error("Deep WASM physics viewer is not active.");
    }
    const value: unknown = JSON.parse(await this.module.viewer_physics_pose(this.handle, instanceId));
    if (!value || typeof value !== "object") throw new Error("Deep WASM physics pose is invalid.");
    const pose = value as Partial<DeepWasmPhysicsPose>;
    if (pose.instanceId !== instanceId || !Number.isSafeInteger(pose.fixedStep) || pose.fixedStep! < 0
      || !Array.isArray(pose.translation) || pose.translation.length !== 3
      || !pose.translation.every(Number.isFinite)) throw new Error("Deep WASM physics pose is invalid.");
    return pose as DeepWasmPhysicsPose;
  }

  cancelPendingSwitch(): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  switchTo(target: "webgl" | "wasm",
    beforePublish?: (signal: AbortSignal) => Promise<void>): Promise<StudioWasmSwitchResult> {
    if (target === "wasm" && this.warmup) {
      const generation = this.generation;
      return this.warmup.then(() => generation === this.generation && !this.closed
        ? this.runSwitch(target, beforePublish) : this.result("cancelled"));
    }
    return this.runSwitch(target, beforePublish);
  }

  private async runSwitch(target: "webgl" | "wasm",
    beforePublish?: (signal: AbortSignal) => Promise<void>, prepareOnly = false): Promise<StudioWasmSwitchResult> {
    if (this.closed) return this.result("failed", "Renderer bridge is disposed.");
    this.cancelPendingSwitch();
    const generation = this.generation;
    if (target === this.activeBackendValue) return this.result("unchanged");
    if (target === "webgl") {
      this.publishWebGl();
      return this.result("switched");
    }
    if (!window.isSecureContext || !("gpu" in navigator) || !navigator.gpu) {
      return this.result("failed", "Deep WASM requires WebGPU in an HTTPS or localhost context.");
    }
    const controller = new AbortController();
    this.pending = controller;
    markSwitchPhase("deep-wasm:switch-start");
    const canvas = this.canvas ?? createDeepCanvas(this.container, "deep-wasm");
    canvas.dataset.rendererPreparing = "true";
    let startedHandle: number | undefined;
    let runtimeModule: DeepWasmRuntimeModule | undefined;
    let preparedId: number | undefined;
    try {
      const module = this.module ?? await (this.options.loadModule ?? loadDeepWasmModule)();
      markSwitchPhase("deep-wasm:module-ready");
      runtimeModule = module;
      controller.signal.throwIfAborted();
      const packageKey = this.options.packageKey?.();
      const sameVersion = this.handle !== undefined && packageKey !== undefined && packageKey === this.acceptedPackageKey;
      const compiled = sameVersion ? undefined : await this.options.compilePackage(controller.signal);
      const bytes = compiled?.bytes ?? new Uint8Array();
      const canonicalHash = compiled?.canonicalHash;
      markSwitchPhase("deep-wasm:package-compiled");
      controller.signal.throwIfAborted();
      const before = module.viewer_ready_generation();
      let handle = this.handle;
      const reused = sameVersion || (handle !== undefined && this.packageCache.matches(bytes));
      if (!reused && supportsCooperativePreparation(module)) {
        markSwitchPhase("deep-wasm:prepare-package-start");
        preparedId = await module.prepare_scene_package!(bytes, canonicalHash, controller.signal);
        markSwitchPhase("deep-wasm:prepare-package-done");
        controller.signal.throwIfAborted();
      }
      if (handle === undefined) {
        markSwitchPhase("deep-wasm:set-package-start");
        if (preparedId === undefined) {
          if (canonicalHash && module.set_scene_package_with_expected_hash) module.set_scene_package_with_expected_hash(bytes, canonicalHash);
          else module.set_scene_package(bytes);
        }
        markSwitchPhase("deep-wasm:set-package-done");
        handle = preparedId === undefined ? module.start_scene_viewer(canvas) : module.start_prepared_scene_viewer!(preparedId, canvas);
        preparedId = undefined;
        markSwitchPhase("deep-wasm:start-viewer-done");
        startedHandle = handle;
      } else if (!reused) {
        this.acceptedPackageKey = undefined;
        this.packageCache.clear();
        module.set_scene_viewer_paused?.(handle, false);
        markSwitchPhase("deep-wasm:update-package-start");
        if (preparedId !== undefined) { module.update_prepared_scene_viewer!(handle, preparedId); preparedId = undefined; }
        else if (canonicalHash && module.update_scene_viewer_with_expected_hash) module.update_scene_viewer_with_expected_hash(handle, bytes, canonicalHash);
        else module.update_scene_viewer(handle, bytes);
        markSwitchPhase("deep-wasm:update-package-done");
      }
      if (reused) assertWasmRuntimeHealthy(module);
      else await waitForRendererReady(module, before, controller.signal, this.options.preparationTimeoutMs ?? 30_000);
      markSwitchPhase("deep-wasm:renderer-ready");
      controller.signal.throwIfAborted();
      if (packageKey !== undefined && this.options.packageKey?.() !== packageKey) throw new Error("场景在 WASM 准备期间改变，请重试。");
      await beforePublish?.(controller.signal);
      if (this.closed || generation !== this.generation) {
        if (startedHandle !== undefined) module.stop_scene_viewer(startedHandle);
        if (!this.canvas) canvas.remove();
        return this.result("cancelled");
      }
      this.module = module;
      this.canvas = canvas;
      this.handle = handle;
      this.acceptPackage(compiled, packageKey, reused);
      if (prepareOnly) {
        module.set_scene_viewer_paused?.(handle, true);
        canvas.style.visibility = "hidden";
        canvas.style.opacity = "0";
        markSwitchPhase("deep-wasm:prewarmed");
      } else {
        this.publishWasm();
        markSwitchPhase("deep-wasm:published");
      }
      return this.result("switched");
    } catch (reason) {
      if (this.activeBackendValue !== "wasm" && this.handle !== undefined) runtimeModule?.set_scene_viewer_paused?.(this.handle, true);
      if (runtimeModule && startedHandle !== undefined) {
        try { runtimeModule.stop_scene_viewer(startedHandle); } catch { /* best-effort cleanup after failed startup */ }
      }
      if (!this.canvas) canvas.remove();
      if (controller.signal.aborted) return this.result("cancelled");
      return this.result("failed", reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (preparedId !== undefined) runtimeModule?.discard_prepared_scene_package?.(preparedId);
      delete canvas.dataset.rendererPreparing;
      if (this.pending === controller) this.pending = undefined;
    }
  }

  async refresh(): Promise<StudioWasmSwitchResult> {
    if (this.activeBackendValue !== "wasm" || !this.module || this.handle === undefined) return this.result("unchanged");
    const packageKey = this.options.packageKey?.();
    if (packageKey !== undefined && packageKey === this.acceptedPackageKey) {
      assertWasmRuntimeHealthy(this.module);
      return this.result("unchanged");
    }
    this.cancelPendingSwitch();
    const controller = new AbortController();
    this.pending = controller;
    const generation = this.generation;
    let preparedId: number | undefined;
    const module = this.module;
    try {
      const compiled = await this.options.compilePackage(controller.signal);
      const { bytes, canonicalHash } = compiled;
      controller.signal.throwIfAborted();
      const before = this.module.viewer_ready_generation();
      if (this.packageCache.matches(bytes)) {
        assertWasmRuntimeHealthy(this.module);
        this.publishWasm();
        return this.result("unchanged");
      }
      // Keep the last successfully presented WASM frame visible while the next
      // scene package is prepared. The native event loop rebuilds the renderer
      // asynchronously; swapping back to the author canvas here made every
      // autosave/revision look like a black/background flash.
      if (supportsCooperativePreparation(module)) {
        preparedId = await module.prepare_scene_package!(bytes, canonicalHash, controller.signal);
        controller.signal.throwIfAborted();
        this.acceptedPackageKey = undefined;
        this.packageCache.clear();
        module.update_prepared_scene_viewer!(this.handle, preparedId);
        preparedId = undefined;
      } else {
        this.acceptedPackageKey = undefined;
        this.packageCache.clear();
        if (canonicalHash && module.update_scene_viewer_with_expected_hash) module.update_scene_viewer_with_expected_hash(this.handle, bytes, canonicalHash);
        else module.update_scene_viewer(this.handle, bytes);
      }
      await waitForRendererReady(this.module, before, controller.signal, this.options.preparationTimeoutMs ?? 30_000);
      if (this.closed || generation !== this.generation) return this.result("cancelled");
      if (packageKey !== undefined && this.options.packageKey?.() !== packageKey) throw new Error("场景在 WASM 准备期间改变，请重试。");
      this.acceptPackage(compiled, packageKey, false);
      this.publishWasm();
      return this.result("switched");
    } catch (reason) {
      if (controller.signal.aborted) return this.result("cancelled");
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publishWebGl();
      this.options.onRuntimeFailure?.(error);
      return this.result("failed", error.message);
    } finally {
      if (preparedId !== undefined) module.discard_prepared_scene_package?.(preparedId);
      if (this.pending === controller) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.packageCache.clear();
    this.acceptedPackageKey = undefined;
    this.cancelPendingSwitch();
    this.releaseGesture();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = undefined;
    this.cancelCameraSync();
    if (this.module && this.handle !== undefined) this.module.stop_scene_viewer(this.handle);
    this.handle = undefined;
    this.canvas?.remove();
    this.canvas = undefined;
    restoreAuthorStyle(this.authorCanvas, this.authorStyle);
    this.viewer.setPresentationRendererBackend("webgl");
  }

  private publishWasm(): void {
    if (!this.canvas || !this.module || this.handle === undefined) throw new Error("WASM renderer is not prepared.");
    this.module.set_scene_viewer_paused?.(this.handle, false);
    // 内存诊断探针:wasm 线性内存字节数(JS heap 口径里与 JS 对象可分离的那部分)。
    (window as unknown as { __studioDeepWasmMemoryProbe?: () => number }).__studioDeepWasmMemoryProbe =
      () => this.module?.scene_viewer_memory_bytes?.()
        ?? (this.module as { memory?: { buffer?: ArrayBuffer } } | undefined)?.memory?.buffer?.byteLength ?? -1;
    this.canvas.style.visibility = "visible";
    delete this.canvas.dataset.rendererPreparing;
    this.canvas.style.opacity = "1";
    this.authorCanvas.style.opacity = "0";
    this.activeBackendValue = "wasm";
    this.viewer.setPresentationRendererBackend("wasm");
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = this.viewer.subscribePresentationFrames(this.queueCameraSync);
    try { this.syncEditorOverlay(); }
    catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publishWebGl();
      this.options.onRuntimeFailure?.(error);
    }
    this.syncCamera(true);
    this.takeoverGesture();
  }

  /** 视口手势接管:Deep 画布持有输入,作者画布降级为透传目标(拾取/gizmo 零损失)。 */
  private takeoverGesture(): void {
    const projection = this.viewer.getCameraProjectionState();
    const state = this.viewer.getCameraState();
    this.controller ??= new DeepCameraController({ verticalFovDegrees: projection.verticalFovDegrees });
    this.controller.setPose([state.position.x, state.position.y, state.position.z],
      [state.target.x, state.target.y, state.target.z]);
    this.lastAppliedPose = this.controller.getPose();
    if (this.viewer.enableViewportGestureTakeover?.() !== true || !this.canvas) {
      // 宿主拒绝(如导航模式不支持):保持既有输入路径,不视为失败。
      this.controller.setPose([state.position.x, state.position.y, state.position.z],
        [state.target.x, state.target.y, state.target.z]);
      return;
    }
    this.gestureActive = true;
    this.canvas.style.pointerEvents = "auto";
    // 作者画布不再持有输入:事件由 Deep 画布接收并克隆转发回来(拾取/gizmo 链零损失)。
    this.authorCanvas.style.pointerEvents = "none";
    this.inputSession ??= new DeepCameraInputSession(this.canvas, this.controller, () => {
      if (this.viewer.setContinuousRender) this.viewer.setContinuousRender("deep-camera", true);
      else this.queueCameraSync();
    }, {
      forwardTo: this.authorCanvas,
      suppressGesture: () => this.viewer.isViewportGestureSuppressed?.() === true,
      handleGizmoPointer: (phase, event) => this.gizmoInteraction?.handle(phase, event) === true,
    });
    this.inputSession.attach();
  }

  private releaseGesture(): void {
    if (!this.gestureActive) return;
    this.gestureActive = false;
    this.viewer.setContinuousRender?.("deep-camera", false);
    this.lastGestureTickAt = undefined;
    this.inputSession?.detach();
    if (this.canvas) this.canvas.style.pointerEvents = "none";
    this.authorCanvas.style.pointerEvents = "auto";
    this.viewer.disableViewportGestureTakeover?.();
  }

  private publishWebGl(): void {
    if (this.handle !== undefined) this.module?.set_scene_viewer_paused?.(this.handle, true);
    this.releaseGesture();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = undefined;
    this.cancelCameraSync();
    this.authorCanvas.style.opacity = "1";
    if (this.canvas) this.canvas.style.opacity = "0";
    this.activeBackendValue = "webgl";
    this.viewer.setPresentationRendererBackend("webgl");
  }

  private readonly queueCameraSync = (): void => {
    // Pointer samples change the target; the author frame applies one latest
    // pose and one native update, including damping after pointerup.
    if (this.gestureActive && this.controller) {
      const now = performance.now();
      const dt = this.lastGestureTickAt === undefined ? 16 : Math.min(100, now - this.lastGestureTickAt);
      this.lastGestureTickAt = now;
      const stillConverging = this.controller.tick(dt);
      this.viewer.setContinuousRender?.("deep-camera", stillConverging);
      const state = this.viewer.getCameraState();
      if (!sameHostCameraPose(state, this.lastAppliedPose)) {
        // 宿主相机偏离控制器最后同步姿态 = 程序性变更(fitAll/标准视角/快照恢复):
        // 以宿主为准重设控制器。此前的无条件写回会把接管时刻的旧球坐标每帧刷回
        // 宿主相机,覆盖 fitAll 与位姿点击——相机被冻结在切换时刻(F1 实测根因)。
        this.controller.setPose([state.position.x, state.position.y, state.position.z],
          [state.target.x, state.target.y, state.target.z]);
        this.lastAppliedPose = this.controller.getPose();
      } else {
        const pose = this.controller.getPose();
        if (!sameHostCameraPose(state, pose)) this.viewer.applyViewportCameraPose?.(pose);
        this.lastAppliedPose = pose;
      }
    }
    try { this.syncEditorOverlay(); }
    catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publishWebGl();
      this.options.onRuntimeFailure?.(error);
      return;
    }
    this.syncCamera(false);
  };

  private syncEditorOverlay(): void {
    if (this.activeBackendValue !== "wasm" || !this.module || this.handle === undefined || !this.module.update_editor_overlay || !this.options.readEditorOverlay) return;
    const snapshot = this.options.readEditorOverlay(this.canvas?.clientWidth ?? 1, this.canvas?.clientHeight ?? 1, devicePixelRatio || 1);
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < this.lastOverlayRevision) throw new Error("Editor overlay revision went backwards.");
    if (snapshot.revision === this.lastOverlayRevision) return;
    this.module.update_editor_overlay(this.handle, snapshot.revision, snapshot.vertices);
    this.lastOverlayRevision = snapshot.revision;
  }

  private syncCamera(force: boolean): void {
    if (this.activeBackendValue !== "wasm" || !this.module || this.handle === undefined) return;
    const state = this.viewer.getCameraState();
    const projection = this.viewer.getCameraProjectionState();
    const focal = 1 / Math.tan(projection.verticalFovDegrees * Math.PI / 360);
    const snapshot = [state.position.x, state.position.y, state.position.z,
      state.target.x, state.target.y, state.target.z, focal, projection.near, projection.far];
    if (!force && sameCameraSnapshot(snapshot, this.lastCameraSnapshot)) return;
    this.lastCameraSnapshot = snapshot;
    try {
      this.module.set_viewer_camera(this.handle,
        state.position.x, state.position.y, state.position.z,
        state.target.x, state.target.y, state.target.z,
        focal, projection.near, projection.far);
      // 测量插桩:公平对比 runner 用它关联"宿主相机已应用"与 wasm 内部下一次
      // submit,解释 pointer→submit 的口径(内部自持循环节拍)。
      performance.mark("deep-wasm:camera-sync-applied");
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publishWebGl();
      this.options.onRuntimeFailure?.(error);
    }
  }

  private cancelCameraSync(): void {
    if (this.cameraFrame !== undefined && typeof globalThis.cancelAnimationFrame === "function") cancelAnimationFrame(this.cameraFrame);
    this.cameraFrame = undefined;
    this.lastCameraSnapshot = undefined;
  }

  private result(status: StudioWasmSwitchResult["status"], error?: string): StudioWasmSwitchResult {
    return { status, activeBackend: this.activeBackendValue, ...(error ? { error } : {}) };
  }

  private acceptPackage(compiled: StudioWasmCompiledPackage | undefined, key: string | undefined, reused: boolean): void {
    this.acceptedPackageKey = key;
    if (key !== undefined) {
      // The native handle owns verified scene data. Keep a version receipt,
      // not a second 160 MiB serialization just to detect an unchanged scene.
      this.packageCache.clear();
      if (compiled) this.options.onPackageAccepted?.(compiled, key);
    } else if (!reused && compiled) this.packageCache.commit(compiled.bytes);
  }
}

function isDeepGizmoHost(host: StudioDeepWasmAuthorHost): host is StudioDeepWasmAuthorHost & DeepGizmoInteractionHost {
  const candidate = host as StudioDeepWasmAuthorHost & Partial<DeepGizmoInteractionHost>;
  return candidate.camera !== undefined
    && typeof candidate.getDeepTransformGizmoInput === "function"
    && typeof candidate.getSelectionTransform === "function"
    && typeof candidate.applySelectionTransform === "function"
    && typeof candidate.isSelectionLocked === "function";
}

function sameCameraSnapshot(a: readonly number[], b: readonly number[] | undefined, epsilon = 1e-5): boolean {
  return b !== undefined && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= epsilon);
}

function markSwitchPhase(name: string): void {
  if (typeof performance?.mark === "function") performance.mark(name);
}

function supportsCooperativePreparation(module: DeepWasmRuntimeModule): boolean {
  return typeof module.prepare_scene_package === "function" && typeof module.discard_prepared_scene_package === "function"
    && typeof module.start_prepared_scene_viewer === "function" && typeof module.update_prepared_scene_viewer === "function";
}

async function loadDeepWasmModule(): Promise<DeepWasmRuntimeModule> {
  // The generated wasm-bindgen module lives in Vite's public directory and must
  // be fetched as-is. An absolute runtime URL keeps Vite from appending `?import`
  // and trying to transform the generated module as application source.
  const runtimeUrl = new URL(MODULE_URL, window.location.href).href;
  const module = await import(/* @vite-ignore */ runtimeUrl) as DeepWasmRuntimeModule;
  await module.default();
  return module;
}

function waitForRendererReady(module: DeepWasmRuntimeModule, before: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (signal.aborted) return reject(new DOMException("Renderer switch cancelled", "AbortError"));
      const failure = module.viewer_failure_message();
      if (failure) return reject(new Error(failure));
      if (module.viewer_ready_generation() !== before) return resolve();
      if (performance.now() - started >= timeoutMs) return reject(new Error(`Deep WASM renderer did not become ready within ${timeoutMs}ms.`));
      requestAnimationFrame(poll);
    };
    poll();
  });
}

function assertWasmRuntimeHealthy(module: DeepWasmRuntimeModule): void {
  const failure = module.viewer_failure_message();
  if (failure) throw new Error(failure);
}
