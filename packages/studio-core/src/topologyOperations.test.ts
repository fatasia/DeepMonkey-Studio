import { describe, expect, it } from "vitest";
import type { TopologyDocument } from "@bim-studio/contracts";
import { alignTopologyNodes, duplicateTopologySelection, layoutTopologyNodes } from "./topologyOperations.js";

function document(): TopologyDocument {
  return {
    id: "line",
    name: "产线",
    nodes: [
      { id: "a", kind: "device", x: 10, y: 20, properties: { label: "A" } },
      { id: "b", kind: "device", x: 80, y: 70, properties: { label: "B" } },
      { id: "c", kind: "device", x: 170, y: 150, properties: { label: "C" } },
    ],
    edges: [
      { id: "ab", sourceNodeId: "a", targetNodeId: "b", properties: { medium: "signal" } },
      { id: "bc", sourceNodeId: "b", targetNodeId: "c", properties: {} },
    ],
  };
}

describe("topology operations", () => {
  it("creates stable directed layers", () => {
    expect(layoutTopologyNodes(document())).toEqual([
      { nodeId: "a", x: 80, y: 80 },
      { nodeId: "b", x: 320, y: 80 },
      { nodeId: "c", x: 560, y: 80 },
    ]);
  });

  it("aligns and distributes a multi-selection", () => {
    expect(alignTopologyNodes(document(), ["a", "b", "c"], "top").map((item) => item.y)).toEqual([20, 20, 20]);
    expect(alignTopologyNodes(document(), ["a", "b", "c"], "distribute-horizontal").map((item) => item.x)).toEqual([10, 90, 170]);
  });

  it("duplicates internal relationships without copying external links", () => {
    let sequence = 0;
    const result = duplicateTopologySelection(document(), ["a", "b"], (kind) => `${kind}-${++sequence}`);
    expect(result.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ["node-1", 42, 52],
      ["node-2", 112, 102],
    ]);
    expect(result.edges).toMatchObject([{ id: "edge-3", sourceNodeId: "node-1", targetNodeId: "node-2" }]);
  });
});
