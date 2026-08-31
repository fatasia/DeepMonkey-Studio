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
});
