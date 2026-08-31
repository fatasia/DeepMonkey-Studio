import { describe, expect, it } from "vitest";
import {
  applyTopologyEditorAction,
  assessTopologyScadaRuntime,
  canRedoTopologyEdit,
  canUndoTopologyEdit,
  createTopologyDocument,
  createTopologyEdge,
  createTopologyEditorState,
  createTopologyNode,
  createTopologyScadaNode,
  isTopologyScadaNode,
  summarizeTopologyScadaRuntime,
  topologyNodeDataBinding,
  topologyNodeLabel,
  topologyNodeScadaConfig
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

  it("creates lightweight SCADA nodes and parses point and alarm configuration", () => {
    const node = createTopologyScadaNode("pump-1", "pump", 80, 100, "循环泵");
    expect(isTopologyScadaNode(node)).toBe(true);
    expect(topologyNodeScadaConfig(node)).toEqual({ tag: "", unit: "", alarmSeverity: "warning" });

    const configured = {
      ...node,
      properties: { ...node.properties, scada: { tag: "P-101.PV", unit: "bar", lowAlarm: 1.2, highAlarm: 6.5, alarmSeverity: "critical" } }
    };
    expect(topologyNodeScadaConfig(configured)).toEqual({ tag: "P-101.PV", unit: "bar", lowAlarm: 1.2, highAlarm: 6.5, alarmSeverity: "critical" });
  });

  it("assesses SCADA timestamp freshness and value quality without mutating runtime snapshots", () => {
    const now = Date.parse("2026-08-27T10:00:00.000Z");
    const snapshot = { state: "running", value: 12.5, quality: "uncertain", updatedAt: "2026-08-27T09:59:20.000Z" } as const;

    expect(assessTopologyScadaRuntime(snapshot, now, 60_000)).toEqual({ freshness: "fresh", quality: "uncertain", ageMs: 40_000, healthy: false });
    expect(assessTopologyScadaRuntime({ ...snapshot, quality: "good", updatedAt: "2026-08-27T09:58:00.000Z" }, now, 60_000)).toEqual({ freshness: "stale", quality: "good", ageMs: 120_000, healthy: false });
    expect(assessTopologyScadaRuntime({ state: "running", updatedAt: "not-a-date" }, now, 60_000).freshness).toBe("invalid");
    expect(assessTopologyScadaRuntime(undefined, now, 60_000).freshness).toBe("missing");
    expect(snapshot).toEqual({ state: "running", value: 12.5, quality: "uncertain", updatedAt: "2026-08-27T09:59:20.000Z" });
  });

  it("summarizes missing, stale, bad-quality and unacknowledged SCADA nodes", () => {
    const nodes = [
      createTopologyScadaNode("pump-1", "pump", 0, 0),
      createTopologyScadaNode("valve-1", "valve", 100, 0),
      createTopologyScadaNode("meter-1", "meter", 200, 0),
      createTopologyNode("note-1", "note", 300, 0)
    ];
    const summary = summarizeTopologyScadaRuntime(nodes, {
      "pump-1": { state: "running", quality: "good", updatedAt: "2026-08-27T09:59:50.000Z" },
      "valve-1": { state: "alarm", quality: "bad", updatedAt: "2026-08-27T09:58:00.000Z", alarm: { active: true, severity: "critical", message: "卡涩" } }
    }, Date.parse("2026-08-27T10:00:00.000Z"), 60_000);

    expect(summary).toEqual({
      total: 3,
      healthy: 1,
      missing: 1,
      undated: 0,
      stale: 1,
      invalidTimestamp: 0,
      uncertainQuality: 0,
      badQuality: 1,
      offline: 0,
      activeAlarms: 1,
      unacknowledgedAlarms: 1
    });
  });

  it("rejects dangling, self, and duplicate directed edges", () => {
    let state = populatedState();
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("dangling", "node-a", "missing") })).toThrow("不存在");
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("self", "node-a", "node-a") })).toThrow("自身");

    state = applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b", "node-a", "node-b") });
    expect(() => applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b-2", "node-a", "node-b") })).toThrow("已存在");
  });

  it("updates SCADA flow properties as one undoable edge edit", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, { type: "edge.add", edge: createTopologyEdge("edge-a-b", "node-a", "node-b") });
    state = applyTopologyEditorAction(state, { type: "edge.update", edgeId: "edge-a-b", patch: { properties: { label: "冷却水", medium: "water", animated: true } } });
    expect(state.document.edges[0]?.properties).toEqual({ label: "冷却水", medium: "water", animated: true });
    state = applyTopologyEditorAction(state, { type: "history.undo" });
    expect(state.document.edges[0]?.properties).toEqual({});
  });

  it("clears redo history when a new edit branches from an undo", () => {
    let state = populatedState();
    state = applyTopologyEditorAction(state, { type: "history.undo" });
    expect(canRedoTopologyEdit(state)).toBe(true);
    state = applyTopologyEditorAction(state, { type: "document.rename", name: "新拓扑" });
    expect(canRedoTopologyEdit(state)).toBe(false);
  });
});
