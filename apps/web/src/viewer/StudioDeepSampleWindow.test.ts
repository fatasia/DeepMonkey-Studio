import { describe, expect, it } from "vitest";
import { validateSampleWindow } from "@bim-studio/deep-engine";
import { StudioDeepSampleWindow } from "./StudioDeepSampleWindow";

describe("Studio Deep A03 sample window", () => {
  it("records raw submit, GPU, presentation, frame interval and input-to-feedback samples", () => {
    let now = 100;
    const recorder = new StudioDeepSampleWindow(() => now);
    recorder.recordInput(103);
    recorder.recordSubmission(2.5, 105);
    recorder.recordPresentationFeedback(112);
    recorder.recordSubmission(3, 120);
    recorder.recordPresentationFeedback(128);
    now = 140;
    const result = recorder.snapshot("studio-a03", { samples: () => [4, 6] });
    expect(validateSampleWindow(result)).toEqual([]);
    expect(result.channels.find(entry => entry.channel === "cpu-submit")?.samplesMs).toEqual([2.5, 3]);
    expect(result.channels.find(entry => entry.channel === "gpu-timestamp")?.samplesMs).toEqual([4, 6]);
    expect(result.channels.find(entry => entry.channel === "present")?.samplesMs).toEqual([7, 8]);
    expect(result.channels.find(entry => entry.channel === "frame-interval")?.samplesMs).toEqual([16]);
    expect(result.channels.find(entry => entry.channel === "input-latency")?.samplesMs).toEqual([9]);
  });

  it("reports unsupported and empty channels as unavailable without fake zeros", () => {
    let now = 10;
    const recorder = new StudioDeepSampleWindow(() => now);
    now = 20;
    const result = recorder.snapshot("empty");
    expect(validateSampleWindow(result)).toEqual([]);
    expect(result.channels).toHaveLength(8);
    for (const channel of result.channels) {
      expect(channel).toMatchObject({ availability: "unavailable", samplesMs: [], sampleCount: 0 });
      expect(channel.unavailableReason).toBeTruthy();
    }
  });

  it("cuts pending inputs and intervals at pause/reset boundaries", () => {
    let now = 0;
    const recorder = new StudioDeepSampleWindow(() => now);
    recorder.recordInput(1); recorder.recordSubmission(1, 2); recorder.pause();
    recorder.recordSubmission(2, 10); recorder.recordPresentationFeedback(12);
    now = 13;
    expect(recorder.snapshot("paused").channels.find(entry => entry.channel === "input-latency")?.availability).toBe("unavailable");
    recorder.reset(); now = 30;
    const reset = recorder.snapshot("reset");
    expect(reset.channels.every(entry => entry.sampleCount === 0)).toBe(true);
  });
});
