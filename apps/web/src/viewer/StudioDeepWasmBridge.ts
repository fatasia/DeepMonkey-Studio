import type { CameraState } from "@bim-studio/contracts";
import type { RendererBackend } from "./viewerTypes";
import { captureAuthorStyle, createDeepCanvas, prepareAuthorInputCanvas, restoreAuthorStyle,
  type AuthorCanvasStyle } from "./studioDeepPresentationCanvas";

export interface DeepWasmRuntimeModule {
  default(input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<unknown>;
  set_scene_package(bytes: Uint8Array): void;
  start_scene_viewer(canvas?: HTMLCanvasElement | null): number;
  stop_scene_viewer(handle: number): void;
  update_scene_viewer(handle: number, bytes: Uint8Array): void;
  set_viewer_camera(handle: number, positionX: number, positionY: number, positionZ: number,
    targetX: number, targetY: number, targetZ: number, focal: number, near: number, far: number): void;
  viewer_ready_generation(): number;
  viewer_failure_message(): string | undefined;
}

export interface StudioDeepWasmBridgeOptions {
  readonly compilePackage: (signal: AbortSignal) => Promise<Uint8Array>;
  readonly loadModule?: () => Promise<DeepWasmRuntimeModule>;
  readonly preparationTimeoutMs?: number;
  readonly onRuntimeFailure?: (error: Error) => void;
}

/** Engine-neutral author seam used while the editor authority migrates off Three. */
export interface StudioDeepWasmAuthorHost {
  readonly renderer: { readonly domElement: HTMLCanvasElement };
  getCameraState(): CameraState;
  getCameraProjectionState(): { readonly verticalFovDegrees: number; readonly near: number; readonly far: number };
  setPresentationRendererBackend(backend: RendererBackend): void;
  subscribePresentationFrames(listener: () => void): () => void;
}

export interface StudioWasmSwitchResult {
  readonly status: "switched" | "unchanged" | "cancelled" | "failed";
  readonly activeBackend: RendererBackend;
  readonly error?: string;
}

const MODULE_URL = "/engine-wasm/deep_engine_wasm.js";

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
  private generation = 0;
  private closed = false;

  constructor(
    private readonly viewer: StudioDeepWasmAuthorHost,
    private readonly container: HTMLElement,
    private readonly options: StudioDeepWasmBridgeOptions,
  ) {
    this.authorCanvas = viewer.renderer.domElement;
    this.authorStyle = captureAuthorStyle(this.authorCanvas);
    prepareAuthorInputCanvas(this.authorCanvas);
  }

  get activeBackend(): RendererBackend { return this.activeBackendValue; }

  cancelPendingSwitch(): void {
    this.generation++;
    this.pending?.abort();
    this.pending = undefined;
  }

  async switchTo(target: "webgl" | "wasm"): Promise<StudioWasmSwitchResult> {
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
    let startedHandle: number | undefined;
    let runtimeModule: DeepWasmRuntimeModule | undefined;
    try {
      const module = this.module ?? await (this.options.loadModule ?? loadDeepWasmModule)();
      markSwitchPhase("deep-wasm:module-ready");
      runtimeModule = module;
      controller.signal.throwIfAborted();
      const bytes = await this.options.compilePackage(controller.signal);
      markSwitchPhase("deep-wasm:package-compiled");
      controller.signal.throwIfAborted();
      const before = module.viewer_ready_generation();
      let handle = this.handle;
      if (handle === undefined) {
        module.set_scene_package(bytes);
        handle = module.start_scene_viewer(canvas);
        startedHandle = handle;
      } else {
        module.update_scene_viewer(handle, bytes);
      }
      await waitForRendererReady(module, before, controller.signal, this.options.preparationTimeoutMs ?? 30_000);
      markSwitchPhase("deep-wasm:renderer-ready");
      if (this.closed || generation !== this.generation) {
        if (startedHandle !== undefined) module.stop_scene_viewer(startedHandle);
        if (!this.canvas) canvas.remove();
        return this.result("cancelled");
      }
      this.module = module;
      this.canvas = canvas;
      this.handle = handle;
      this.publishWasm();
      markSwitchPhase("deep-wasm:published");
      return this.result("switched");
    } catch (reason) {
      if (runtimeModule && startedHandle !== undefined) {
        try { runtimeModule.stop_scene_viewer(startedHandle); } catch { /* best-effort cleanup after failed startup */ }
      }
      if (controller.signal.aborted) return this.result("cancelled");
      if (!this.canvas) canvas.remove();
      return this.result("failed", reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  async refresh(): Promise<StudioWasmSwitchResult> {
    if (this.activeBackendValue !== "wasm" || !this.module || this.handle === undefined) return this.result("unchanged");
    this.cancelPendingSwitch();
    const controller = new AbortController();
    this.pending = controller;
    const generation = this.generation;
    try {
      const bytes = await this.options.compilePackage(controller.signal);
      controller.signal.throwIfAborted();
      const before = this.module.viewer_ready_generation();
      // Keep the last successfully presented WASM frame visible while the next
      // scene package is prepared. The native event loop rebuilds the renderer
      // asynchronously; swapping back to the author canvas here made every
      // autosave/revision look like a black/background flash.
      this.module.update_scene_viewer(this.handle, bytes);
      await waitForRendererReady(this.module, before, controller.signal, this.options.preparationTimeoutMs ?? 30_000);
      if (this.closed || generation !== this.generation) return this.result("cancelled");
      this.publishWasm();
      return this.result("switched");
    } catch (reason) {
      if (controller.signal.aborted) return this.result("cancelled");
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.publishWebGl();
      this.options.onRuntimeFailure?.(error);
      return this.result("failed", error.message);
    } finally {
      if (this.pending === controller) this.pending = undefined;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPendingSwitch();
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
    this.canvas.style.visibility = "visible";
    this.canvas.style.opacity = "1";
    this.authorCanvas.style.opacity = "0";
    this.activeBackendValue = "wasm";
    this.viewer.setPresentationRendererBackend("wasm");
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = this.viewer.subscribePresentationFrames(this.queueCameraSync);
    this.syncCamera(true);
  }

  private publishWebGl(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = undefined;
    this.cancelCameraSync();
    this.authorCanvas.style.opacity = "1";
    if (this.canvas) this.canvas.style.opacity = "0";
    this.activeBackendValue = "webgl";
    this.viewer.setPresentationRendererBackend("webgl");
  }

  private readonly queueCameraSync = (): void => {
    // 订阅回调本身每作者帧只触发一次;再排 rAF 会把相机同步推到下一帧,
    // 凭空增加一帧输入延迟。sameCameraSnapshot 的 ε 去重已兜住冗余 FFI。
    if (typeof globalThis.requestAnimationFrame !== "function") {
      this.syncCamera(false);
      return;
    }
    this.syncCamera(false);
  };

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
}

function sameCameraSnapshot(a: readonly number[], b: readonly number[] | undefined, epsilon = 1e-5): boolean {
  return b !== undefined && a.length === b.length && a.every((value, index) => Math.abs(value - b[index]!) <= epsilon);
}

function markSwitchPhase(name: string): void {
  if (typeof performance?.mark === "function") performance.mark(name);
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
