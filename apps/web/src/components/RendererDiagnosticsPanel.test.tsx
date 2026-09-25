import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { buildPbrFrameExecutionPlan, createPbrFrameReceipt } from "@bim-studio/deep-engine/webgpu";
import { RendererDiagnosticsPanel } from "./RendererDiagnosticsPanel";
import { rendererReadiness } from "../rendererCapabilities";

describe("RendererDiagnosticsPanel", () => {
  it("显示分位数、掉帧、渲染负载和内存证据", () => {
    const html = renderToStaticMarkup(
      <RendererDiagnosticsPanel
        locale="zh-CN"
        current="webgl"
        desired="webgpu"
        switchPhase="preparing"
        switchMessage="正在准备 Deep WebGPU Beta；当前画布仍在使用 WebGL 2"
        switching={false}
        checking={false}
        probe={{ webgl2: true, webgpuApi: false, webgpuAdapter: false, secureContext: true, timestampQuery: false, shaderF16: false }}
        readiness={[
          {
            backend: "webgl",
            ready: true,
            level: "ready",
            summary: "生产兼容，功能完整",
            details: ["模型、材质、拾取与动画完整可用"],
          },
        ]}
        performance={{
          sampleCount: 120,
          sampleWindowMs: 2_100,
          fps: 57.14,
          frameTimeMs: { p50: 16.3, p95: 42.6, p99: 58.2, maximum: 65 },
          over33msRate: 0.075,
          over50msRate: 0.02,
          ignoredBackgroundFrames: 1,
          renderer: {
            backend: "webgl",
            drawCalls: 1_205,
            triangles: 5_200_000,
            points: 0,
            lines: 4,
            geometries: 850,
            sharedPrimitiveGeometries: 6,
            textures: 410,
            programs: 26,
            viewportPixels: 8_294_400,
            pixelRatio: 2,
            activeFeatures: ["post-processing", "fragments"],
            adaptiveRenderScale: {
              enabled: true,
              mode: "adaptive-fill-rate",
              basePixelRatio: 2,
              pixelRatio: 1.9,
              renderScale: 0.95,
              reason: "持续帧压力：P95 42.6 ms",
            },
          },
          heap: { usedBytes: 192 * 1024 ** 2, totalBytes: 240 * 1024 ** 2, limitBytes: 2_048 * 1024 ** 2 },
          mainThread: { supported: true, count: 3, totalDurationMs: 320, blockingTimeMs: 170, maximumDurationMs: 140, windowMs: 10_000 },
          gpuFrameTime: { supported: true, sampleCount: 20, p50Ms: 8.2, p95Ms: 12.4, maximumMs: 16.8 },
          pressureSignals: [
            { code: "frame-budget", level: "warning", evidence: "P95 42.6 ms，超过 30 FPS 帧预算" },
            { code: "main-thread", level: "warning", evidence: "3 long tasks · 170 ms blocking time" },
          ],
        }}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );

    expect(html).toContain("P95");
    expect(html).toContain("42.6 ms");
    expect(html).toContain("7.5%");
    expect(html).toContain("1,205");
    expect(html).toContain("5.2M");
    expect(html).toContain("192 MB");
    expect(html).toContain("3 / 170ms");
    expect(html).toContain("GPU P95");
    expect(html).toContain("12.4 ms");
    expect(html).toContain("帧预算");
    expect(html).toContain("主线程阻塞");
    expect(html).toContain("自动优化 · 95% 填充率");
    expect(html).toContain("完整模型、灯光、效果与仿真保持不变");
    expect(html).toContain("持续帧压力：P95 42.6 ms");
    expect(html).toContain("不替代浏览器 Performance / GPU Profile");
    expect(html).toContain("导出诊断");
    expect(html).toContain("正在准备 · WebGL 2 → Deep WebGPU Beta");
    expect(html).toContain("保留同一作者状态，成功激活后才保存偏好");
    expect(html).toContain("画质与功能仍需逐场景验收");
  });

  it("shows unavailable Deep texture counts without borrowing hidden WebGL metrics", () => {
    const html = renderToStaticMarkup(<RendererDiagnosticsPanel locale="zh-CN" current="webgpu" desired="webgpu"
      switchPhase="idle" switchMessage={undefined} switching={false} checking={false} probe={undefined} readiness={[]}
      onClose={vi.fn()} onRefresh={vi.fn()} onSwitch={vi.fn()} performance={{ sampleCount: 3, sampleWindowMs: 48,
        fps: 62.5, frameTimeMs: { p50: 16, p95: 16, p99: 16, maximum: 16 }, over33msRate: 0, over50msRate: 0,
        ignoredBackgroundFrames: 0, pressureSignals: [], renderer: { backend: "webgpu", drawCalls: 19, triangles: 321,
          points: 0, lines: 0, viewportPixels: 800000, pixelRatio: 1.25, activeFeatures: ["deep-webgpu"] } }} />);
    expect(html).toContain("WEBGPU"); expect(html).toContain("deep-webgpu");
    expect(html).toContain("—"); expect(html).not.toContain("WEBGL");
    expect(html).not.toContain("GPU P95");
  });
  it("shows real Deep cluster, DDGI, temporal and residency evidence", () => {
    const html = renderToStaticMarkup(<RendererDiagnosticsPanel locale="en-US" current="webgpu" desired="webgpu"
      switchPhase="idle" switchMessage={undefined} switching={false} checking={false} probe={undefined} readiness={[]}
      onClose={vi.fn()} onRefresh={vi.fn()} onSwitch={vi.fn()} performance={{ sampleCount: 3, sampleWindowMs: 48,
        fps: 62.5, frameTimeMs: { p50: 16, p95: 16, p99: 16, maximum: 16 }, over33msRate: 0, over50msRate: 0,
        ignoredBackgroundFrames: 0, pressureSignals: [], renderer: { backend: "webgpu", drawCalls: 19, triangles: 321,
          points: 0, lines: 0, viewportPixels: 800000, pixelRatio: 1.25, activeFeatures: ["deep-webgpu"] },
        deep: { frame: { frame: 9, cpuSubmitMs: 2, drawCalls: 19, triangles: 321, width: 800, height: 600,
          resources: 5, shadowUpdated: false, cameraCut: true, postProcessPasses: 2, weightedOit: false,
          hiZMipLevels: 4, occlusionCulling: true, frustumCulledBatches: 3, hiZOccludedBatches: 2,
          lodSelectionBatches: 1, lodIndirectDraws: 1, lightCount: 6, lightClusters: 64, shadowTier: "high",
          shadowDepthBytes: 1024, deviceResourceMemory: { bufferBytes: 40 * 1024, textureBytes: 40 * 1024, estimatedBytes: 80 * 1024,
            peakEstimatedBytes: 80 * 1024, unknownResources: 0, resourceCount: 5, admission: { budgetBytes: 100 * 1024, rejectedCount: 0 } },
          transientTextures: { budgetBytes: 40 * 1024, residentBytes: 20 * 1024, budgetRejectedCount: 0, budgetEvictedBytes: 0,
            epoch: 1, frameOpen: false, acquireCount: 4, hits: 2, frameAliasHits: 0,
            misses: 2, allocatedBytes: 20 * 1024, reusedBytes: 0, freeCount: 0, freeBytes: 0, inFlightCount: 0,
            inFlightBytes: 0, pendingReturnCount: 0, pendingReturnBytes: 0, peakResidentBytes: 20 * 1024,
            discardedCount: 0, evictedCount: 0 },
          adaptiveQuality: { enabled: true, level: 1, reason: "gpu-pressure", changedAtFrame: 9,
            explanation: "GPU pressure", knobs: { ssrConeLevels: 4, ddgiUpdateBudget: 32, fogSteps: 40,
              shadowTier: "high", lodDetailScale: .9, residencyBudgetScale: .8 } } } } }} />);
    expect(html).toContain("Deep runtime evidence");
    expect(html).toContain("Light clusters");
    expect(html).toContain("DDGI update budget");
    expect(html).toContain("Temporal history");
    expect(html).toContain("Reset");
    expect(html).toContain("80 KB / 100 KB");
  });
  it("surfaces the live Frame Graph receipt and keeps unqueried pass timings explicit", () => {
    const plan = buildPbrFrameExecutionPlan({ width: 640, height: 360 }, { transparency: false });
    const receipt = createPbrFrameReceipt(7, plan, [], 10, 17);
    const frame = { frame: 7, cpuSubmitMs: 1, drawCalls: 19, triangles: 321, width: 640, height: 360, resources: 0,
      shadowUpdated: false, cameraCut: false, postProcessPasses: 0, weightedOit: false, hiZMipLevels: 0,
      occlusionCulling: false, frustumCulledBatches: 0, hiZOccludedBatches: 0, lodSelectionBatches: 0,
      lodIndirectDraws: 0, lightCount: 0, lightClusters: 0, shadowTier: "none", shadowDepthBytes: 0,
      frameGraphReceipt: receipt };
    const html = renderToStaticMarkup(<RendererDiagnosticsPanel locale="en-US" current="webgpu" desired="webgpu"
      switchPhase="idle" switchMessage={undefined} switching={false} checking={false} probe={undefined} readiness={[]}
      onClose={vi.fn()} onRefresh={vi.fn()} onSwitch={vi.fn()} performance={{ sampleCount: 3, sampleWindowMs: 48,
        fps: 62.5, frameTimeMs: { p50: 16, p95: 16, p99: 16, maximum: 16 }, over33msRate: 0, over50msRate: 0,
        ignoredBackgroundFrames: 0, pressureSignals: [], renderer: { backend: "webgpu", drawCalls: 19, triangles: 321,
          points: 0, lines: 0, viewportPixels: 800000, pixelRatio: 1.25, activeFeatures: ["deep-webgpu"] },
        deep: { frame } }} />);
    expect(html).toContain("Frame Graph receipt");
    expect(html).toContain(`>${receipt.passOrder.length}</strong> planned passes`);
    expect(html).toContain(`>${receipt.samples.length}</strong> awaiting timing`);
    expect(html).toContain("no zero timings are invented");
  });
  it("uses the current short stability and visual sign-off wording in English", () => {
    const html = renderToStaticMarkup(
      <RendererDiagnosticsPanel
        locale="en-US"
        current="webgl"
        desired="webgl"
        switchPhase="idle"
        switchMessage={undefined}
        switching={false}
        checking={false}
        probe={{ webgl2: true, webgpuApi: true, webgpuAdapter: true, secureContext: true, timestampQuery: true, shaderF16: true }}
        readiness={rendererReadiness(
          { webgl2: true, webgpuApi: true, webgpuAdapter: true, secureContext: true, timestampQuery: true, shaderF16: true },
          { postProcessingEnabled: true },
        )}
        performance={undefined}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );

    expect(html).toContain("Enable Deep WebGPU Beta");
    expect(html).toContain("In-house WebGPU");
    expect(html).toContain("GPU-driven large scenes");
    expect(html).toContain("saves preferences only after activation");
    expect(html).toContain("Materials, post-processing, picking, animation and WebXR");
    expect(html).toContain('class="limited "');
    expect(html).not.toContain("Three.js WebGPU");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    expect(html).not.toContain("8-hour");
    expect(html).not.toContain("8 小时");
  });
});
