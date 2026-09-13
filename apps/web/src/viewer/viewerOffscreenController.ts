import * as THREE from "three";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import type { OffscreenContext } from "./offscreenRenderProtocol";
import { inspectOffscreenScene, type OffscreenSceneInventory } from "./offscreenSceneCompatibility";
import { OffscreenFrameCollector, mergeOffscreenFrames } from "./offscreenSceneFrames";
import {
  offscreenEnvironmentSupported,
  type OffscreenFrame,
  type OffscreenRequest,
  type OffscreenResponse,
  type OffscreenSnapshot,
} from "./offscreenRenderProtocol";
import { closeOffscreenImages, snapshotOffscreenScene } from "./offscreenSceneSnapshot";

export type OffscreenDiagnostics = {
  mode: "off" | "starting" | "active" | "fallback";
  reason?: string;
  frames: number;
  restarts: number;
  lastRenderMs?: number;
  lastDrawCalls?: number;
  lastTriangles?: number;
};

/** 后台渲染只依赖 WebGL 渲染器的少量读操作；WebGPU 渲染器传入时在体检阶段回退。 */
export type OffscreenRendererLike = {
  isWebGLRenderer?: boolean;
  getPixelRatio(): number;
  outputColorSpace: string;
  toneMapping: number;
  toneMappingExposure: number;
  shadowMap: { enabled: boolean; type: number };
  getClearColor(target: { getHex(): number }): { getHex(): number };
  getClearAlpha(): number;
};

export interface OffscreenControllerDeps {
  container: HTMLElement;
  renderer: OffscreenRendererLike;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  requestRender: () => void;
  /** 叠加层 Sprite(标注/告警标签):Worker 不画,主线程按投影位置补绘在位图之上。 */
  overlaySprites?: () => THREE.Sprite[];
  /** 测试注入点；生产环境从同目录 worker 模块构造。 */
  createWorker?: () => Worker;
  /** 测试注入点；生产环境用覆盖画布 2D 上下文回传位图。 */
  paintBitmap?: (bitmap: ImageBitmap) => void;
}

const RESTART_WINDOW_MS = 20_000;
const RESTART_LIMIT = 2;
const MUTATION_QUIET_MS = 800;
const MATERIAL_FULL_COLLECT_FRAMES = 90;

/** 跨实例状态广播:设置页用它展示"后台线程渲染"的真实运行状态与回退原因。 */
export type OffscreenGlobalStatus = { mode: OffscreenDiagnostics["mode"]; reason?: string; activeEngines: number };
const statusListeners = new Set<() => void>();
const activeControllers = new Set<ViewerOffscreenController>();
let globalStatus: OffscreenGlobalStatus = { mode: "off", activeEngines: 0 };
function publishGlobalStatus(): void {
  for (const listener of statusListeners) listener();
}
function syncGlobalStatus(): void {
  const controllers = [...activeControllers];
  const active = controllers.some(controller => controller.status.mode === "active");
  const starting = controllers.some(controller => controller.status.mode === "starting");
  const fallback = controllers.find(controller => controller.status.mode === "fallback");
  globalStatus = {
    mode: active ? "active" : fallback ? "fallback" : starting ? "starting" : "off",
    ...(fallback?.status.reason ? { reason: fallback.status.reason } : {}),
    activeEngines: controllers.length,
  };
  publishGlobalStatus();
}
export function subscribeOffscreenGlobalStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}
export function getOffscreenGlobalStatus(): OffscreenGlobalStatus {
  return globalStatus;
}

/**
 * 后台线程渲染控制器：Worker 内 WebGLRenderer 绘制克隆场景，ImageBitmap 回传覆盖画布。
 * 主线程渲染器与场景对象始终保留，任何失败都可以零破坏地回到主线程渲染。
 */
export class ViewerOffscreenController {
  /** @internal 供模块级状态聚合读取;外部仍应使用 diagnostics()。 */
  status: OffscreenDiagnostics = { mode: "off", frames: 0, restarts: 0 };
  private worker: Worker | undefined;
  private overlay: HTMLCanvasElement | undefined;
  private overlayContext: CanvasRenderingContext2D | undefined;
  private restoredPosition: string | undefined;
  private inventory: OffscreenSceneInventory | undefined;
  private collector = new OffscreenFrameCollector();
  private pendingFrame: OffscreenFrame | undefined;
  private sequence = 0;
  private materialVersions = new Map<string, number>();
  private framesSinceMaterialCollect = 0;
  private mutationTimer: number | undefined;
  private restartTimestamps: number[] = [];
  private restartPending = false;
  private disposed = false;

