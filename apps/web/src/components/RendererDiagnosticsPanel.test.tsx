import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
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
    expect(html).toContain("Deep WebGPU projection canvas");
    expect(html).toContain("author overlays still require per-scene validation");
    expect(html).toContain("saves preferences only after activation");
    expect(html).toContain("automatic publication remains on WebGL");
    expect(html).toContain("XR sessions continue to use WebGL");
    expect(html).toContain('class="limited "');
    expect(html).not.toContain("Three.js WebGPU");
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    expect(html).not.toContain("8-hour");
    expect(html).not.toContain("8 小时");
  });
});
