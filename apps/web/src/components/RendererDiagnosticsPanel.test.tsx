import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RendererDiagnosticsPanel } from "./RendererDiagnosticsPanel";

describe("RendererDiagnosticsPanel", () => {
  it("显示分位数、掉帧、渲染负载和内存证据", () => {
    const html = renderToStaticMarkup(
      <RendererDiagnosticsPanel
        locale="zh-CN"
        current="webgl"
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
  });

  it("uses the current short stability and visual sign-off wording in English", () => {
    const html = renderToStaticMarkup(
      <RendererDiagnosticsPanel
        locale="en-US"
        current="webgl"
        switching={false}
        checking={false}
        probe={{ webgl2: true, webgpuApi: true, webgpuAdapter: true, secureContext: true, timestampQuery: true, shaderF16: true }}
        readiness={[{
          backend: "webgpu",
          ready: true,
          level: "limited",
          summary: "场景可发布，产品能力仍在验收",
          details: ["WebGPU TSL 已覆盖核心后处理与对象轮廓；画质等价仍按发布场景签署，自动发布暂保留 WebGL"],
        }]}
        performance={undefined}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );

    expect(html).toContain("Visual parity is signed off per published scene");
    expect(html).not.toContain("8-hour");
    expect(html).not.toContain("8 小时");
  });
});
