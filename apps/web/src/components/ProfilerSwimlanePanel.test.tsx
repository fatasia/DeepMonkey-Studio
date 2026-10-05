import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FrameMetrics } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import {
  ProfilerSummary,
  ProfilerSwimlanePanel,
  SwimlaneGrid,
} from "./ProfilerSwimlanePanel";
import { buildSwimlaneView, type ProfilerSwimlaneSample } from "./profilerSwimlaneModel";

// 桥模块含 three.js 重依赖;面板测试只消费注册表读取函数,用 hoisted 状态注入。
const state = vi.hoisted(() => ({ status: undefined as StudioQualityTelemetryStatus | undefined }));
vi.mock("../viewer/StudioDeepQualityTelemetry", () => ({
  readStudioQualityTelemetry: () => state.status,
}));

const LOCALE = "zh-CN" as const;

function deepFrame(overrides: Partial<FrameMetrics> = {}): FrameMetrics {
  return {
    frame: 100, cpuSubmitMs: 4.2, drawCalls: 12, triangles: 800, width: 1920, height: 1080, resources: 3,
    ...overrides,
  } as FrameMetrics;
}

function perfSnapshot(deep: FrameMetrics | undefined): FramePerformanceSnapshot {
  return {
    sampleCount: 30, sampleWindowMs: 10_000, fps: 59.4,
    frameTimeMs: { p50: 16.7, p95: 24.3, p99: 31, maximum: 40 },
    over33msRate: 0.02, over50msRate: 0, ignoredBackgroundFrames: 0,
    renderer: { backend: "webgpu", drawCalls: 12, triangles: 8_000, points: 0, lines: 0,
      viewportPixels: 921_600, pixelRatio: 1, activeFeatures: [] },
    pressureSignals: [],
    ...(deep ? { deep: { frame: deep } } : {}),
  } as FramePerformanceSnapshot;
}

function engine(deep: FrameMetrics | undefined = deepFrame()): ViewerEngine {
  return { getPerformanceSnapshot: () => perfSnapshot(deep) } as unknown as ViewerEngine;
}

function telemetry(overrides: Partial<StudioQualityTelemetryStatus> = {}): StudioQualityTelemetryStatus {
  return {
    sampleHz: 4,
    activeProfile: "quality",
    collector: { frames: [], capacity: 16, retainedFrameCount: 0 },
    coverage: { passCount: "unavailable", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
    ...overrides,
  } as StudioQualityTelemetryStatus;
}

function renderPanel(engineStub: ViewerEngine | undefined = engine()): string {
  return renderToStaticMarkup(
    <ProfilerSwimlanePanel locale={LOCALE} engine={engineStub} onClose={() => undefined} />,
  );
}

describe("ProfilerSwimlanePanel", () => {
  it("renders the detached empty state when no Deep telemetry is published", () => {
    state.status = undefined;
    const html = renderPanel();
    expect(html).toContain("性能剖析");
    expect(html).toContain("未接入");
    expect(html).toContain("当前后端未接入 Deep 帧指标");
  });

  it("renders the gpuPassTiming-off state when attached without pass timings", () => {
    state.status = telemetry();
    const html = renderPanel();
    expect(html).toContain("Deep WebGPU");
    expect(html).toContain("gpuPassTiming");
  });

  it("renders the unavailable reason instead of fake lanes", () => {
    state.status = telemetry({
      latestPassTimings: { frame: 9, availability: "unavailable", unavailableReason: "timestamp slots busy" },
    });
    const html = renderPanel(engine(deepFrame({ frame: 9 })));
    expect(html).toContain("逐 pass 计时暂不可用");
  });

  it("renders the sampling hint while the window is empty", () => {
    state.status = telemetry({
      latestPassTimings: { frame: 100, availability: "measured", milliseconds: 12, passes: [{ passId: "main", durationMs: 3 }] },
    });
    const html = renderPanel();
    expect(html).toContain("采样中");
  });

  it("renders summary KPIs from a built view", () => {
    const samples: ProfilerSwimlaneSample[] = [
      { frame: 1, passes: [{ passId: "main", durationMs: 2 }, { passId: "shadow-cascades", durationMs: 9 }], gpuSpanMs: 12, cpuSubmitMs: 4, rebuildTotal: 3 },
      { frame: 2, passes: [{ passId: "main", durationMs: 3 }, { passId: "shadow-cascades", durationMs: 1 }], gpuSpanMs: 10, cpuSubmitMs: 5, rebuildTotal: 4 },
    ];
    const view = buildSwimlaneView(samples);
    const html = renderToStaticMarkup(
      <ProfilerSummary locale={LOCALE} view={view} meta={{ attached: true, timings: "measured", fps: 60, sampleCount: 2 }} />,
    );
    expect(html).toContain("shadow-cascades");
    expect(html).toContain("最贵 pass · 9.00 ms @ #1");
    expect(html).toContain("窗口帧");
    expect(html).toContain("重建增量");
  });

  it("renders swimlane rows for gpu span, cpu submit, passes and rebuild markers", () => {
    const samples: ProfilerSwimlaneSample[] = [
      { frame: 1, passes: [{ passId: "main", durationMs: 2 }, { passId: "bloom", durationMs: 5 }], gpuSpanMs: 12, cpuSubmitMs: 4, rebuildTotal: 3 },
      { frame: 2, passes: [{ passId: "main", durationMs: 3 }], rebuildTotal: 4 },
    ];
    const view = buildSwimlaneView(samples);
    const html = renderToStaticMarkup(<SwimlaneGrid locale={LOCALE} view={view} />);
    expect(html).toContain("GPU 跨度");
    expect(html).toContain("CPU 提交");
    expect(html).toContain("重建");
    expect(html).toContain("bloom");
    expect(html).toContain("main");
    // 重建增量标记带可对账 tooltip;缺测帧不伪零(na 单元)。
    expect(html).toContain("重建 #3→#4 @ 帧 2");
    expect(html).toContain("na");
    expect(html).toContain("该帧未实测");
  });
});
