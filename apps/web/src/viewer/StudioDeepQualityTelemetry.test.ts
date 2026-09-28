import { describe, expect, it } from "vitest";
import { DISABLED_QUALITY_TELEMETRY_SNAPSHOT, type FrameMetrics,
  type PbrFrameExecutionReceipt } from "@bim-studio/deep-engine/webgpu";
import { publishStudioQualityTelemetry, readStudioQualityTelemetry,
  StudioDeepQualityTelemetrySampler } from "./StudioDeepQualityTelemetry";

let frameSeq = 0;
function frameMetrics(overrides: Partial<FrameMetrics> = {}): FrameMetrics {
  frameSeq++;
  return {
    frame: frameSeq, cpuSubmitMs: 1, drawCalls: 10, triangles: 4_000,
    width: 1280, height: 720, resources: 4, shadowUpdated: false, cameraCut: false,
    postProcessPasses: 2, weightedOit: false, hiZMipLevels: 0, occlusionCulling: false,
    frustumCulledBatches: 0, hiZOccludedBatches: 0, lodSelectionBatches: 0, lodIndirectDraws: 0,
    lightCount: 1, lightClusters: 0, shadowTier: "none", shadowDepthBytes: 0,
    ...overrides,
  };
}

function receipt(passes: readonly string[]): PbrFrameExecutionReceipt {
  return { frame: frameSeq, passOrder: passes, executedMappedPassIds: passes, unmappedPassIds: [], samples: [] };
}

describe("StudioDeepQualityTelemetrySampler", () => {
  it("按采样率聚合:窗口内多帧一次落账,记录取窗口最新帧与最新回执", () => {
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 4 }, "balanced", () => undefined);
    expect(sampler.enabled).toBe(true);
    expect(sampler.record(frameMetrics({ frameGraphReceipt: receipt(["a", "b", "c"]) }), 0)).toBe(false);
    expect(sampler.record(frameMetrics({ frame: 2, frameGraphReceipt: receipt(["a"]) }), 10)).toBe(false);
    expect(sampler.record(frameMetrics({ frame: 3, frameGraphReceipt: receipt(["x", "y"]) }), 251)).toBe(true);
    const snapshot = sampler.status().collector;
    expect(snapshot.retainedFrameCount).toBe(1);
    expect(snapshot.frames[0]).toMatchObject({
      frame: 3, passCount: 2, uploadedBytes: 0, visibleInstances: null, activeProfile: "balanced",
    });
  });

  it("上传字节 = chunk 流驻留增量,驱逐收缩不计入", () => {
    let resident = 100;
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 4 }, null, () => resident);
    const staged = () => frameMetrics({ frameGraphReceipt: receipt(["a"]) });
    sampler.record(staged(), 0);
    resident = 400; // +300
    sampler.record(staged(), 10);
    resident = 350; // 收缩,不计
    sampler.record(staged(), 20);
    resident = 550; // +200
    expect(sampler.record(staged(), 251)).toBe(true);
    const status = sampler.status();
    expect(status.collector.frames[0]?.uploadedBytes).toBe(500);
    expect(status.coverage.uploadedBytes).toBe("chunk-stream-residency-delta");
  });

  it("自适应档位变化按转移计数,同档不重复计", () => {
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 4 }, null, () => undefined);
    const at = (level: 0 | 1 | 2 | 3, ms: number) =>
      sampler.record(frameMetrics({ frameGraphReceipt: receipt(["a"]), adaptiveQuality: {
        enabled: true, level, knobs: {}, reason: "ok", explanation: "", changedAtFrame: 0,
      } as unknown as NonNullable<FrameMetrics["adaptiveQuality"]> }), ms);
    at(2, 0); at(3, 10); at(3, 20); at(1, 30);
    sampler.record(frameMetrics({ frameGraphReceipt: receipt(["a"]) }), 251);
    expect(sampler.status().collector.frames[0]?.adaptiveDecisions).toBe(2);
  });

  it("关闭采样(sampleHz<=0)零落账,快照恒等 DISABLED 常量", () => {
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 0 }, "quality", () => 100);
    expect(sampler.enabled).toBe(false);
    for (let index = 0; index < 50; index++) expect(sampler.record(frameMetrics(), index)).toBe(false);
    const status = sampler.status();
    expect(status.collector).toBe(DISABLED_QUALITY_TELEMETRY_SNAPSHOT);
    expect(status.coverage.passCount).toBe("unavailable");
    expect(status.coverage.uploadedBytes).toBe("unavailable");
    expect(status.coverage.visibleInstances).toBe("unavailable");
  });

  it("collectorCapacity 越界值钳制到合法区间,不抛出", () => {
    const low = new StudioDeepQualityTelemetrySampler({ sampleHz: 4, collectorCapacity: 1 }, null, () => undefined);
    expect(low.status().collector.capacity).toBe(16);
    const high = new StudioDeepQualityTelemetrySampler({ sampleHz: 4, collectorCapacity: 99_999 }, null, () => undefined);
    expect(high.status().collector.capacity).toBe(4096);
  });

  it("采集器拒收(重复帧落账)时记录 failure 并停止采样,不把异常抛进渲染帧", () => {
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 4 }, null, () => undefined);
    sampler.record(frameMetrics({ frame: 10, frameGraphReceipt: receipt(["a"]) }), 0);
    expect(sampler.record(frameMetrics({ frame: 11, frameGraphReceipt: receipt(["a"]) }), 251)).toBe(true);
    // 同一帧号再次成为窗口最新帧并落账 → 采集器 fail-closed 拒收(模拟上游计数缺陷)
    expect(sampler.record(frameMetrics({ frame: 11, frameGraphReceipt: receipt(["a"]) }), 252)).toBe(false);
    expect(sampler.record(frameMetrics({ frame: 11, frameGraphReceipt: receipt(["a"]) }), 600)).toBe(true);
    const status = sampler.status();
    expect(status.failure).toBeTruthy();
    expect(status.collector).toBe(DISABLED_QUALITY_TELEMETRY_SNAPSHOT);
    expect(sampler.record(frameMetrics({ frame: 12, frameGraphReceipt: receipt(["a"]) }), 900)).toBe(false);
  });

  it("窗口内无回执帧不落账,coverage 声明缺失口径", () => {
    const sampler = new StudioDeepQualityTelemetrySampler({ sampleHz: 4 }, null, () => undefined);
    sampler.record(frameMetrics(), 0);
    expect(sampler.record(frameMetrics(), 251)).toBe(true);
    const status = sampler.status();
    expect(status.collector.retainedFrameCount).toBe(0);
    expect(status.coverage.passCount).toBe("unavailable");
  });
});

describe("质量遥测模块注册表", () => {
  it("发布/读取/撤销遵循最后写入语义", () => {
    publishStudioQualityTelemetry(undefined);
    expect(readStudioQualityTelemetry()).toBeUndefined();
    const sampler = new StudioDeepQualityTelemetrySampler(undefined, "ultra", () => undefined);
    const status = sampler.status();
    publishStudioQualityTelemetry(status);
    expect(readStudioQualityTelemetry()).toBe(status);
    publishStudioQualityTelemetry(undefined);
    expect(readStudioQualityTelemetry()).toBeUndefined();
  });
});
