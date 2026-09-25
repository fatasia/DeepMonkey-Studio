import type { EnginePerformanceTelemetrySnapshot, FrameMetrics } from "@bim-studio/deep-engine/webgpu";
import { FramePerformanceMonitor, type HeapSnapshot, type FramePerformanceSnapshot } from "./framePerformanceMonitor";
import type { MainThreadLongTaskSnapshot } from "./mainThreadLongTaskMonitor";
import type { PresentationPerformanceSource } from "./viewerPresentationPerformance";
import { StudioDeepSampleWindow } from "./StudioDeepSampleWindow";

interface DeepDiagnostics {
  setDiagnosticsSampling?(enabled: boolean): void;
  readonly gpuTimer?: { readonly supported: boolean };
  readonly performanceTelemetry?: { snapshot(): EnginePerformanceTelemetrySnapshot; reset(): void;
    samples?(stage: "gpu-frame"): readonly number[] };
}

export interface StudioDeepRuntimeDiagnostics {
  readonly probeClipmap?: {
    readonly requested: boolean; readonly active: boolean;
    readonly radianceSource: "scene" | "unavailable"; readonly pending: boolean;
    readonly packetRevision: number; readonly sceneInstanceCount: number;
    readonly capture?: { readonly frame: number; readonly updates: number;
      readonly committedBatches: number; readonly committedUpdates: number };
    readonly failure?: string;
  };
}

/** Samples only submitted Deep frames. Missing per-kind GPU counts remain unavailable. */
export class StudioDeepPerformance implements PresentationPerformanceSource {
  private readonly monitor = new FramePerformanceMonitor();
  private frame: FrameMetrics | undefined;
  private pixelRatio = 1;
  private timingEnabled = false;
  private pendingFrame: number | undefined;
  private pendingTicket: object | undefined;
  private closed = false;
  private diagnosticsSource: (() => StudioDeepRuntimeDiagnostics | undefined) | undefined;
  private readonly samples = new StudioDeepSampleWindow();
  private readonly inputEvents = ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup", "input", "change", "click"];
  private readonly inputObserved = () => this.samples.recordInput();
  private readonly visibilityChanged = () => { if (document.visibilityState === "hidden") this.pause(); };
  constructor(private readonly runtime: DeepDiagnostics) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.visibilityChanged);
    if (typeof window !== "undefined") for (const event of this.inputEvents) window.addEventListener(event, this.inputObserved, { capture: true, passive: true });
  }

  record(frame: FrameMetrics, cssWidth: number, visible: boolean): void {
    if (this.closed) return;
    this.frame = { ...frame };
    this.pixelRatio = cssWidth > 0 ? frame.width / cssWidth : 1;
    if (!visible) { this.pause(); return; }
    this.samples.recordSubmission(frame.cpuSubmitMs);
    if (this.pendingFrame !== undefined) return;
    const ticket = {}; this.pendingTicket = ticket;
    // Multiple queue submissions in one display interval are not multiple presented frames.
    this.pendingFrame = requestAnimationFrame(timestamp => {
      if (this.closed || this.pendingTicket !== ticket) return;
      this.pendingFrame = undefined; this.pendingTicket = undefined;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") { this.pause(); return; }
      this.samples.recordPresentationFeedback();
      this.monitor.recordFrame(timestamp);
    });
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.visibilityChanged);
    if (typeof window !== "undefined") for (const event of this.inputEvents) window.removeEventListener(event, this.inputObserved, { capture: true });
    this.setGpuTimingEnabled(false); this.pause();
  }
  setDiagnosticsSource(source: (() => StudioDeepRuntimeDiagnostics | undefined) | undefined): void {
    this.diagnosticsSource = source;
  }
  pause(): void {
    if (this.pendingFrame !== undefined) cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = undefined; this.pendingTicket = undefined;
    this.samples.pause();
    this.monitor.pauseSampling();
  }
  reset(): void { this.pause(); this.monitor.reset(); this.samples.reset(); this.runtime.performanceTelemetry?.reset(); }
  setGpuTimingEnabled(enabled: boolean): void {
    if (enabled && !this.timingEnabled) this.runtime.performanceTelemetry?.reset();
    this.timingEnabled = enabled;
    this.runtime.setDiagnosticsSampling?.(enabled);
  }
  sampleWindow(runId: string) {
    const telemetry = this.runtime.performanceTelemetry;
    const gpu = this.runtime.gpuTimer?.supported && telemetry?.samples
      ? { samples: (stage: "gpu-frame") => telemetry.samples!(stage) }
      : undefined;
    return this.samples.snapshot(runId, gpu,
      this.runtime.gpuTimer?.supported ? "gpu_raw_samples_not_available" : "timestamp_query_not_supported");
  }
  snapshot(heap?: HeapSnapshot, mainThread?: MainThreadLongTaskSnapshot): FramePerformanceSnapshot {
    const frame = this.frame;
    const snapshot = this.monitor.snapshot({ backend: "webgpu", drawCalls: frame?.drawCalls ?? 0,
      triangles: frame?.triangles ?? 0, points: 0, lines: 0,
      viewportPixels: frame ? frame.width * frame.height : 0, pixelRatio: this.pixelRatio,
      activeFeatures: ["deep-webgpu", ...(frame?.postProcessPasses ? ["post-processing"] : []),
        ...(frame?.weightedOit ? ["weighted-oit"] : []), ...(frame?.occlusionCulling ? ["occlusion-culling"] : []),
        ...(frame && !frame.shadowUpdated ? ["cached-shadows"] : [])] }, heap, mainThread);
    const timings = this.runtime.performanceTelemetry?.snapshot();
    const gpu = timings?.stages["gpu-frame"];
    const diagnostics = this.diagnosticsSource?.();
    return { ...snapshot, ...(frame ? { deep: { frame: { ...frame }, ...(timings ? { timings } : {}),
      ...(diagnostics ? { diagnostics } : {}) } } : {}),
      ...(this.runtime.gpuTimer?.supported ? { gpuFrameTime: { supported: true, sampleCount: gpu?.samples ?? 0,
        p50Ms: gpu?.p50Ms ?? 0, p95Ms: gpu?.p95Ms ?? 0, maximumMs: gpu?.maximumMs ?? 0 } } : {}) };
  }
}
