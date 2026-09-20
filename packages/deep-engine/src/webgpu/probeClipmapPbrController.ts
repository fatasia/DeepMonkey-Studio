/// <reference types="@webgpu/types" />
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
}

/** Atomically publishes only committed GI volumes to a PBR renderer. */
export class ProbeClipmapPbrController {
  readonly runtime: ProbeClipmapRuntime;
  readonly surfaceCache = new ProbeSurfaceCache();
  readonly packetSurfaceCache = new ProbeSurfaceCachePacketConsumer(this.surfaceCache);
  private publishedGeneration = -1;
  private disposed = false;

  constructor(private readonly target: ProbeClipmapPbrTarget, deviceEpoch: string,
    options: ProbeClipmapRuntimeOptions = {}) {
    this.runtime = new ProbeClipmapRuntime(target.session, deviceEpoch, options);
  }

  get current(): ProbeClipmapRuntimeSnapshot | undefined { return this.runtime.current; }
  get diagnostics() { return this.runtime.diagnostics; }
  get sceneBounds() { return this.packetSurfaceCache.sceneBounds; }
  upsertSurface(entry: ProbeSurfaceCacheEntry): boolean { return this.surfaceCache.upsert(entry); }
  removeSurface(id: string): boolean { return this.surfaceCache.remove(id); }
  syncRenderPacket(input: ProbeSurfaceCachePacketInput): boolean { return this.packetSurfaceCache.sync(input); }

  async beginFrame(input: ProbeClipmapRuntimeFrameInput,
    signal?: AbortSignal): Promise<ProbeClipmapRuntimeFrameResult> {
    if (this.disposed) throw new Error("Probe clipmap PBR controller is disposed.");
    const surfaceFrame = this.surfaceCache.beginFrame();
    const dirtySource = [...surfaceFrame.dirtyBounds, ...(input.dirtyBounds ?? [])];
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
    this.publishedGeneration = result.snapshot.generation;
    return result;
  }

  setDiagnosticsEnabled(enabled: boolean): void { this.runtime.setDiagnosticsEnabled(enabled); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.target.session.state === "ready") this.target.setProbeClipmap();
    this.runtime.dispose();
  }
}
