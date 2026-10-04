import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MaterialGraphEditor } from "./MaterialGraphEditor";
import { MaterialGraphCanvas, NODE_HEIGHT, NODE_WIDTH, defaultNodeLayout } from "./MaterialGraphCanvas";
import type { MaterialGraphNode } from "../materials/materialGraphModel";
import { createLayer, createMaterialGraph, deriveGraphEdges, deriveGraphNodes } from "../materials/materialGraphModel";

const NOOP = () => {};
const MATERIAL = { color: "#2f80ed", metalness: 0.2, roughness: 0.45 };

/** 静态结构与可自动化钩子(renderToStaticMarkup 与仓内组件测试同规)。 */
describe("MaterialGraphEditor", () => {
  it("渲染面板骨架:details+summary+接管按钮+状态行,data-qa 钩子齐全", () => {
    const markup = renderToStaticMarkup(
      <MaterialGraphEditor locale="zh-CN" disabled={false} sceneId="s1" modelId="m1" material={MATERIAL} onApplyMaterialPatch={NOOP} />,
    );
    expect(markup).toContain('data-qa="material-graph-editor"');
    expect(markup).toContain('data-qa="material-graph-link"');
    expect(markup).toContain('data-qa="material-graph-status"');
    expect(markup).toContain("接管对象材质");
    expect(markup).toContain("0/4");
    expect(markup).toContain("未接管");
  });

  it("禁用态:接管按钮 disabled", () => {
    const markup = renderToStaticMarkup(
      <MaterialGraphEditor locale="zh-CN" disabled sceneId="s1" modelId="m1" material={MATERIAL} onApplyMaterialPatch={NOOP} />,
    );
    expect(markup).toMatch(/data-qa="material-graph-link"[^>]*disabled/);
  });

  it("空图也渲染画布:输出+底材质两节点一条边", () => {
    const graph = createMaterialGraph("空图", MATERIAL);
    const nodes = deriveGraphNodes(graph);
    expect(nodes).toHaveLength(2);
    expect(deriveGraphEdges(graph)).toHaveLength(1);
    const markup = renderToStaticMarkup(
      <MaterialGraphCanvas locale="zh-CN" nodes={nodes} edges={deriveGraphEdges(graph)} positions={{}} selectedId={undefined} disabled={false} onSelect={NOOP} onPositionsChange={NOOP} />,
    );
    expect(markup).toContain("material-graph-canvas");
    expect(markup).toContain('data-node-id="output"');
    expect(markup).toContain('data-node-id="base"');
  });
});

/** 画布布局派生:确定性、遮罩节点挂其层下方、边界含全部节点。 */
describe("MaterialGraphCanvas layout", () => {
  it("defaultNodeLayout:base/输出顶行、layer 中列、mask 在所属层左下且右端口不越过层左缘", () => {
    const graph = { ...createMaterialGraph("布局"), layers: [createLayer("wear", "磨损"), createLayer("dust", "灰尘")] };
    const nodes = deriveGraphNodes(graph) as MaterialGraphNode[];
    const layout = defaultNodeLayout(nodes);
    expect(layout.base).toEqual({ x: 0, y: 10 });
    expect(layout.output).toEqual({ x: (NODE_WIDTH + 88) * 2, y: 10 });
    const layerNodes = nodes.filter(node => node.kind === "layer");
    const firstLayerLayout = layout[layerNodes[0]!.id]!;
    const secondLayerLayout = layout[layerNodes[1]!.id]!;
    expect(firstLayerLayout.y).toBeLessThan(secondLayerLayout.y);
    const maskNodes = nodes.filter(node => node.kind === "mask");
    for (const mask of maskNodes) {
      const owner = layout[mask.layerId ?? ""]!;
      const maskLayout = layout[mask.id]!;
      expect(maskLayout.y).toBeGreaterThan(owner.y);
      // 遮罩右端口 (x+NODE_WIDTH) 仍在层左缘 (owner.x) 之前 → 连线正向流动
      expect(maskLayout.x + NODE_WIDTH).toBeLessThan(owner.x);
    }
    // 同输入两次布局逐键相等
    expect(JSON.stringify(defaultNodeLayout(nodes))).toBe(JSON.stringify(defaultNodeLayout(nodes)));
  });
});
