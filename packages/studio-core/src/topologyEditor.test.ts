import { describe, expect, it } from "vitest";
import {
  applyTopologyEditorAction,
  canRedoTopologyEdit,
  canUndoTopologyEdit,
  createTopologyDocument,
  createTopologyEdge,
  createTopologyEditorState,
  createTopologyNode,
  topologyNodeDataBinding,
  topologyNodeLabel
} from "./topologyEditor";

function populatedState() {
  let state = createTopologyEditorState(createTopologyDocument("topology-1", "产线拓扑"));
  state = applyTopologyEditorAction(state, { type: "node.add", node: createTopologyNode("node-a", "machine", 80, 100, "机床 A") });
  state = applyTopologyEditorAction(state, { type: "node.add", node: createTopologyNode("node-b", "robot", 360, 100, "机器人 B") });
  return state;
}

describe("topology editor", () => {
  it("creates nodes, connects them, and keeps the persisted document lightweight", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b", "node-a", "node-b") });

    expect(state.document.nodes.map((node) => topologyNodeLabel(node))).toEqual(["机床 A", "机器人 B"]);
    expect(state.document.edges).toEqual([{ id: "edge-a-b", sourceNodeId: "node-a", targetNodeId: "node-b", properties: {} }]);
    expect(canUndoTopologyEdit(state)).toBe(true);
  });

  it("moves multiple nodes as one undoable edit and supports redo", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, {
      type: "node.move",
      positions: [
        { nodeId: "node-a", x: 120, y: 180 },
        { nodeId: "node-b", x: 420, y: 180 }
      ]
    });
    expect(state.document.nodes.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 120, y: 180 }, { x: 420, y: 180 }]);

    state = applyTopologyEditorAction(state, { type: "history.undo" });
    expect(state.document.nodes.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 80, y: 100 }, { x: 360, y: 100 }]);
    expect(canRedoTopologyEdit(state)).toBe(true);

    state = applyTopologyEditorAction(state, { type: "history.redo" });
    expect(state.document.nodes.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 120, y: 180 }, { x: 420, y: 180 }]);
  });

  it("keeps selection outside history and removes stale selections", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, {
      type: "selection.set",
      selection: [{ kind: "node", id: "node-a" }, { kind: "node", id: "missing" }, { kind: "node", id: "node-a" }]
    });
    expect(state.selection).toEqual([{ kind: "node", id: "node-a" }]);
    expect(state.undoStack).toHaveLength(2);

    state = applyTopologyEditorAction(state, { type: "node.remove", nodeIds: ["node-a"] });
    expect(state.selection).toEqual([]);
  });

  it("deleting a node cascades its edges and undo restores both", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b", "node-a", "node-b") });
    state = applyTopologyEditorAction(state, { type: "node.remove", nodeIds: ["node-a"] });
    expect(state.document.nodes.map((node) => node.id)).toEqual(["node-b"]);
    expect(state.document.edges).toEqual([]);

    state = applyTopologyEditorAction(state, { type: "history.undo" });
    expect(state.document.nodes.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(state.document.edges).toHaveLength(1);
  });

  it("stores an explicit dataset or pipeline field binding in JSON properties", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, {
      type: "binding.set",
      nodeId: "node-a",
      binding: { productType: "pipeline", productId: "pipeline-energy", field: "power" }
    });
    expect(topologyNodeDataBinding(state.document.nodes[0]!)).toEqual({ productType: "pipeline", productId: "pipeline-energy", field: "power" });
    expect(JSON.parse(JSON.stringify(state.document)).nodes[0].properties.dataBinding).toEqual({ productType: "pipeline", productId: "pipeline-energy", field: "power" });

    state = applyTopologyEditorAction(state, { type: "binding.set", nodeId: "node-a" });
    expect(topologyNodeDataBinding(state.document.nodes[0]!)).toBeUndefined();
  });

  it("rejects dangling, self, and duplicate directed edges", () => {
    let state = populatedState();
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("dangling", "node-a", "missing") })).toThrow("不存在");
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("self", "node-a", "node-a") })).toThrow("自身");

    state = applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b", "node-a", "node-b") });
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b-2", "node-a", "node-b") })).toThrow("已存在");
  });

  it("clears redo history when a new edit branches from an undo", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, { type: "history.undo" });
    expect(canRedoTopologyEdit(state)).toBe(true);
    state = applyTopologyEditorAction(state, { type: "document.rename", name: "新拓扑" });
    expect(canRedoTopologyEdit(state)).toBe(false);
  });
});
