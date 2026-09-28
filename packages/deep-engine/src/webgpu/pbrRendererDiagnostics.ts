import type { DeviceSession } from "./deviceSession.js";
import { GpuTimer, type GpuTiming } from "./gpuTimer.js";
import type { PbrFramePassTimings } from "./pbrFrameReceipt.js";
import { pbrPassTimingStage } from "./pbrTimedPassIds.js";
import { EnginePerformanceTelemetry } from "./performanceTelemetry.js";

/** Keeps optional diagnostics off the renderer's allocation-sensitive default path. */
export class PbrRendererDiagnostics {
  readonly performance = new EnginePerformanceTelemetry();
  readonly gpuTimer: GpuTimer;
  /** F1 最新完成读回的逐 pass 计时;never modified off the diagnostics callback thread. */
  private latestPassTimingsValue: PbrFramePassTimings | undefined;
  get latestPassTimings(): PbrFramePassTimings | undefined { return this.latestPassTimingsValue; }

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
    if (timing.passes) {
      // F1:发布给 FrameMetrics.gpuPassTimings;同一帧重复读回以后到者为准(读回只发生一次)。
      this.latestPassTimingsValue = Object.freeze({
        frame: timing.frame, availability: "measured", milliseconds: timing.milliseconds,
        passes: timing.passes,
        requestedPassCount: timing.requestedPassCount ?? timing.passes.length,
        measuredPassCount: timing.passes.length,
      });
    }
    try {
      this.performance.record({ frame: timing.frame, timings: {
        "gpu-frame": timing.milliseconds,
        ...(timing.stages ? {
          "gpu-shadow-opaque": timing.stages.shadowOpaqueMs,
          "gpu-intermediate": timing.stages.intermediateMs,
          "gpu-output": timing.stages.outputMs,
        } : {}),
        // F1 逐 pass 阶段:与 ENGINE_TIMING_STAGES 单源清单对齐,诊断窗口内可查 p50/p95。
        ...Object.fromEntries((timing.passes ?? []).map(pass => [pbrPassTimingStage(pass.passId), pass.durationMs])),
      } });
    } catch (error) {
      // 诊断窗口驱逐只丢弃记账;校验类 RangeError/重复样本仍是编程错误,必须炸出来。
      if (!(error instanceof RangeError) || !error.message.includes("evicted")) throw error;
    }
  }
}
