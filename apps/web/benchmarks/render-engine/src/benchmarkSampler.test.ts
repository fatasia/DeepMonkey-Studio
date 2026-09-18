import { describe, expect, it } from "vitest";
import { createSampleWindow, validateSampleWindow } from "@bim-studio/deep-engine";
import { aggregateSamples, BenchmarkFrameSampler, percentilePerChartE2e } from "./benchmarkSampler";

function stepClock(start = 1000): () => number {
  let current = start;
  return () => current++;
}

describe("chart_e2e percentile contract", () => {
  it("matches sorted[round(p/100*(n-1))] exactly, including single-sample windows", () => {
    // 与 packages/deep-engine-native/tests/support/chart_e2e_measurements.rs 的 percentile 逐值对齐
    const samples = [3, 1, 4, 1, 5];
    const sorted = [...samples].sort((left, right) => left - right);
    expect(percentilePerChartE2e(sorted, 50)).toBe(3);
    expect(percentilePerChartE2e(sorted, 95)).toBe(5);
    expect(percentilePerChartE2e(sorted, 99)).toBe(5);
    expect(percentilePerChartE2e([7], 95)).toBe(7);
    // 1-based nearest-rank(旧 FrameSampler 口径)会给出不同结果,证明这不是它的复刻:
    // ceil(5*0.5)-1 = 2 → 3(一致),ceil(5*0.95)-1 = 4 → 5(一致),
    // 但 4 样本 p95:round(0.95*3)=3 → 40,nearest-rank ceil(4*0.95)-1=3 → 40;2 样本 p95:
    // round(0.95*1)=1 → 20,nearest-rank ceil(1.9)-1=1 → 20。区分性样例是 3 样本 p95:
    const three = [10, 20, 30];
    expect(percentilePerChartE2e(three, 95)).toBe(30);
    // nearest-rank: ceil(3*0.95)-1 = 2 → 30;再取 p50 的 4 样本偶数情形固定本口径行为:
    expect(percentilePerChartE2e([10, 20, 30, 40], 50)).toBe(30);
  });

  it("aggregates raw samples and refuses empty input instead of emitting zeros", () => {
    expect(aggregateSamples([4, 1, 3])).toEqual({ samples: 3, averageMs: 8 / 3, p50Ms: 3, p95Ms: 4, p99Ms: 4 });
    expect(() => aggregateSamples([])).toThrow(/unavailable/);
  });
});

