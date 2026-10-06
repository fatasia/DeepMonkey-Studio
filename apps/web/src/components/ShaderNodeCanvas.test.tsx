import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import { ShaderNodeCanvas } from "./ShaderNodeCanvas";

const NOOP = () => {};

function asset(stage: Partial<ShaderGraphAssetV1["stages"][number]> = {}): ShaderGraphAssetV1 {
  return {
    schemaVersion: 1, id: "canvas-probe", target: "webgpu-forward", properties: [],
    stages: [{ stage: "fragment", nodes: [], edges: [], outputs: [], ...stage }],
  };
}

/** 节点图画布静态结构(renderToStaticMarkup 与仓内组件测试同规;编辑语义在
 *  shaderNodeCanvasModel.test.ts,诊断面板/调色板在此钉)。 */
describe("ShaderNodeCanvas", () => {
  it("palette is registry-driven and exposes the geometry family without hardcoding", () => {
    const markup = renderToStaticMarkup(<ShaderNodeCanvas locale="zh-CN" asset={asset()} onAssetChange={NOOP} />);
    expect(markup).toContain("<optgroup");
    expect(markup).toContain("几何");
    expect(markup).toContain('value="cross">叉积');
    expect(markup).toContain('value="transform-position">变换位置');
    expect(markup).toContain('value="one-minus">一减');
    expect(markup).toContain('value="smoothstep">平滑阶梯');
    // 注册表 min/max 曾缺席导致下拉点选抛错——调色板改为注册表单源后此回归被钉死。
    expect(markup).toContain('value="min">最小值');
    expect(markup).toContain('value="max">最大值');
  });

  it("lists attributed issues with locate buttons and marks the offending node", () => {
    const markup = renderToStaticMarkup(<ShaderNodeCanvas locale="zh-CN" asset={asset({
      nodes: [{ id: "ss-1", op: "smoothstep", type: "f32" }],
    })} onAssetChange={NOOP} />);
    expect(markup).toContain('class="shader-node-canvas-status error"');
    expect(markup).toContain("1 错误 · 0 警告");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Node ss-1 (smoothstep) expects 3 inputs, 0 connected.");
    expect(markup).toContain("定位 ss-1");
    expect(markup).toContain("shader-node-invalid");
  });

  it("a clean graph renders no issue list and reports validity", () => {
    const markup = renderToStaticMarkup(<ShaderNodeCanvas locale="zh-CN" asset={asset({
      nodes: [{ id: "c-1", op: "literal", type: "f32", config: { value: 1 } }],
    })} onAssetChange={NOOP} />);
    expect(markup).not.toContain("shader-node-canvas-issues");
    expect(markup).toContain("图有效");
    expect(markup).not.toContain("shader-node-invalid");
  });

  it("english locale renders labels and status without chinese", () => {
    const markup = renderToStaticMarkup(<ShaderNodeCanvas locale="en-US" asset={asset({
      nodes: [{ id: "ss-1", op: "smoothstep", type: "f32" }],
    })} onAssetChange={NOOP} />);
    expect(markup).toContain("0 warnings");
    expect(markup).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
