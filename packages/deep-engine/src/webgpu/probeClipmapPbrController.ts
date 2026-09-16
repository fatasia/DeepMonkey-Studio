/// <reference types="@webgpu/types" />
import type { ProbeClipmapLightingBinding } from "../lighting/pbrLightingBindings.js";
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
  private publishedGeneration = -1;
  private disposed = false;

  constructor(private readonly target: ProbeClipmapPbrTarget, deviceEpoch: string,
    options: ProbeClipmapRuntimeOptions = {}) {
    this.runtime = new ProbeClipmapRuntime(target.session, deviceEpoch, options);
  }

  get current(): ProbeClipmapRuntimeSnapshot | undefined { return this.runtime.current; }
  get diagnostics() { return this.runtime.diagnostics; }

  async beginFrame(input: ProbeClipmapRuntimeFrameInput,
    signal?: AbortSignal): Promise<ProbeClipmapRuntimeFrameResult> {
    if (this.disposed) throw new Error("Probe clipmap PBR controller is disposed.");
    const result = await this.runtime.beginFrame(input, signal);
    if (this.disposed || result.status !== "committed" || !result.snapshot
      || result.snapshot.generation <= this.publishedGeneration) return result;
    if (this.target.session.state !== "ready") return result;
    this.target.setProbeClipmap(result.snapshot.binding);
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
