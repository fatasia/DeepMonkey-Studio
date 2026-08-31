import { describe, expect, it } from "vitest";
import { fragmentPropertyValue, humanizeIfcCategory, setTreeLock, setTreeVisibility } from "./fragmentTree";
import type { LayerTreeNode } from "./viewerTypes";

function tree(): LayerTreeNode {
  const child: LayerTreeNode = { id: "child", modelId: "model", name: "Child", type: "Element", visible: true, locked: false, deleted: false, children: [] };
  return { id: "root", modelId: "model", name: "Root", type: "Model", visible: true, locked: false, deleted: false, children: [child] };
}

describe("fragment tree", () => {
  it("propagates visibility and lock state through descendants", () => {
    const root = tree();
    setTreeVisibility(root, false);
    setTreeLock(root, true);
    expect(root).toMatchObject({ visible: false, locked: true, children: [{ visible: false, locked: true }] });
  });

  it("normalizes IFC labels and resolves properties case-insensitively", () => {
    expect(humanizeIfcCategory("IFCCurtainWall")).toBe("Curtain Wall");
    expect(fragmentPropertyValue({ GlobalId: "abc" }, ["globalid"])).toBe("abc");
  });
});
