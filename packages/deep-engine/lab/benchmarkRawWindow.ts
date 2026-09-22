import { createSampleWindow, type SampleChannel, type SampleWindow } from "@bim-studio/deep-engine";

/** CPU submit includes renderer statistics; render-call remains separately measurable. */
export function benchmarkRawWindow(runId: string, start: number, end: number,
  cpu: readonly number[], gpu: readonly number[]): SampleWindow {
  const channels: SampleChannel[] = ["authoring-bridge", "scene-update", "upload", "cpu-submit",
    "gpu-timestamp", "present", "frame-interval", "input-latency"];
  return createSampleWindow({ schema: "deep-engine.benchmark-sample-window", schemaVersion: 1,
    runId, clockId: "performance-now", windowStartMs: start, windowEndMs: end,
    channels: channels.map(channel => {
      const samples = channel === "cpu-submit" ? cpu : channel === "gpu-timestamp" ? gpu : [];
      return { channel, clockId: channel === "gpu-timestamp" ? "gpu-timestamp" : "performance-now",
        windowStartMs: start, windowEndMs: end, samplesMs: [...samples], sampleCount: samples.length,
        ...(samples.length ? { availability: "measured" as const }
          : { availability: "unavailable" as const,
            unavailableReason: channel === "gpu-timestamp" ? "paired_gpu_timestamps_unavailable_or_disabled"
              : "static_benchmark_does_not_measure_this_channel" }) };
    }),
  });
}
