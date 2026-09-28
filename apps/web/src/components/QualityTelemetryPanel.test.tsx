import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QualityTelemetryCollector, type QualityTelemetrySnapshot } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { QualityTelemetryPanel } from "./QualityTelemetryPanel";

// 桥模块含 three.js 重依赖;面板测试只消费注册表读取函数,用 hoisted 状态注入。
const state = vi.hoisted(() => ({ status: undefined as StudioQualityTelemetryStatus | undefined }));
vi.mock("../viewer/StudioDeepQualityTelemetry", () => ({
  readStudioQualityTelemetry: () => state.status,
}));

const LOCALE = "zh-CN" as const;

function perfSnapshot(overrides: Partial<FramePerformanceSnapshot> = {}): FramePerformanceSnapshot {
  return {
    sampleCount: 30, sampleWindowMs: 10_000, fps: 59.4,
    frameTimeMs: { p50: 16.7, p95: 24.3, p99: 31, maximum: 40 },
    over33msRate: 0.02, over50msRate: 0, ignoredBackgroundFrames: 0,
    renderer: { backend: "webgpu", drawCalls: 12, triangles: 8_000, points: 0, lines: 0,
      viewportPixels: 921_600, pixelRatio: 1, activeFeatures: [] },
    pressureSignals: [],
    ...overrides,
  };
}

const EMPTY_QUALITY_SNAPSHOT: QualityTelemetrySnapshot = new QualityTelemetryCollector(16, true).snapshot();

function telemetryStatus(overrides: Partial<StudioQualityTelemetryStatus> = {}): StudioQualityTelemetryStatus {
  return {
    sampleHz: 4,
    activeProfile: "quality",
    collector: EMPTY_QUALITY_SNAPSHOT,
    latestMemory: undefined,
    coverage: { passCount: "unavailable", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
    ...overrides,
  };
}

function engine(perf = perfSnapshot()): ViewerEngine {
  return { getPerformanceSnapshot: () => perf } as unknown as ViewerEngine;
}

function renderPanel(engineStub: ViewerEngine | undefined = engine()): string {
  return renderToStaticMarkup(
    <QualityTelemetryPanel locale={LOCALE} engine={engineStub} onClose={() => undefined} />,
  );
}

describe("QualityTelemetryPanel", () => {
  it("满载数据:帧率分位数、质量窗口、托管显存全部渲染,数值带 tabular-nums", () => {
    // 构造含一条完整记录与显存快照的状态
    const collector = new QualityTelemetryCollector(16, true);
    collector.record({ frame: 42, passCount: 9, uploadedBytes: 328_640, visibleInstances: null,
      activeProfile: "quality", adaptiveDecisions: 2 });
    state.status = telemetryStatus({
      collector: collector.snapshot(),
      latestMemory: { bufferBytes: 65_536, textureBytes: 131_072, estimatedBytes: 196_608,
        peakEstimatedBytes: 262_144, unknownResources: 0, resourceCount: 6,
        admission: { budgetBytes: 268_435_456, rejectedCount: 0 } },
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "chunk-stream-residency-delta",
        visibleInstances: "unavailable" },
    });
    const html = renderPanel();
    expect(html).toContain("Deep WebGPU");
    expect(html).toContain("59"); // FPS 取整
    expect(html).toContain("16.7 ms");
    expect(html).toContain("24.3 ms");
    expect(html).toContain("画质"); // 活动质量档
    expect(html).toContain(">9</strong>"); // pass 数
    expect(html).toContain("320.9 kB"); // 328640 B
    expect(html).toContain("192.0 kB"); // 估算显存
    expect(html).toContain("256.0 kB"); // 峰值
    expect(html).toContain("未接入"); // 可见实例诚实缺测
    expect(html).toContain('aria-expanded="true"'); // 折叠钮初始展开
  });

  it("样式纪律:数值 tabular-nums,且不引入硬编码色值(令牌唯一来源 base.css)", async () => {
    const css = await readFile(new URL("./QualityTelemetryPanel.css", import.meta.url), "utf8");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 颜色一律 var()/color-mix,阴影允许黑色 alpha
    expect(css).toContain("var(--layer-panel)");
  });

  it("未接入:WebGL 等后端无遥测时显示引导空态,实时性能仍可用", () => {
    state.status = undefined;
    const html = renderPanel();
    expect(html).toContain("当前后端未接入质量遥测");
    expect(html).toContain("未接入");
    expect(html).toContain("59"); // 作者后端帧率仍显示
    expect(html).not.toContain("321.0 kB"); // 不渲染伪造数值
  });

  it("零值/等待态:会话已发布但尚无采样窗口时显示等待文案", () => {
    state.status = telemetryStatus({ collector: EMPTY_QUALITY_SNAPSHOT });
    const html = renderPanel();
    expect(html).toContain("等待首个采样窗口");
    expect(html).toContain("Deep WebGPU");
  });

  it("采样失败态:展示 failure 并停止伪造数值", () => {
    state.status = telemetryStatus({ failure: "Quality telemetry already recorded frame 42." });
    const html = renderPanel();
    expect(html).toContain("采样已停止");
    expect(html).toContain("Quality telemetry already recorded frame 42.");
  });

  it("非法输入:NaN/负值不崩溃,缺测显示 — 而非伪零", () => {
    state.status = telemetryStatus({
      activeProfile: null,
      collector: (() => {
        const collector = new QualityTelemetryCollector(16, true);
        collector.record({ frame: 7, passCount: 0, uploadedBytes: 0, visibleInstances: null,
          activeProfile: null, adaptiveDecisions: 0 });
        return collector.snapshot();
      })(),
      latestMemory: { bufferBytes: -5, textureBytes: Number.NaN, estimatedBytes: Number.NaN,
        peakEstimatedBytes: -1, unknownResources: 0, resourceCount: 0 },
    });
    const html = renderPanel(engine(perfSnapshot({
      frameTimeMs: { p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, maximum: Number.NaN },
      heap: { usedBytes: -1, totalBytes: Number.NaN, limitBytes: 0 },
    })));
    expect(html).toContain("—");
    expect(html).toContain("未设档"); // activeProfile null 的诚实文案
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object");
  });

  it("性能样本不足时不伪造 FPS,P95 阈值超标加警告语义", () => {
    state.status = undefined;
    const pending = renderPanel(engine({ ...perfSnapshot({ sampleCount: 1 }) }));
    expect(pending).toContain("—");
    const slow = renderPanel(engine(perfSnapshot({ frameTimeMs: { p50: 20, p95: 48.2, p99: 60, maximum: 90 },
      sampleCount: 30 })));
    expect(slow).toContain("48.2 ms");
    expect(slow).toContain("warn"); // P95 > 33.34ms 警告类
  });
});
