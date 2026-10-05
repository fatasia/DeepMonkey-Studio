import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { CustomShaderEditor } from "./CustomShaderEditor";

const NOOP = () => {};
const UNBOUND = { color: "#2f80ed", metalness: 0.2, roughness: 0.45 } as SceneMaterialState;
const BOUND = {
  ...UNBOUND,
  customShader: { source: "shader deep.material {\n  surface standard;\n}" },
} as SceneMaterialState;

/** 静态结构与可自动化钩子(renderToStaticMarkup 与仓内组件测试同规;节点图页签的
 *  草稿态逻辑在 shaderNodeCanvasModel.test.ts 全覆盖,ReactFlow 画布不进静态断言)。 */
describe("CustomShaderEditor", () => {
  it("渲染 DeepSL 摘要与双模式页签;未绑定时标注并默认收起", () => {
    const markup = renderToStaticMarkup(
      <CustomShaderEditor locale="zh-CN" disabled={false} material={UNBOUND} onChange={NOOP} />,
    );
    expect(markup).toContain("DeepSL");
    expect(markup).toContain("未绑定");
    expect(markup).toContain("源码");
    expect(markup).toContain("节点图");
    expect(markup).not.toContain("已绑定");
  });

  it("已绑定时摘要标注并默认展开,展示绑定/解绑动作", () => {
    const markup = renderToStaticMarkup(
      <CustomShaderEditor locale="zh-CN" disabled={false} material={BOUND} onChange={NOOP} storageKey="deep-shader-graph:slot-0" />,
    );
    expect(markup).toContain("已绑定");
    expect(markup).toContain("绑定到材质");
    expect(markup).toContain("解除绑定");
  });

  it("禁用态:源码输入与动作按钮 disabled", () => {
    const markup = renderToStaticMarkup(
      <CustomShaderEditor locale="zh-CN" disabled material={UNBOUND} onChange={NOOP} />,
    );
    expect(markup).toMatch(/id="custom-shader-source"[^>]*disabled/);
    expect(markup).toMatch(/disabled[^>]*>[^<]*编译诊断/s);
  });
});