  constructor(private readonly deps: OffscreenControllerDeps) {
    activeControllers.add(this);
  }

  diagnostics(): OffscreenDiagnostics {
    return { ...this.status };
  }

  /** 渲染循环在 active 且非 XR 时改发增量帧；其余情况照常主线程渲染。 */
  wantsFrame(): boolean {
    return this.status.mode === "active" && Boolean(this.worker);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) await this.start();
    else this.stop();
  }

  /** 场景结构可能变化时调用（防抖后重新体检，签名一致则不动）。 */
  noteSceneMutated(): void {
    if (this.disposed || this.status.mode !== "active" || this.restartPending) return;
    if (this.mutationTimer !== undefined) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = window.setTimeout(() => {
      this.mutationTimer = undefined;
      void this.recheckCompatibility();
    }, MUTATION_QUIET_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.mutationTimer !== undefined) window.clearTimeout(this.mutationTimer);
    this.mutationTimer = undefined;
    this.stop();
    activeControllers.delete(this);
    syncGlobalStatus();
  }

  private async start(): Promise<void> {
    if (this.status.mode === "active" || this.status.mode === "starting") return;
    const unsupported = this.environmentReason();
    if (unsupported) return this.fallback(unsupported);
    const inventory = inspectOffscreenScene(this.deps.scene);
    if (inventory.reason) return this.fallback(inventory.reason);
    this.status = { ...this.status, mode: "starting" };
    syncGlobalStatus();
    try {
      await this.launchWorker(inventory);
    } catch (error) {
      this.status = { mode: "fallback", reason: error instanceof Error ? error.message : "后台渲染启动失败", frames: this.status.frames, restarts: this.status.restarts };
      this.deps.requestRender();
    }
  }

  private environmentReason(): string | undefined {
    if (!offscreenEnvironmentSupported()) return "当前浏览器不支持后台画布";
    if (this.deps.renderer.isWebGLRenderer !== true) return "后台渲染当前仅支持 WebGL 渲染器";
    return undefined;
  }

  private async launchWorker(inventory: OffscreenSceneInventory): Promise<void> {
    const snapshot: OffscreenSnapshot = await snapshotOffscreenScene(this.deps.scene, inventory, new AbortController().signal);
    if (this.disposed || this.status.mode === "off" || this.status.mode === "fallback") {
      closeOffscreenImages(snapshot.images); return;
    }
    const worker = this.deps.createWorker?.() ?? new Worker(new URL("./offscreenScene.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<OffscreenResponse>) => this.handleResponse(worker, event.data);
    worker.onerror = () => this.handleFailure(worker, "后台渲染线程异常");
    const canvas = new OffscreenCanvas(2, 2);
    const request: OffscreenRequest = { type: "init", canvas, snapshot, frame: this.collector.collect(this.renderContext(), inventory, ++this.sequence) };
    worker.postMessage(request, [canvas, ...transferablesOf(snapshot)]);
    this.inventory = inventory;
    this.worker = worker;
    this.ensureOverlay();
    this.status = { mode: "active", frames: this.status.frames, restarts: this.status.restarts };
    syncGlobalStatus();
  }

  private renderContext(): OffscreenContext {
    return {
      scene: this.deps.scene,
      camera: this.deps.camera,
      renderer: this.deps.renderer as unknown as OffscreenContext["renderer"],
      width: Math.max(this.deps.container.clientWidth, 1),
      height: Math.max(this.deps.container.clientHeight, 1),
      delta: 0,
      postProcessing: this.postProcessingStub,
      outlined: [],
    };
  }

  private postProcessingStub = { enabled: false } as unknown as ScenePostProcessingState;

  /** 每个渲染帧由 Runtime 调用；主线程只做增量收集与发送，绘制在 Worker 内完成。 */
  postFrame(input: { width: number; height: number; delta: number; postProcessing: ScenePostProcessingState; outlined: string[] }): void {
    const inventory = this.inventory;
    if (!this.worker || !inventory || this.status.mode !== "active") return;
    const context: OffscreenContext = { ...this.renderContext(), ...input };
    const frame = this.collector.collect(context, inventory, ++this.sequence, this.shouldCollectMaterials());
    const merged = this.pendingFrame ? mergeOffscreenFrames(this.pendingFrame, frame) : frame;
    this.pendingFrame = undefined;
    this.worker.postMessage({ type: "frame", frame: merged } satisfies OffscreenRequest);
  }

  private shouldCollectMaterials(): boolean {
    let changed = this.materialVersions.size === 0;
    let sum = 0;
    for (const material of this.inventory?.materials.values() ?? []) {
      sum += material.version;
      if (this.materialVersions.get(material.uuid) !== material.version) changed = true;
    }
    if (changed) {
      this.materialVersions.clear();
      for (const material of this.inventory?.materials.values() ?? []) this.materialVersions.set(material.uuid, material.version);
    }
    if (changed || this.framesSinceMaterialCollect >= MATERIAL_FULL_COLLECT_FRAMES) {
      this.framesSinceMaterialCollect = 0;
      return true;
    }
    this.framesSinceMaterialCollect += 1;
    return false;
  }

  private handleResponse(worker: Worker, response: OffscreenResponse): void {
    if (worker !== this.worker || this.disposed) return;
    if (response.type === "ready") return;
    if (response.type === "error") return this.handleFailure(worker, response.reason);
    this.status = {
      ...this.status,
      mode: "active",
      frames: this.status.frames + 1,
      lastRenderMs: Math.round(response.renderMs * 10) / 10,
      lastDrawCalls: response.drawCalls,
      lastTriangles: response.triangles,
    };
    try {
      if (this.deps.paintBitmap) this.deps.paintBitmap(response.bitmap);
      else this.paintToOverlay(response.bitmap);
    } finally {
      response.bitmap.close();
    }
  }

  private paintToOverlay(bitmap: ImageBitmap): void {
    const context = this.overlayContext;
    if (!context) return;
    if (context.canvas.width !== bitmap.width || context.canvas.height !== bitmap.height) {
      context.canvas.width = bitmap.width;
      context.canvas.height = bitmap.height;
    }
    context.drawImage(bitmap, 0, 0);
    this.paintOverlaySprites(context);
  }

  /** 标注/告警标签主线程补绘:世界坐标投影到像素,尺寸由相机右/上向量换算。 */
  private paintOverlaySprites(context: CanvasRenderingContext2D): void {
    const sprites = this.deps.overlaySprites?.() ?? [];
    if (!sprites.length) return;
    const camera = this.deps.camera;
    const canvasWidth = context.canvas.width;
    const canvasHeight = context.canvas.height;
    const center = new THREE.Vector3();
    const offset = new THREE.Vector3();
    const rightAxis = new THREE.Vector3();
    const upAxis = new THREE.Vector3();
    for (const sprite of sprites) {
      const map = sprite.material.map;
      if (!sprite.visible || !map?.image) continue;
      const source = map.image as { width?: number; height?: number };
      if (!source.width || !source.height) continue;
      rightAxis.setFromMatrixColumn(camera.matrixWorld, 0);
      upAxis.setFromMatrixColumn(camera.matrixWorld, 1);
      center.setFromMatrixPosition(sprite.matrixWorld);
      const screen = center.clone().project(camera);
      if (screen.z < -1 || screen.z > 1) continue;
      const cx = (screen.x * 0.5 + 0.5) * canvasWidth;
      const cy = (1 - (screen.y * 0.5 + 0.5)) * canvasHeight;
      offset.copy(center).addScaledVector(rightAxis, sprite.scale.x / 2).project(camera);
      const width = Math.abs((offset.x * 0.5 + 0.5) * canvasWidth - cx) * 2;
      offset.copy(center).addScaledVector(upAxis, sprite.scale.y / 2).project(camera);
      const height = Math.abs((1 - (offset.y * 0.5 + 0.5)) * canvasHeight - cy) * 2;
      if (width < 2 || height < 1) continue;
      context.globalAlpha = sprite.material.opacity;
      context.drawImage(map.image as CanvasImageSource, cx - width / 2, cy - height / 2, width, height);
      context.globalAlpha = 1;
    }
  }

  private handleFailure(worker: Worker, reason: string): void {
    if (worker !== this.worker || this.disposed) return;
    this.teardownWorker();
    if (reason === "scene-stale") return void this.scheduleRestart("场景已变化");
    // worker 的原因已是可读中文,直接透传给设置页与诊断。
    this.fallback(reason);
  }

  /** 结构漂移后的静默重启；预算内自动重建，超预算说明场景变化过于频繁，回退主线程。 */
  private async scheduleRestart(_trigger: string): Promise<void> {
    if (this.restartPending || this.disposed) return;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((value) => now - value < RESTART_WINDOW_MS);
    if (this.restartTimestamps.length >= RESTART_LIMIT) {
      this.fallback("场景变化过于频繁，已恢复主线程渲染");
      return;
    }
    this.restartTimestamps.push(now);
    this.restartPending = true;
    this.status = { ...this.status, restarts: this.status.restarts + 1 };
    try {
      const inventory = inspectOffscreenScene(this.deps.scene);
      if (inventory.reason) {
        this.fallback(inventory.reason);
        return;
      }
      await this.launchWorker(inventory);
    } catch {
      this.fallback("后台渲染重启失败，已恢复主线程渲染");
    } finally {
      this.restartPending = false;
    }
  }

  private async recheckCompatibility(): Promise<void> {
    if (this.status.mode !== "active" || this.restartPending || !this.worker) return;
    const inventory = inspectOffscreenScene(this.deps.scene);
    if (!inventory.reason && inventory.signature === this.inventory?.signature) return;
    this.teardownWorker();
    if (inventory.reason) {
      this.fallback(inventory.reason);
      return;
    }
    await this.scheduleRestart("场景结构已更新");
  }

  private ensureOverlay(): void {
    if (this.overlay) return;
    if (this.deps.paintBitmap) return;
    const overlay = this.deps.container.ownerDocument.createElement("canvas");
    overlay.dataset.offscreenOverlay = "true";
    overlay.setAttribute("aria-hidden", "true");
    const style = overlay.style;
    style.position = "absolute";
    style.inset = "0";
    style.width = "100%";
    style.height = "100%";
    style.pointerEvents = "none";
    const containerStyle = window.getComputedStyle(this.deps.container);
    if (containerStyle.position === "static") {
      this.restoredPosition = this.deps.container.style.position;
      this.deps.container.style.position = "relative";
    }
    this.deps.container.append(overlay);
    const context = overlay.getContext("2d");
    if (!context) {
      overlay.remove();
      this.fallback("浏览器不支持画布回传");
      return;
    }
    this.overlay = overlay;
    this.overlayContext = context;
  }

  private fallback(reason: string): void {
    this.teardownWorker();
    this.status = { mode: "fallback", reason, frames: this.status.frames, restarts: this.status.restarts };
    syncGlobalStatus();
    this.deps.requestRender();
  }

  private stop(): void {
    this.teardownWorker();
    this.pendingFrame = undefined;
    this.inventory = undefined;
    this.collector = new OffscreenFrameCollector();
    this.materialVersions.clear();
    this.restartTimestamps = [];
    if (this.status.mode !== "off") this.status = { mode: "off", frames: 0, restarts: 0 };
    syncGlobalStatus();
    this.deps.requestRender();
  }

  private teardownWorker(): void {
    this.worker?.postMessage({ type: "dispose" } satisfies OffscreenRequest);
    this.worker?.terminate();
    this.worker = undefined;
    this.pendingFrame = undefined;
    this.overlay?.remove();
    this.overlay = undefined;
    this.overlayContext = undefined;
    if (this.restoredPosition !== undefined) {
      this.deps.container.style.position = this.restoredPosition;
      this.restoredPosition = undefined;
    }
  }
}

function transferablesOf(snapshot: OffscreenSnapshot): Transferable[] {
  const result: Transferable[] = [];
  for (const image of snapshot.images) {
    if (image.bitmap) result.push(image.bitmap as unknown as Transferable);
    else if (image.pixels) result.push(image.pixels.data.buffer as ArrayBuffer);
  }
  return result;
}
