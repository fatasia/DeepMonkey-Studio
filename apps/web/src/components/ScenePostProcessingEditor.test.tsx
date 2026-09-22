import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { ScenePostProcessingEditor } from "./ScenePostProcessingEditor";

describe("ScenePostProcessingEditor", () => {
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
});
