import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { ScenePostProcessingEditor } from "./ScenePostProcessingEditor";

describe("ScenePostProcessingEditor", () => {
  it("shows independent light-shaft controls and preserves a zero strength", () => {
    const html = renderToStaticMarkup(<ScenePostProcessingEditor locale="zh-CN" rendererBackend="webgpu"
      value={{ ...DEFAULT_POST_PROCESSING, volumetricFog: true, volumetricGodRays: true, volumetricGodRaysStrength: 0 }} onChange={vi.fn()} />);
    expect(html).toContain("体积光"); expect(html).toContain("体积光强度"); expect(html).toContain('max="8"');
    expect(html).toContain('value="0"');
    const off = renderToStaticMarkup(<ScenePostProcessingEditor locale="zh-CN" rendererBackend="webgpu"
      value={{ ...DEFAULT_POST_PROCESSING, volumetricFog: true, volumetricGodRays: false }} onChange={vi.fn()} />);
    expect(off).toContain("体积光"); expect(off).not.toContain("体积光强度");
  });
  it("在 WebGPU 下提供完整调色控件", () => {
    const html = renderToStaticMarkup(
      <ScenePostProcessingEditor
        locale="zh-CN"
        rendererBackend="webgpu"
        value={{ ...DEFAULT_POST_PROCESSING, colorGrading: true }}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain("调色");
    expect(html).toContain("色相");
    expect(html).toContain("饱和度");
    expect(html).not.toContain("实时后处理当前使用 WebGL 管线");
  });
  it("exposes bounded Deep SSR controls and the unsupported-client reason", () => {
    const html = renderToStaticMarkup(<ScenePostProcessingEditor locale="zh-CN" rendererBackend="webgpu"
      value={{ ...DEFAULT_POST_PROCESSING, screenSpaceReflection: true }} onChange={vi.fn()} />);
    expect(html).toContain("SSR 步数");
    expect(html).toContain("命中厚度");
    expect(html).toContain("Three WebView 与 Deep Native 会在发布检查中明确阻断");
  });
  it("exposes bounded volumetric fog controls", () => {
    const html = renderToStaticMarkup(<ScenePostProcessingEditor locale="zh-CN" rendererBackend="webgpu"
      value={{ ...DEFAULT_POST_PROCESSING, volumetricFog: true }} onChange={vi.fn()} />);
    expect(html).toContain("体积雾");
    expect(html).toContain("雾采样步数");
    expect(html).toContain("雾密度");
    expect(html).toContain("高度尺度");
    expect(html).toContain("各向异性");
    expect(html).toContain("散射反照率");
    expect(html).toContain("Deep Native 使用受限 8 步积分");
  });
});
