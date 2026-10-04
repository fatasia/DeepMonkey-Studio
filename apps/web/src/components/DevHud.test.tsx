import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QualityTelemetrySnapshot } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { DevHud, formatHudBytes, formatHudCount, formatHudHeap, formatHudMs } from "./DevHud";

// 桥模块含 three.js 重依赖;HUD 测试只消费注册表读取函数,用 hoisted 状态注入。
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

function engine(perf = perfSnapshot()): ViewerEngine {
  return { getPerformanceSnapshot: () => perf } as unknown as ViewerEngine;
}

function renderHud(engineStub: ViewerEngine | undefined = engine()): string {
  return renderToStaticMarkup(<DevHud locale={LOCALE} engine={engineStub} onClose={() => undefined} />);
}

afterEach(() => {
  state.status = undefined;
  vi.unstubAllGlobals();
});

describe("DevHud", () => {
  it("满载数据:FPS/帧时分位/GPU/品质档/堆/draw·tris 逐行渲染,数值等宽语义", () => {
    state.status = {
      sampleHz: 4, activeProfile: "quality",
      collector: { frames: [], retainedFrameCount: 0, capacity: 16 } as unknown as QualityTelemetrySnapshot,
      latestMemory: { bufferBytes: 65_536, textureBytes: 131_072, estimatedBytes: 3_355_443,
        peakEstimatedBytes: 4_194_304, unknownResources: 0, resourceCount: 6,
        admission: { budgetBytes: 268_435_456, rejectedCount: 0 } },
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "chunk-stream-residency-delta",
        visibleInstances: "main-pass-draw-calls" },
      latestPassTimings: { frame: 88, availability: "measured", milliseconds: 9.5,
        passes: [
          { passId: "opaque", durationMs: 4.2 }, { passId: "ambient-occlusion", durationMs: 2.1 },
          { passId: "apply-ambient-occlusion", durationMs: 1.8 }, { passId: "present", durationMs: 1.4 },
          { passId: "composite-oit", durationMs: 1.2 }, { passId: "transparent-oit", durationMs: 1.1 },
          { passId: "temporal-aa", durationMs: 0.9 },
        ], requestedPassCount: 7, measuredPassCount: 7 },
      latestVisibleDraws: { drawCalls: 42, triangles: 128_000, frustumCulledBatches: 3, hiZOccludedBatches: 1 },
    };
    const html = renderHud(engine(perfSnapshot({
      heap: { usedBytes: 268_435_456, totalBytes: 536_870_912, limitBytes: 4_294_967_296 },
      gpuFrameTime: { supported: true, sampleCount: 30, p50Ms: 8.1, p95Ms: 12.4, maximumMs: 18 },
      deep: { frame: { frame: 90, adaptiveQuality: { enabled: true, level: 2 } } },
    } as unknown as Partial<FramePerformanceSnapshot>)));
    expect(html).toContain(">59</strong>"); // FPS 取整
    expect(html).toContain("16.70 ms");
    expect(html).toContain("24.30 ms");
    expect(html).toContain("12.40 ms"); // GPU P95
    expect(html).toContain("9.50 ms"); // Deep 全帧跨度
    expect(html).toContain("画质 · L2"); // 品质档 + 自适应级别
    expect(html).toContain("256.0 MB / 4.00 GB"); // JS 堆 used / limit
    expect(html).toContain("3.2 MB"); // 托管显存估算
    expect(html).toContain("42 / 128.0k"); // F1 可见绘制量
    expect(html.indexOf(">opaque<")).toBeLessThan(html.indexOf(">ambient-occlusion<"));
    expect(html).toContain("Top 5/7 · 计时帧 #88"); // Top-5 截断声明
    expect(html).not.toContain(">transparent-oit<"); // 第 6 名不进 HUD 列表
    expect(html).toContain("Deep WebGPU");
  });

  it("未接入:非 Deep 后端显示引导,FPS/绘制量回退作者后端读数,不伪零", () => {
    state.status = undefined;
    const html = renderHud();
    expect(html).toContain("质量遥测未接入");
    expect(html).toContain("作者后端");
    expect(html).toContain(">59</strong>");
    expect(html).toContain("12 / 8.0k"); // renderer 计数回退
    expect(html).toContain("GPU P95");
    expect(html).not.toContain("3.2 MB"); // 无遥测不渲染托管显存
  });

  it("逐 pass 计时未开启:显示 t25-gpu-pass-timing=1 引导而非空值", () => {
    state.status = {
      sampleHz: 4, activeProfile: "balanced",
      collector: { frames: [], retainedFrameCount: 0, capacity: 16 } as unknown as QualityTelemetrySnapshot,
      latestMemory: undefined,
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
    };
    const html = renderHud();
    expect(html).toContain("t25-gpu-pass-timing=1");
    expect(html).toContain("未开启");
  });

  it("逐 pass 读回失败:显示不可用而非伪零样本", () => {
    state.status = {
      sampleHz: 4, activeProfile: "balanced",
      collector: { frames: [], retainedFrameCount: 0, capacity: 16 } as unknown as QualityTelemetrySnapshot,
      latestMemory: undefined,
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
      latestPassTimings: { frame: 90, availability: "unavailable",
        unavailableReason: "设备不支持 timestamp-query" },
    };
    const html = renderHud();
    expect(html).toContain("不可用");
    expect(html).toContain("设备不支持 timestamp-query");
  });

  it("采样失败:展示 failure 而非静默", () => {
    state.status = {
      sampleHz: 4, activeProfile: null,
      collector: { frames: [], retainedFrameCount: 0, capacity: 16 } as unknown as QualityTelemetrySnapshot,
      latestMemory: undefined,
      coverage: { passCount: "unavailable", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
      failure: "Quality telemetry already recorded frame 42.",
    };
    expect(renderHud()).toContain("Quality telemetry already recorded frame 42.");
  });

  it("非法输入:NaN/负值/样本不足一律 —,不出现 undefined 或对象串", () => {
    state.status = {
      sampleHz: 4, activeProfile: null,
      collector: { frames: [], retainedFrameCount: 0, capacity: 16 } as unknown as QualityTelemetrySnapshot,
      latestMemory: undefined,
      coverage: { passCount: "unavailable", uploadedBytes: "unavailable", visibleInstances: "unavailable" },
      latestVisibleDraws: { drawCalls: Number.NaN, triangles: -5, frustumCulledBatches: 0, hiZOccludedBatches: 0 },
    };
    const html = renderHud(engine(perfSnapshot({
      sampleCount: 1, // 样本不足
      frameTimeMs: { p50: Number.NaN, p95: Number.NaN, p99: Number.NaN, maximum: Number.NaN },
      heap: { usedBytes: -1, totalBytes: Number.NaN, limitBytes: 0 },
      gpuFrameTime: { supported: false, sampleCount: 0, p50Ms: Number.NaN, p95Ms: Number.NaN, maximumMs: Number.NaN },
    })));
    expect((html.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object");
    expect(html).not.toContain("NaN");
  });

  it("折叠态:从持久化偏好恢复,只渲染单行不渲染指标体", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === "bim-studio.devhud.collapsed" ? "true" : null,
        setItem: () => undefined,
      },
    });
    state.status = undefined;
    const html = renderHud();
    expect(html).toContain("dev-hud collapsed");
    expect(html).toContain("data-collapsed=\"true\"");
    expect(html).not.toContain("hud-row");
    expect(html).toContain("16.70 ms"); // 折叠单行仍带 P50 摘要
    expect(html).toContain("未设档"); // 无遥测时的诚实档位文案
  });

  it("持久化位置非法时不崩溃,回退 CSS 默认锚位", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => key === "bim-studio.devhud.position" ? '{"x":"left","y":null}' : null,
        setItem: () => undefined,
      },
    });
    expect(renderHud()).toContain("dev-hud");
  });

  it("格式化导出:毫秒/字节/大数计数/堆占用,非法输入 — 而非伪零", () => {
    expect(formatHudMs(4.2)).toBe("4.20 ms");
    expect(formatHudMs(Number.NaN)).toBe("—");
    expect(formatHudMs(undefined)).toBe("—");
    expect(formatHudBytes(0)).toBe("0 B");
    expect(formatHudBytes(328_640)).toBe("320.9 kB");
    expect(formatHudBytes(3_355_443)).toBe("3.2 MB");
    expect(formatHudBytes(4_294_967_296)).toBe("4.00 GB");
    expect(formatHudBytes(-1)).toBe("—");
    expect(formatHudCount(999)).toBe("999");
    expect(formatHudCount(8_000)).toBe("8.0k");
    expect(formatHudCount(128_000_000)).toBe("128.00M");
    expect(formatHudCount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatHudHeap(268_435_456, 4_294_967_296)).toBe("256.0 MB / 4.00 GB");
    expect(formatHudHeap(268_435_456, 0)).toBe("256.0 MB"); // limit 缺测只报 used
    expect(formatHudHeap(Number.NaN, 100)).toBe("—");
  });

  it("样式纪律:数值 tabular-nums、等宽字体、--layer-panel 层级,不引入硬编码色值", async () => {
    const css = await readFile(new URL("./DevHud.css", import.meta.url), "utf8");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).toContain("monospace");
    expect(css).toContain("var(--layer-panel)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 颜色一律 var()/color-mix,阴影允许黑色 alpha
  });
});
