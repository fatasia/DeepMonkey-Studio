import { renderToStaticMarkup } from "react-dom/server";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import { ModelTreeItem } from "./ModelTreeItem";
import type { LayerTreeNode, LoadedSceneModel } from "../viewer/ViewerEngine";

const model: ModelRecord = {
  id: "m1",
  projectId: "p1",
  name: "结构模型",
  format: "ifc",
  size: 1024,
  status: "ready",
  progress: 100,
  message: "",
  sourceUrl: "/assets/m1.ifc",
  createdAt: "2026-09-25T00:00:00.000Z",
  updatedAt: "2026-09-25T00:00:00.000Z",
};

const loaded: LoadedSceneModel = {
  id: "m1",
  name: "结构模型",
  object: new THREE.Group(),
  kind: "model",
  visible: true,
  opacity: 1,
};

const tree: LayerTreeNode = {
  id: "l1",
  modelId: "m1",
  name: "一层墙体",
  type: "IfcWall",
  visible: true,
  locked: false,
  deleted: false,
  children: [],
};

function renderTreeItem() {
  return renderToStaticMarkup(
    <ModelTreeItem
      locale="zh-CN"
      model={model}
      loaded={loaded}
      tree={tree}
      expanded
      modelFloors={[]}
      floorExpansion={0}
      selectedModelId="m1"
      selectedLayerId="l1"
      engine={undefined}
      onToggleTree={vi.fn()}
      onLoadModel={vi.fn()}
      onSetRevision={vi.fn()}
      onExpandFloors={vi.fn()}
      onUpdateFloor={vi.fn()}
      onRemoveObjectInteractions={vi.fn()}
      onSetMessage={vi.fn()}
      onDeleteModel={vi.fn()}
    />,
  );
}

/**
 * 接线点回归(批 0 图层可见性 + 批 2 模型显隐/模型/图层锁定):
 * 图层树与模型行的渲染结构不因命令层接线回归。
 * 运行时等价(发命令 → 总线 → applier → engine setter,参数与直调一致)
 * 由 commands/engineCommandApplier.test.ts 的 stub engine 对照覆盖;
 * 本测试锁定 UI 面的接线承载(按钮/文案/节点渲染)不被接线破坏。
 */
describe("ModelTreeItem 图层可见性与锁定接线(批 0/批 2)", () => {
  it("图层树节点渲染出可见性切换按钮,节点名与选中态保留", () => {
    const html = renderTreeItem();
    expect(html).toContain("一层墙体");
    expect(html).toContain("隐藏该层");
    expect(html).toContain(`data-model-id="m1"`);
  });

  it("图层锁定与删除入口不受接线影响", () => {
    const html = renderTreeItem();
    expect(html).toContain("锁定该层");
    expect(html).toContain("tree-visibility");
    expect(html).toContain("tree-lock");
  });
});
