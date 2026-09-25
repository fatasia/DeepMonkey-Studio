import type { DeviceSession } from "./deviceSession.js";
import { GpuTimer, type GpuTiming } from "./gpuTimer.js";
import { EnginePerformanceTelemetry } from "./performanceTelemetry.js";

/** Keeps optional diagnostics off the renderer's allocation-sensitive default path. */
export class PbrRendererDiagnostics {
  readonly performance = new EnginePerformanceTelemetry();
  readonly gpuTimer: GpuTimer;

  constructor(session: DeviceSession) {
    this.gpuTimer = new GpuTimer(session, timing => this.recordGpu(timing));
  }

  setEnabled(enabled: boolean): void {
    this.performance.enabled = enabled;
    this.gpuTimer.enabled = enabled;
  }

  recordFrame(
    frame: number,
    begin: number,
    encoded: number,
    submitted: number,
    presentAcquireMs: number,
  ): void {
    if (!this.performance.enabled) return;
    this.performance.record({
      frame,
      timings: {
        "frame-encode": encoded - begin,
        "queue-submit": submitted - encoded,
        "present-acquire": presentAcquireMs,
      },
    });
  }

  private recordGpu(timing: GpuTiming): void {
    try {
      this.performance.record({ frame: timing.frame, timings: {
        "gpu-frame": timing.milliseconds,
        ...(timing.stages ? {
          "gpu-shadow-opaque": timing.stages.shadowOpaqueMs,
          "gpu-intermediate": timing.stages.intermediateMs,
          "gpu-output": timing.stages.outputMs,
        } : {}),
      } });
    } catch (error) {
      if (!(error instanceof RangeError) || !error.message.includes("evicted")) throw error;
    }
  }
}
