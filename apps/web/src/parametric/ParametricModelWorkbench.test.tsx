import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ParametricModelWorkbench, { parametricModeForTabKey } from "./ParametricModelWorkbench";
import { ParametricModelPreview } from "./ParametricModelPreview";
import type { ParametricCadBuildResult } from "./parametricCadTypes";

// 该用例只验证二级工作流的信息架构，不应初始化依赖 window 的真实 API 客户端。
vi.mock("../api", () => ({ api: { uploadModel: vi.fn() } }));

describe("ParametricModelWorkbench", () => {
  it("keeps the capability as a focused secondary asset flow", () => {
    const html = renderToStaticMarkup(<ParametricModelWorkbench projectId="default" locale="zh-CN" onClose={() => undefined} onSaved={() => undefined} />);
    expect(html).toContain("模型生成");
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toContain('id="parametric-mode-tab"');
    expect(html).toContain('aria-controls="parametric-mode-panel"');
    expect(html).toContain('id="tripo-mode-tab"');
    expect(html).toContain('id="hunyuan-mode-tab"');
    expect(html).toContain('aria-controls="ai-mode-panel"');
    expect(html).toContain("参数生成");
    expect(html).toContain("Tripo3D");
    expect(html).toContain("混元 3D");
    expect(html).toContain('aria-label="模型语言描述"');
    expect(html).toContain("设备安装板");
    expect(html).toContain("更新预览");
    expect(html).toContain("保存到资源");
    expect(html).toContain("GLB");
    expect(html).toContain("STEP");
    expect(html).toContain("样例");
  });

  it("can render as a full-page route surface without opening a modal backdrop", () => {
    const html = renderToStaticMarkup(<ParametricModelWorkbench embedded projectId="default" locale="zh-CN" onClose={() => undefined} onSaved={() => undefined} />);
    expect(html).toContain("parametric-workbench-page");
    expect(html).toContain('open=""');
  });

  it("supports arrow, Home and End keyboard navigation between generation modes", () => {
    expect(parametricModeForTabKey("parametric", "ArrowRight")).toBe("tripo3d");
    expect(parametricModeForTabKey("tripo3d", "ArrowRight")).toBe("tencentHunyuan");
    expect(parametricModeForTabKey("tripo3d", "ArrowLeft")).toBe("parametric");
    expect(parametricModeForTabKey("tencentHunyuan", "Home")).toBe("parametric");
    expect(parametricModeForTabKey("parametric", "End")).toBe("tencentHunyuan");
    expect(parametricModeForTabKey("parametric", "Enter")).toBeUndefined();
  });

  it("removes the decorative 3D placeholder and never covers a ready preview with the empty layer", () => {
    const empty = renderToStaticMarkup(<ParametricModelPreview locale="zh-CN" result={undefined} />);
    expect(empty).not.toContain(">3D<");
    expect(empty).toContain("让描述变成可编辑的部件");

    const result: ParametricCadBuildResult = {
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangles: new Uint32Array([0, 1, 2]),
      normals: new Float32Array(9),
      step: new ArrayBuffer(0),
      summary: { durationMs: 1, volumeMm3: 1, faceCount: 1, edgeCount: 3, triangleCount: 1, bounds: [[0, 0, 0], [1, 1, 0]], warnings: [] },
    };
    const ready = renderToStaticMarkup(<ParametricModelPreview locale="zh-CN" result={result} />);
    expect(ready).not.toContain("parametric-preview-empty");
    expect(ready).toContain("重置模型视角");
  });
});
