import { describe, expect, it } from "vitest";
import { FramePerformanceMonitor, type RendererLoadSnapshot } from "./framePerformanceMonitor";

const quietRenderer: RendererLoadSnapshot = {
  backend: "webgl",
  drawCalls: 120,
  triangles: 800_000,
  points: 0,
  lines: 20,
  geometries: 240,
  sharedPrimitiveGeometries: 6,
  textures: 80,
  programs: 14,
  viewportPixels: 3_686_400,
  pixelRatio: 1,
  activeFeatures: []
};

describe("FramePerformanceMonitor", () => {
  it("保留有效帧样本且不把按需休眠误判为掉帧", () => {
    const monitor = new FramePerformanceMonitor();
    monitor.recordFrame(0); monitor.recordFrame(16);
    monitor.pauseSampling(); monitor.recordFrame(900); monitor.recordFrame(916);
    const result = monitor.snapshot(quietRenderer);
    expect(result.sampleCount).toBe(2);
    expect(result.frameTimeMs.p95).toBe(16);
    expect(result.pressureSignals).toEqual([]);
  });
  it("计算帧时间分位数和掉帧比例", () => {
    const monitor = new FramePerformanceMonitor();
    [0, 16, 32, 48, 88, 148].forEach((timestamp) => monitor.recordFrame(timestamp));

    const result = monitor.snapshot(quietRenderer);

    expect(result.sampleCount).toBe(5);
    expect(result.frameTimeMs).toEqual({ p50: 16, p95: 60, p99: 60, maximum: 60 });
    expect(result.over33msRate).toBe(0.4);
    expect(result.over50msRate).toBe(0.2);
    expect(result.pressureSignals[0]?.code).toBe("frame-budget");
  });

  it("忽略后台标签页或系统休眠造成的采样空洞", () => {
    const monitor = new FramePerformanceMonitor();
    monitor.recordFrame(0);
    monitor.recordFrame(16);
    monitor.recordFrame(3_000);
    monitor.recordFrame(3_016, false);
    monitor.recordFrame(3_032);

    const result = monitor.snapshot(quietRenderer);

    expect(result.sampleCount).toBe(2);
    expect(result.frameTimeMs.p95).toBe(16);
    expect(result.ignoredBackgroundFrames).toBe(2);
  });

  it("基于可观测渲染负载给出诊断线索", () => {
    const monitor = new FramePerformanceMonitor();
    monitor.recordFrame(0);
    monitor.recordFrame(40);
    const renderer: RendererLoadSnapshot = {
      ...quietRenderer,
      drawCalls: 2_100,
      triangles: 11_000_000,
      textures: 1_600,
      viewportPixels: 9_000_000,
      pixelRatio: 2
    };

    const result = monitor.snapshot(
      renderer,
      { usedBytes: 950, totalBytes: 980, limitBytes: 1_000 },
      { supported: true, count: 3, totalDurationMs: 320, blockingTimeMs: 170, maximumDurationMs: 140, windowMs: 10_000 },
    );

    expect(result.pressureSignals.map((signal) => signal.code)).toEqual([
      "frame-budget",
      "draw-calls",
      "geometry-load",
      "texture-load",
      "fill-rate",
      "heap-pressure",
      "main-thread"
    ]);
    expect(result.pressureSignals.every((signal) => signal.evidence.length > 0)).toBe(true);
  });
});
