import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QualityTelemetryCollector, type QualityTelemetrySnapshot } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import {
  PerformanceDiagnosticsPanel,
  PassTimings,
  SwimlaneGrid,
  formatHudBytes,
  formatHudCount,
  formatHudHeap,
  formatHudMs,
  formatHudRebuilds,
  FramesTab,
  PipelineTab,
  ResourcesTab,
  rtShadowRouteLabel,
  SceneTab,
} from "./PerformanceDiagnosticsPanel";
import { buildSwimlaneView, type ProfilerSwimlaneSample } from "./profilerSwimlaneModel";

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
      viewportPixels: 921_600, pixelRatio: 1, activeFeatures: [], textures: 24, geometries: 11 },
    pressureSignals: [],
    heap: { usedBytes: 48 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, limitBytes: 256 * 1024 * 1024 },
    ...overrides,
  } as FramePerformanceSnapshot;
}

function engine(perf = perfSnapshot()): ViewerEngine {
  return { getPerformanceSnapshot: () => perf } as unknown as ViewerEngine;
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

function measuredTimings(): NonNullable<StudioQualityTelemetryStatus["latestPassTimings"]> {
  return {
    frame: 88, availability: "measured", milliseconds: 9.5,
    passes: [
      { passId: "opaque", durationMs: 4.2 }, { passId: "ambient-occlusion", durationMs: 2.1 },
      { passId: "apply-ambient-occlusion", durationMs: 1.8 }, { passId: "present", durationMs: 1.4 },
      { passId: "composite-oit", durationMs: 1.2 }, { passId: "transparent-oit", durationMs: 1.1 },
      { passId: "temporal-aa", durationMs: 0.9 },
    ],
    requestedPassCount: 7, measuredPassCount: 7,
  };
}

function statistics() {
  return { modelCount: 3, componentCount: 120, primitiveCount: 5, triangleCount: 240_000, vertexCount: 720_000 };
}

function renderPanel(engineStub: ViewerEngine | undefined = engine()): string {
  return renderToStaticMarkup(
    <PerformanceDiagnosticsPanel
      locale={LOCALE}
      engine={engineStub}
      statistics={statistics()}
      onClose={() => undefined}
    />,
  );
}

function swimlaneSamples(): ProfilerSwimlaneSample[] {
  return [
    { frame: 1, passes: [{ passId: "main", durationMs: 2 }, { passId: "shadow-cascades", durationMs: 9 }], gpuSpanMs: 12, cpuSubmitMs: 4, rebuildTotal: 3 },
    { frame: 2, passes: [{ passId: "main", durationMs: 3 }], gpuSpanMs: 10, cpuSubmitMs: 5, rebuildTotal: 4 },
  ];
}

describe("PerformanceDiagnosticsPanel", () => {
  it("统一面板壳:四分区 tab 与后端徽章渲染,旧四面板标题不再出现", () => {
    state.status = undefined;
    const html = renderPanel();
    expect(html).toContain("性能与诊断");
    expect(html).toContain("帧时");
    expect(html).toContain("场景");
    expect(html).toContain("资源");
    expect(html).toContain("管线");
    expect(html).toContain("作者后端");
    // 旧面板标题收编后不得复现(重复入口清零)。
    expect(html).not.toContain("质量遥测</strong>");
    expect(html).not.toContain("性能剖析");
    expect(html).not.toContain("开发者 HUD");
  });

  it("帧时分区(缺测):FPS 不伪零,跨帧时序给后端引导", () => {
    state.status = undefined;
    const html = renderPanel(engine({ ...perfSnapshot(), sampleCount: 1 }));
    expect(html).toContain("当前后端未接入 Deep 帧指标");
    expect(html).toContain("—");
  });

  it("帧时分区(满载):分位数/GPU P95/最贵 pass/迷你跨帧行全部渲染", () => {
    state.status = telemetryStatus({ latestPassTimings: measuredTimings() });
    const view = buildSwimlaneView(swimlaneSamples());
    const html = renderToStaticMarkup(
      <FramesTab
        locale={LOCALE}
        perf={perfSnapshot()}
        quality={state.status}
        view={view}
        meta={{ attached: true, timings: "measured", fps: 59.4, sampleCount: 2 }}
      />,
    );
    expect(html).toContain("59"); // FPS 取整
    expect(html).toContain("16.7 ms");
    expect(html).toContain("24.3 ms");
    expect(html).toContain("2.0%"); // 超 33ms 帧占比
    expect(html).toContain("shadow-cascades");
    expect(html).toContain("最贵 pass · 9.00 ms @ #1");
    expect(html).toContain("GPU 跨度");
    expect(html).toContain("CPU 提交");
  });

  it("场景分区:对象统计/基础体/本帧绘制/纹理与几何体/相机与指针", () => {
    state.status = telemetryStatus({
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "chunk-stream-residency-delta", visibleInstances: "main-pass-draw-calls" },
      latestVisibleDraws: { drawCalls: 42, triangles: 128_000, frustumCulledBatches: 3, hiZOccludedBatches: 1 },
    });
    const html = renderToStaticMarkup(
      <SceneTab
        locale={LOCALE}
        statistics={statistics()}
        perf={perfSnapshot()}
        quality={state.status}
        camera={{ position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 1, z: 0 } } as never}
        pointer={{ world: { x: 4, y: 5, z: 6 }, screenX: 10, screenY: 20, objectName: "外墙-01" }}
      />,
    );
    expect(html).toContain("对象合计");
    expect(html).toContain("128"); // 3 模型 + 5 基础体 + 120 构件 = 128 对象
    expect(html).toContain("240,000"); // 三角面(numberFormat zh-CN 千分位)
    expect(html).toContain("720,000");
    expect(html).toContain("42 / 128.0k"); // F1 可见绘制口径
    expect(html).toContain("24 / 11"); // 纹理 / 几何体
    expect(html).toContain("1.00, 2.00, 3.00"); // 相机位置
    expect(html).toContain("4.00, 5.00, 6.00"); // 指针世界坐标
    expect(html).toContain("外墙-01");
  });

  it("资源分区:JS 堆与托管显存满载渲染;WebGL 后端如实「未接入」", () => {
    state.status = telemetryStatus({
      latestMemory: { bufferBytes: 65_536, textureBytes: 131_072, estimatedBytes: 196_608,
        peakEstimatedBytes: 262_144, unknownResources: 0, resourceCount: 6,
        admission: { budgetBytes: 268_435_456, rejectedCount: 0 } },
    });
    const full = renderToStaticMarkup(
      <ResourcesTab locale={LOCALE} perf={perfSnapshot()} quality={state.status} />,
    );
    expect(full).toContain("48.0 MB"); // JS 堆已用
    expect(full).toContain("256.0 MB"); // 上限
    expect(full).toContain("192.0 kB"); // 估算显存
    expect(full).toContain("256.0 kB"); // 峰值
    expect(full).toContain("64.0 kB / 128.0 kB"); // 缓冲 / 纹理
    // exactOptionalPropertyTypes:剥离 heap 用解构省略,而非显式 undefined。
    const { heap: _heapOmitted, ...perfWithoutHeap } = perfSnapshot();
    void _heapOmitted;
    const detached = renderToStaticMarkup(
      <ResourcesTab locale={LOCALE} perf={perfWithoutHeap} quality={undefined} />,
    );
    expect(detached).toContain("performance.memory");
    expect(detached).toContain("未接入托管显存");
    expect(detached).not.toContain("192.0 kB");
  });

  it("管线分区:品质档/质量窗口语义指标/诚实缺测(未接入不伪零)", () => {
    const collector = new QualityTelemetryCollector(16, true);
    collector.record({ frame: 42, passCount: 9, uploadedBytes: 328_640, visibleInstances: null,
      activeProfile: "quality", adaptiveDecisions: 2 });
    state.status = telemetryStatus({
      collector: collector.snapshot(),
      coverage: { passCount: "frame-graph-receipt", uploadedBytes: "chunk-stream-residency-delta",
        visibleInstances: "unavailable" },
      latestPassTimings: measuredTimings(),
    });
    const perf = perfSnapshot({
      deep: { frame: { frame: 88, adaptiveQuality: { level: 2, enabled: true },
        rtShadowRoute: { channel: "cascade", reason: "RT off" }, rendererRebuilds: { ordinal: 0, total: 3 } } },
    } as Partial<FramePerformanceSnapshot>);
    const html = renderToStaticMarkup(
      <PipelineTab
        locale={LOCALE}
        perf={perf}
        quality={state.status}
        timings={state.status.latestPassTimings}
        adaptive={{ level: 2, enabled: true }}
        rtRoute={{ channel: "cascade", reason: "RT off" }}
        rebuilds={{ ordinal: 0, total: 3 }}
        deepFrame={undefined}
        draws={{ drawCalls: 42, triangles: 128_000, frustumCulledBatches: 3, hiZOccludedBatches: 1 }}
        view={buildSwimlaneView(swimlaneSamples())}
        meta={{ attached: true, timings: "measured", fps: 59.4, sampleCount: 2 }}
      />,
    );
    expect(html).toContain("画质 · L2"); // 品质档 + 自适应等级
    expect(html).toContain("级联"); // RT 阴影选路
    expect(html).toContain("#0 · Σ3"); // 重建账目
    expect(html).toContain(">9</strong>"); // pass 数(帧图回执)
    expect(html).toContain("320.9 kB"); // 上传字节
    expect(html).toContain("未接入"); // 可见实例诚实缺测(coverage unavailable)
    expect(html).toContain("opaque"); // 逐 pass 列表
    expect(html).toContain("跨帧泳道"); // 泳道分区
    expect(html).toContain("重建 #3→#4 @ 帧 2"); // 重建标记可对账
  });

  it("管线分区(未接入):Deep 未挂时给切换引导,不渲染伪泳道", () => {
    state.status = undefined;
    const html = renderToStaticMarkup(
      <PipelineTab
        locale={LOCALE}
        perf={perfSnapshot()}
        quality={undefined}
        timings={undefined}
        adaptive={undefined}
        rtRoute={undefined}
        rebuilds={undefined}
        deepFrame={undefined}
        draws={undefined}
        view={buildSwimlaneView([])}
        meta={{ attached: false, timings: "detached", fps: 59, sampleCount: 0 }}
      />,
    );
    expect(html).toContain("当前后端未接入质量遥测");
    expect(html).toContain("—");
    expect(html).not.toContain("跨帧泳道");
  });

  it("逐 pass 计时三态:未开启给 t25 引导;不可用给原因;实测降序 Top-8 并汇总省略", async () => {
    const off = renderToStaticMarkup(
      <PassTimings locale={LOCALE} timings={undefined} attached={true} />,
    );
    expect(off).toContain("t25-gpu-pass-timing=1");
    const unavailable = renderToStaticMarkup(
      <PassTimings locale={LOCALE} timings={{ frame: 9, availability: "unavailable", unavailableReason: "timestamp slots busy" }} attached={true} />,
    );
    expect(unavailable).toContain("timestamp slots busy");
    const passes = Array.from({ length: 10 }, (_, index) => ({ passId: `p${index}`, durationMs: 10 - index }));
    const measured = renderToStaticMarkup(
      <PassTimings locale={LOCALE} timings={{ frame: 100, availability: "measured", milliseconds: 30,
        passes, requestedPassCount: 10, measuredPassCount: 10 }} attached={true} />,
    );
    expect(measured).toContain("p0"); // 最贵 pass 列首
    expect(measured).toContain("30.00 ms"); // 全帧跨度
    expect(measured).toContain("10/10");
    expect(measured).toContain("另有 2 个 pass 未列入");
    const css = await readFile(new URL("./PerformanceDiagnosticsPanel.css", import.meta.url), "utf8");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 颜色一律 var()/color-mix,阴影允许黑色 alpha
    expect(css).toContain("var(--layer-panel)");
  });

  it("泳道网格:GPU 跨度/CPU 提交/pass 行/重建标记与缺测 na 单元", () => {
    const view = buildSwimlaneView(swimlaneSamples());
    const html = renderToStaticMarkup(<SwimlaneGrid locale={LOCALE} view={view} />);
    expect(html).toContain("GPU 跨度");
    expect(html).toContain("CPU 提交");
    expect(html).toContain("重建");
    expect(html).toContain("shadow-cascades");
    expect(html).toContain("重建 #3→#4 @ 帧 2");
    expect(html).toContain("na");
    expect(html).toContain("该帧未实测");
  });

  it("格式化:非法输入一律 — 而非伪零;字节/计数/堆/重建/RT 选路标签", () => {
    expect(formatHudMs(Number.NaN)).toBe("—");
    expect(formatHudMs(-1)).toBe("—");
    expect(formatHudMs(4.256)).toBe("4.26 ms");
    expect(formatHudBytes(1023)).toBe("1023 B");
    expect(formatHudBytes(1536)).toBe("1.5 kB");
    expect(formatHudBytes(3_355_443)).toBe("3.2 MB");
    expect(formatHudBytes(Number.NaN)).toBe("—");
    expect(formatHudCount(999)).toBe("999");
    expect(formatHudCount(12_345)).toBe("12.3k");
    expect(formatHudCount(2_500_000)).toBe("2.50M");
    expect(formatHudCount(-3)).toBe("—");
    expect(formatHudHeap(1024, 0)).toBe("1.0 kB"); // 上限缺测只显已用
    expect(formatHudHeap(2048, 4096)).toBe("2.0 kB / 4.0 kB");
    expect(formatHudRebuilds(undefined)).toBe("—");
    expect(formatHudRebuilds({ ordinal: 0, total: 3 })).toBe("#0 · Σ3");
    expect(rtShadowRouteLabel(LOCALE, "ray-traced")).toBe("光线追踪");
    expect(rtShadowRouteLabel(LOCALE, "cascade")).toBe("级联");
  });

  it("样式纪律:tabular-nums、层带令牌、无硬编码色值(令牌唯一来源 base.css)", async () => {
    const css = await readFile(new URL("./PerformanceDiagnosticsPanel.css", import.meta.url), "utf8");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain("var(--layer-panel)");
    expect(css).toContain("prefers-reduced-motion");
  });
});
