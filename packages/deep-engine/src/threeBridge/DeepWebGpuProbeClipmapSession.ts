import type { RenderPacket } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRenderer.js";
import {
  ProbeClipmapPbrController, type ProbeClipmapPbrTarget,
} from "../webgpu/probeClipmapPbrController.js";

let nextDeviceEpoch = 1;

type ControllerFactory = (target: ProbeClipmapPbrTarget, deviceEpoch: string) => ProbeClipmapPbrController;

/** F5-L4: capture-tick outcome for hosts that pump probe capture independently of rendered frames. */
export type ProbeCaptureTickResult = "idle" | "busy" | "submitted" | "unavailable";

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
  /** Last submitted view snapshot, reused verbatim by `captureTick` (no per-tick allocation). */
  private lastView: RenderView | undefined;

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

  /**
   * 诊断读回:已发布 GI 体积的 rgba16float 全量快照。每 texel = 一探针
   * (rgb = 过滤后 irradiance,a = validity),layer = localZ + level × gridSizeZ。
   * 仅供宿主诊断/测试对拍(GI 漏光排查),不在渲染路径上。
   */
  async readbackVolume(): Promise<{ width: number; height: number; layers: number; rgba16: Uint16Array }> {
    const binding = this.controller?.current?.binding;
    if (!binding) throw new Error("Probe volume readback requires an active probe session with a published volume.");
    const device = (this.target as { session: { device: GPUDevice } }).session.device;
    const texture = binding.texture;
    const width = texture.width, height = texture.height, layers = texture.depthOrArrayLayers;
    const bytesPerTexel = 8;
    const bytesPerRow = Math.ceil(width * bytesPerTexel / 256) * 256;
    const buffer = device.createBuffer({ label: "Deep probe volume readback", size: bytesPerRow * height * layers,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let encoder: GPUCommandEncoder | undefined;
    try {
      encoder = device.createCommandEncoder({ label: "Deep probe volume readback" });
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: layers });
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buffer.getMappedRange());
      // 去除每行 copy 填充,压平为 rgba16 texel 序(x 逐列,y 逐行,z 逐层)。
      const rgba16 = new Uint16Array(width * height * layers * 4);
      for (let z = 0; z < layers; z += 1) for (let y = 0; y < height; y += 1) {
        const rowStart = z * bytesPerRow * height + y * bytesPerRow;
        const src = new Uint16Array(raw.buffer, raw.byteOffset + rowStart, width * 4);
        rgba16.set(src, (z * height * width + y * width) * 4);
      }
      buffer.unmap();
      return { width, height, layers, rgba16 };
    } finally {
      buffer.destroy();
      void encoder;
    }
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
    // A capture already in flight belongs to the previous packet. Do not let it publish
    // after the scene-radiance producer and surface cache have switched to this one.
    this.pending?.abort();
    this.pending = undefined;
    this.queuedView = undefined;
    this.packet = packet;
    this.packetRevision++;
    if (!packet.instances.length) {
      this.deactivate();
      return;
    }
    if (!this.activateForPacket()) {
      try { this.controller?.syncRenderPacket({ packet, revision: this.packetRevision }); }
      catch (error) {
        this.deactivate();
        this.failureValue = error;
        throw error;
      }
    }
  }

  beginFrame(view: RenderView): void {
    if (this.disposed || !this.controller || !this.packet) return;
    const snapshot = snapshotView(view);
    if (this.pending) { this.queuedView = snapshot; return; }
    this.submit(snapshot);
  }

  /**
   * F5-L4 capture pump: advances one serialized capture batch without a rendered frame.
   * Still scenes stop rendering (render demand gate), which used to starve probe capture —
   * the published volume stayed at its initial fill and sampling fell back to full IBL.
   * The tick reuses the last submitted view verbatim (zero per-tick allocation) and the
   * submit path keeps the serialized-batch + updateBudget contract, so this only re-arms
   * the existing scheduler; it never dispatches extra GPU work beyond one budgeted batch.
   */
  captureTick(): ProbeCaptureTickResult {
    if (this.disposed || !this.controller) return "unavailable";
    // A latched failure is persistent for this packet (no radiance source, unavailable
    // scene): stop pumping here. Rendered frames re-arm once per frame via beginFrame,
    // which retries — bounded, never an idle RAF loop.
    if (this.failureValue !== undefined) return "unavailable";
    if (this.pending) return "busy";
    if (!this.lastView) return "unavailable";
    if (!this.hasPendingWork()) return "idle";
    this.submit(this.lastView);
    return "submitted";
  }

  /** True while the clipmap still owes capture work (initial fill, deferred probes, dirty surfaces). */
  hasPendingWork(): boolean {
    if (this.disposed || !this.controller) return false;
    if (this.controller.surfaceCache.pendingCount > 0) return true;
    const snapshot = this.controller.current;
    // No committed frame yet (initial fill), or the last plan deferred candidates.
    return snapshot === undefined || snapshot.frameStats.deferredCount > 0;
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
    this.lastView = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  }

  private submit(view: RenderView): void {
    const controller = this.controller;
    if (!controller) return;
    this.lastView = view;
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
