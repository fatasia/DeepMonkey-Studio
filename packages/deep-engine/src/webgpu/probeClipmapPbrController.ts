/// <reference types="@webgpu/types" />
import type { PreparedPacket, RenderPacket } from "../renderPacket.js";
import type { ProbeClipmapLightingBinding } from "../lighting/pbrLightingBindings.js";
import {
  MAX_PROBE_SURFACE_FRAME_BOUNDS, ProbeSurfaceCache, compactProbeBounds,
  type ProbeSurfaceCacheEntry,
} from "../lighting/probeSurfaceCache.js";
import {
  ProbeSurfaceCachePacketConsumer, type ProbeSurfaceCachePacketInput,
} from "../lighting/probeSurfaceCachePacket.js";
import type { DeviceSession } from "./deviceSession.js";
import {
  ProbeClipmapRuntime, type ProbeClipmapRuntimeFrameInput, type ProbeClipmapRuntimeFrameResult,
  type ProbeClipmapRuntimeOptions, type ProbeClipmapRuntimeSnapshot,
} from "./probeClipmapRuntime.js";

export interface ProbeClipmapPbrTarget {
  readonly session: DeviceSession;
  setProbeClipmap(binding?: ProbeClipmapLightingBinding): void;
  preparedPacketFor?(packet: RenderPacket): PreparedPacket | undefined;
}

export interface ProbeClipmapPbrControllerOptions extends ProbeClipmapRuntimeOptions {
  /**
   * Scene-radiance scene sync for a real capture producer (F1). Invoked after the surface
   * cache accepted the packet; a throw propagates and fails the whole sync closed so the
   * host keeps IBL instead of capturing a stale or partially valid scene.
   */
  readonly sceneRadianceSync?: (packet: RenderPacket, revision: number) => void;
  /** Live scene/lighting readiness; unavailable captures must not expand a CPU plan. */
  readonly captureUnavailableReason?: () => string | undefined;
}

/** Atomically publishes only committed GI volumes to a PBR renderer. */
export class ProbeClipmapPbrController {
  readonly runtime: ProbeClipmapRuntime;
  readonly surfaceCache = new ProbeSurfaceCache();
  readonly packetSurfaceCache = new ProbeSurfaceCachePacketConsumer(this.surfaceCache);
  private readonly sceneRadianceSync: ProbeClipmapPbrControllerOptions["sceneRadianceSync"];
  private readonly captureReadiness: ProbeClipmapPbrControllerOptions["captureUnavailableReason"];
  private publishedGeneration = -1;
  private captureWasUnavailable = false;
  private disposed = false;
  private readonly createdDevice: GPUDevice;

  constructor(private readonly target: ProbeClipmapPbrTarget, deviceEpoch: string,
    options: ProbeClipmapPbrControllerOptions = {}) {
    this.createdDevice = target.session.device;
    this.runtime = new ProbeClipmapRuntime(target.session, deviceEpoch, options);
    this.sceneRadianceSync = options.sceneRadianceSync;
    this.captureReadiness = options.captureUnavailableReason;
  }

  get current(): ProbeClipmapRuntimeSnapshot | undefined { return this.runtime.current; }
  get radianceSource(): ProbeClipmapRuntime["radianceSource"] { return this.runtime.radianceSource; }
  get diagnostics() { return this.runtime.diagnostics; }
  get sceneBounds() { return this.packetSurfaceCache.sceneBounds; }
  get captureUnavailableReason(): string | undefined { return this.captureReadiness?.(); }
  upsertSurface(entry: ProbeSurfaceCacheEntry): boolean { return this.surfaceCache.upsert(entry); }
  removeSurface(id: string): boolean { return this.surfaceCache.remove(id); }
  syncRenderPacket(input: ProbeSurfaceCachePacketInput): boolean {
    const accepted = this.packetSurfaceCache.sync(input, this.target.preparedPacketFor?.(input.packet));
    if (accepted && this.sceneRadianceSync) this.sceneRadianceSync(input.packet, input.revision);
    if (accepted && this.captureUnavailableReason !== undefined) this.clearUnavailableBinding();
    return accepted;
  }

  async beginFrame(input: ProbeClipmapRuntimeFrameInput,
    signal?: AbortSignal): Promise<ProbeClipmapRuntimeFrameResult> {
    if (this.disposed) throw new Error("Probe clipmap PBR controller is disposed.");
    const unavailable = this.captureUnavailableReason;
    if (unavailable !== undefined) {
      this.clearUnavailableBinding();
      return Object.freeze({ frame: input.frame ?? this.runtime.current?.frame ?? 0,
        status: "failed", error: new Error(unavailable) });
    }
    const surfaceFrame = this.surfaceCache.beginFrame();
    const dirtySource = [...surfaceFrame.dirtyBounds, ...(input.dirtyBounds ?? []),
      ...(this.captureWasUnavailable && input.sceneBounds ? [input.sceneBounds] : [])];
    const dynamicSource = [...surfaceFrame.dynamicBounds, ...(input.dynamicBounds ?? [])];
    const dynamicBudget = dirtySource.length ? MAX_PROBE_SURFACE_FRAME_BOUNDS / 2 : MAX_PROBE_SURFACE_FRAME_BOUNDS;
    const dynamicBounds = compactProbeBounds(dynamicSource, dynamicBudget);
    const dirtyBounds = compactProbeBounds(dirtySource, MAX_PROBE_SURFACE_FRAME_BOUNDS - dynamicBounds.length);
    const result = await this.runtime.beginFrame({ ...input,
      ...(dirtyBounds.length ? { dirtyBounds } : {}),
      ...(dynamicBounds.length ? { dynamicBounds } : {}),
      relocationOccluders: this.surfaceCache.snapshotBounds() }, signal);
    if (this.disposed || result.status !== "committed" || !result.snapshot
      || result.snapshot.generation <= this.publishedGeneration) return result;
    if (this.target.session.state !== "ready") return result;
    this.target.setProbeClipmap(result.snapshot.binding);
    this.surfaceCache.commit(surfaceFrame);
    this.captureWasUnavailable = false;
    this.publishedGeneration = result.snapshot.generation;
    return result;
  }

  setDiagnosticsEnabled(enabled: boolean): void { this.runtime.setDiagnosticsEnabled(enabled); }

  suspendUnavailableCapture(): void {
    if (this.captureUnavailableReason !== undefined) this.clearUnavailableBinding();
  }

  private clearUnavailableBinding(): void {
    this.captureWasUnavailable = true;
    if (this.publishedGeneration < 0) return;
    if (this.target.session.state === "ready" && this.target.session.device === this.createdDevice) this.target.setProbeClipmap();
    this.publishedGeneration = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      // A ready replacement session does not make this old owner publishable.
      if (this.target.session.state === "ready" && this.target.session.device === this.createdDevice) {
        this.target.setProbeClipmap();
      }
    } finally { this.runtime.dispose(); }
  }
}
