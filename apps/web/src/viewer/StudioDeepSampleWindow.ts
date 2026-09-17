import { createSampleWindow, type ChannelSample, type SampleWindow } from "@bim-studio/deep-engine";

const SAMPLE_LIMIT = 600;

interface RawGpuSamples {
  samples(stage: "gpu-frame"): readonly number[];
}

/** Owns the browser-side A03 window. rAF is presentation feedback, not scan-out completion. */
export class StudioDeepSampleWindow {
  private windowStartMs: number;
  private readonly cpuSubmitMs: number[] = [];
  private readonly presentFeedbackMs: number[] = [];
  private readonly frameIntervalMs: number[] = [];
  private readonly inputLatencyMs: number[] = [];
  private pendingSubmissionAt: number | undefined;
  private pendingInputs: number[] = [];
  private lastPresentationAt: number | undefined;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.windowStartMs = this.now();
  }

  recordSubmission(cpuSubmitMs: number, submittedAt = this.now()): void {
    pushBounded(this.cpuSubmitMs, cpuSubmitMs);
    this.pendingSubmissionAt = submittedAt;
  }

  recordInput(inputAt = this.now()): void {
    if (inputAt < this.windowStartMs) return;
    this.pendingInputs.push(inputAt);
    if (this.pendingInputs.length > SAMPLE_LIMIT) this.pendingInputs.shift();
  }

  recordPresentationFeedback(feedbackAt = this.now()): void {
    if (this.pendingSubmissionAt !== undefined) {
      const duration = feedbackAt - this.pendingSubmissionAt;
      if (duration >= 0) pushBounded(this.presentFeedbackMs, duration);
    }
    if (this.lastPresentationAt !== undefined) {
      const interval = feedbackAt - this.lastPresentationAt;
      if (interval > 0) pushBounded(this.frameIntervalMs, interval);
    }
    for (const inputAt of this.pendingInputs) {
      const duration = feedbackAt - inputAt;
      if (duration >= 0) pushBounded(this.inputLatencyMs, duration);
    }
    this.pendingSubmissionAt = undefined;
    this.pendingInputs = [];
    this.lastPresentationAt = feedbackAt;
  }

  pause(): void {
    this.pendingSubmissionAt = undefined;
    this.pendingInputs = [];
    this.lastPresentationAt = undefined;
  }

  reset(): void {
    this.cpuSubmitMs.length = 0;
    this.presentFeedbackMs.length = 0;
    this.frameIntervalMs.length = 0;
    this.inputLatencyMs.length = 0;
    this.pause();
    this.windowStartMs = this.now();
  }

  snapshot(runId: string, gpu?: RawGpuSamples, gpuUnavailableReason = "gpu_raw_samples_not_available"): SampleWindow {
    const end = Math.max(this.now(), this.windowStartMs + Number.EPSILON);
    const channel = (name: ChannelSample["channel"], clockId: ChannelSample["clockId"], samples: readonly number[], reason: string): ChannelSample =>
      samples.length
        ? { channel: name, clockId, samplesMs: [...samples], sampleCount: samples.length,
            windowStartMs: this.windowStartMs, windowEndMs: end, availability: "measured" }
        : { channel: name, clockId, samplesMs: [], sampleCount: 0,
            windowStartMs: this.windowStartMs, windowEndMs: end, availability: "unavailable", unavailableReason: reason };
    return createSampleWindow({
      schema: "deep-engine.benchmark-sample-window", schemaVersion: 1, runId,
      clockId: "performance-now", windowStartMs: this.windowStartMs, windowEndMs: end,
      channels: [
        channel("authoring-bridge", "performance-now", [], "authoring_bridge_boundary_not_instrumented"),
        channel("scene-update", "performance-now", [], "scene_update_boundary_not_isolated_from_sync"),
        channel("upload", "performance-now", [], "upload_boundary_not_exposed_by_web_runtime"),
        channel("cpu-submit", "performance-now", this.cpuSubmitMs, "no_cpu_submit_samples_in_window"),
        channel("gpu-timestamp", "gpu-timestamp", gpu?.samples("gpu-frame") ?? [],
          gpu ? "no_gpu_timestamp_samples_in_window" : gpuUnavailableReason),
        channel("present", "frame-callback", this.presentFeedbackMs, "no_browser_presentation_feedback_in_window"),
        channel("frame-interval", "frame-callback", this.frameIntervalMs, "fewer_than_two_presentation_callbacks_in_window"),
        channel("input-latency", "performance-now", this.inputLatencyMs, "no_input_event_reached_a_presentation_callback"),
      ],
    });
  }
}

function pushBounded(target: number[], value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  target.push(value);
  if (target.length > SAMPLE_LIMIT) target.shift();
}