describe("benchmark frame sampler window", () => {
  it("emits a fixed eight-channel window that passes the v1 contract with raw samples", () => {
    const now = stepClock();
    const sampler = new BenchmarkFrameSampler({
      now,
      gpuTimestamps: () => [1.5, 2.5],
      uploadBytes: () => 1024,
      heapMb: () => 128.5,
    });
    sampler.beginPrepare();
    sampler.endPrepare();
    sampler.recordSubmit(50, 54);
    sampler.recordInput(30);
    sampler.presentationFeedback(60);
    const report = sampler.snapshot("run.slice-a02a03.001");
    expect(validateSampleWindow(report.window)).toEqual([]);
    expect(() => createSampleWindow(report.window)).not.toThrow();
    expect(report.window.channels.map(channel => channel.channel)).toEqual([
      "authoring-bridge", "scene-update", "upload", "cpu-submit",
      "gpu-timestamp", "present", "frame-interval", "input-latency",
    ]);
    const measured = Object.fromEntries(
      report.window.channels.filter(channel => channel.availability === "measured").map(channel => [channel.channel, channel.samplesMs]),
    );
    expect(measured["scene-update"]).toEqual([1]);
    expect(measured["cpu-submit"]).toEqual([4]);
    expect(measured["gpu-timestamp"]).toEqual([1.5, 2.5]);
    expect(measured["present"]).toEqual([6]);
    expect(measured["input-latency"]).toEqual([30]);
    expect(measured["frame-interval"]).toBeUndefined(); // 首个反馈没有上一反馈,不产生间隔样本
    expect(report.aggregates["cpu-submit"]).toMatchObject({ samples: 1, p50Ms: 4 });
    expect(report.resources.uploadBytes).toEqual({ availability: "measured", value: 1024 });
    expect(report.resources.peakJsHeapMb).toEqual({ availability: "measured", value: 128.5 });
  });

  it("keeps unavailable channels honest when GPU timestamps and inputs never arrive", () => {    const now = stepClock();
    const sampler = new BenchmarkFrameSampler({ now }); // 未接 GPU/上传/heap 探针
    sampler.recordSubmit(10, 12);
    sampler.presentationFeedback(20);
    const report = sampler.snapshot("run.degraded.001");
    expect(validateSampleWindow(report.window)).toEqual([]);
    const gpu = report.window.channels.find(channel => channel.channel === "gpu-timestamp")!;
    expect(gpu.availability).toBe("unavailable");
    expect(gpu).toMatchObject({ samplesMs: [], sampleCount: 0 });
    expect(gpu.unavailableReason).toBe("gpu_timestamp_extension_unavailable");
    expect(report.aggregates["gpu-timestamp"]).toBeUndefined();
    expect(report.aggregates["input-latency"]).toBeUndefined();
    expect(report.resources.uploadBytes).toMatchObject({ availability: "unavailable" });
    expect(report.resources.peakJsHeapMb).toMatchObject({ availability: "unavailable" });
    // 交接第 6 节的峰值 RSS 在浏览器宿主恒不可用,且绝不拿 JS heap 冒充
    expect(report.resources.peakRssMb).toEqual({ availability: "unavailable", unavailableReason: "os_rss_not_exposed_to_browser_hosts" });
  });

  it("drops negative pairings, keeps only one present per feedback and partitions by reset", () => {
    const now = stepClock();
    const sampler = new BenchmarkFrameSampler({ now });
    sampler.recordSubmit(100, 90); // 时钟回拨的提交:submit 样本为负,丢弃
    sampler.recordInput(50);
    sampler.presentationFeedback(40); // 反馈早于输入:latency 为负,丢弃
    sampler.recordInput(45);
    sampler.recordSubmit(50, 55);
    sampler.recordSubmit(56, 60); // 同一反馈周期第二次提交:只保留最后一次配对
    sampler.presentationFeedback(80);
    const first = sampler.snapshot("run.pairing.001");
    expect(first.window.channels.find(channel => channel.channel === "cpu-submit")!.samplesMs).toEqual([5, 4]);
    expect(first.window.channels.find(channel => channel.channel === "present")!.samplesMs).toEqual([20]); // 80-60,不是 80-55
    expect(first.window.channels.find(channel => channel.channel === "input-latency")!.samplesMs).toEqual([35]); // 80-45
    sampler.reset();
    const second = sampler.snapshot("run.pairing.002");
    expect(second.window.channels.every(channel => channel.availability === "unavailable" || channel.sampleCount === 0)).toBe(true);
  });

  it("drops pending pairings on pause so blur never fabricates samples", () => {
    const now = stepClock();
    const sampler = new BenchmarkFrameSampler({ now });
    sampler.recordSubmit(10, 12);
    sampler.recordInput(14);
    sampler.pause(); // 失焦/按需暂停:待配对状态作废
    sampler.presentationFeedback(50);
    const report = sampler.snapshot("run.pause.001");
    expect(report.window.channels.find(channel => channel.channel === "present")!.availability).toBe("unavailable");
    expect(report.window.channels.find(channel => channel.channel === "input-latency")!.availability).toBe("unavailable");
    expect(report.window.channels.find(channel => channel.channel === "cpu-submit")!.samplesMs).toEqual([2]); // 已落盘样本保留
  });

  it("is deterministic: the same event sequence yields an identical window payload", () => {
    const replay = () => {
      const now = stepClock();
      const sampler = new BenchmarkFrameSampler({ now, uploadBytes: () => 2048, gpuTimestamps: () => [3] });
      for (let frame = 0; frame < 3; frame += 1) {
        sampler.beginPrepare();
        sampler.endPrepare();
        sampler.recordInput(1000 + frame * 16);
        sampler.recordSubmit(1010 + frame * 16, 1013 + frame * 16);
        sampler.presentationFeedback(1016 + frame * 16);
      }
      return JSON.stringify(sampler.snapshot("run.determinism.001").window);
    };
    expect(replay()).toBe(replay());
  });
});
