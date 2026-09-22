import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";
import {
  ProbeClipmapPbrController, type ProbeClipmapPbrTarget,
} from "../webgpu/probeClipmapPbrController.js";

let nextDeviceEpoch = 1;

type ControllerFactory = (target: ProbeClipmapPbrTarget, deviceEpoch: string) => ProbeClipmapPbrController;

export interface DeepWebGpuProbeClipmapDiagnostics {
  readonly requested: boolean;
  readonly active: boolean;
  /** `unavailable` fails closed: Studio keeps the renderer's existing IBL instead of publishing fallback probes. */
  readonly radianceSource: "scene" | "unavailable";
  readonly pending: boolean;
  readonly packetRevision: number;
  readonly sceneInstanceCount: number;
  /** F1 capture statistics from the latest committed batch (absent until one commits). */
  readonly capture?: {
    readonly frame: number;
    readonly updates: number;
    readonly committedBatches: number;
    readonly committedUpdates: number;
  };
  readonly failure?: string;
}

/** Product host for packet surface-cache ingestion and asynchronous probe publication. */
export class DeepWebGpuProbeClipmapSession {
  private controller: ProbeClipmapPbrController | undefined;
  private packet: RenderPacket | undefined;
  private packetRevision = 0;
  private pending: AbortController | undefined;
  private queuedView: RenderView | undefined;
  private disposed = false;
  private requested = false;
  private failureValue: unknown;
  private rejectedFallback = false;
  private updateBudget = 64;

  /**
   * `createController` must install a real scene-radiance encoder. Omitting it is an
   * intentional fail-closed state: the generic probe runtime's constant fallback is
   * useful for isolated SDK validation, but must never replace Studio IBL in production.
   */
  constructor(private readonly target: ProbeClipmapPbrTarget,
    private readonly createController?: ControllerFactory) {}

  get enabled(): boolean { return this.requested; }
  get active(): boolean { return this.controller !== undefined; }
  get failure(): unknown { return this.failureValue; }
  get diagnostics(): DeepWebGpuProbeClipmapDiagnostics {
    const captureStats = (this.controller as { runtime?: { current?: { captureStats?: {
      frame: number; updateCount: number; committedBatchCount: number; committedUpdateCount: number } } } } | undefined)
      ?.runtime?.current?.captureStats;
    return Object.freeze({ requested: this.requested, active: this.active,
      radianceSource: this.createController === undefined || this.rejectedFallback ? "unavailable" : "scene",
      pending: this.pending !== undefined, packetRevision: this.packetRevision,
      sceneInstanceCount: this.packet?.instances.length ?? 0,
      ...(captureStats ? { capture: Object.freeze({ frame: captureStats.frame,
        updates: captureStats.updateCount, committedBatches: captureStats.committedBatchCount,
        committedUpdates: captureStats.committedUpdateCount }) } : {}),
      ...(this.failureValue === undefined ? {} : { failure: errorMessage(this.failureValue) }) });
  }
  setUpdateBudget(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new RangeError("Probe update budget must be an integer in [1,64].");
    this.updateBudget = value;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.requested) return;
    this.requested = enabled;
    if (!enabled) {
      this.deactivate();
      this.failureValue = undefined;
      this.rejectedFallback = false;
      return;
    }
    this.failureValue = undefined;
    this.rejectedFallback = false;
    this.activateForPacket();
  }

  syncPacket(packet: RenderPacket): void {
    if (this.disposed) return;
    this.packet = packet;
    this.packetRevision++;
    if (!packet.instances.length) {
      this.deactivate();
      return;
    }
    if (!this.activateForPacket()) {
      this.controller?.syncRenderPacket({ packet, revision: this.packetRevision });
    }
  }

  beginFrame(view: RenderView): void {
    if (this.disposed || !this.controller || !this.packet) return;
    const snapshot = snapshotView(view);
    if (this.pending) { this.queuedView = snapshot; return; }
    this.submit(snapshot);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requested = false;
    this.deactivate();
    this.packet = undefined;
  }

  private activateForPacket(): boolean {
    if (!this.requested || this.controller || this.rejectedFallback
      || !this.packet?.instances.length || !this.createController) return false;
    const controller = this.createController(this.target, `studio-deep-${nextDeviceEpoch++}`);
    if (controller.radianceSource !== "scene") {
      controller.dispose();
      this.rejectedFallback = true;
      this.failureValue = new Error("Studio probe GI requires a real scene-radiance encoder.");
      return false;
    }
    try {
      controller.syncRenderPacket({ packet: this.packet, revision: this.packetRevision });
      this.controller = controller;
      return true;
    } catch (error) {
      controller.dispose();
      this.failureValue = error;
      throw error;
    }
  }

  private deactivate(): void {
    this.pending?.abort();
    this.pending = undefined;
    this.queuedView = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  }

  private submit(view: RenderView): void {
    const controller = this.controller;
    if (!controller) return;
    const pending = new AbortController();
    this.pending = pending;
    void controller.beginFrame({
      viewport: [Math.max(1, Math.round(view.width * view.pixelRatio)),
        Math.max(1, Math.round(view.height * view.pixelRatio))],
      cameraPosition: [...view.eye],
      sceneBounds: controller.sceneBounds,
      updateBudget: this.updateBudget,
    }, pending.signal).then(result => {
      if (pending.signal.aborted || this.pending !== pending || this.controller !== controller) return;
      if (result.status === "failed") this.failureValue = result.error;
      else if (result.status === "committed") this.failureValue = undefined;
    }).catch(error => { if (!pending.signal.aborted) this.failureValue = error; }).finally(() => {
      if (this.pending !== pending) return;
      this.pending = undefined;
      const queued = this.queuedView;
      this.queuedView = undefined;
      if (queued && !this.disposed && this.controller === controller) this.submit(queued);
    });
  }
}

function snapshotView(view: RenderView): RenderView {
  return { ...view, eye: [...view.eye], target: [...view.target], ...(view.up ? { up: [...view.up] } : {}) };
}
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value); }
