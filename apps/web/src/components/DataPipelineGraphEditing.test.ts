import { describe, expect, it } from "vitest";
import type { DataPipelineDefinition, DataPipelineNode } from "@bim-studio/contracts";
import { validateDataPipeline } from "@bim-studio/data-runtime/pipeline";
import { insertPipelineNodeAfter, pipelineConnectionIssue, removePipelineNode } from "./DataPipelineEditing";
import { derivePipelineFieldHints } from "./DataPipelineStudioParts";
import { graphEdgeLanes, graphEdgeSides, layoutWorkbenchGraph } from "./workbenchGraphLayout";

const source: DataPipelineNode = { id: "source", type: "source", name: "源", datasetId: "dataset", position: { x: 20, y: 80 } };
const filter: DataPipelineNode = { id: "filter", type: "filter", name: "过滤", formula: "TRUE", position: { x: 330, y: 240 } };
const output: DataPipelineNode = { id: "output", type: "output", name: "输出", position: { x: 650, y: 80 } };
function draft(nodes: DataPipelineNode[] = [source, filter, output], pairs = [["source", "filter"], ["filter", "output"]]): DataPipelineDefinition {
  return { id: "pipeline", projectId: "project", name: "流程", createdAt: "", updatedAt: "", nodes,
    edges: pairs.map(([sourceNodeId, targetNodeId], index) => ({ id: `edge-${index}`, sourceNodeId: sourceNodeId!, targetNodeId: targetNodeId! })) };
}
const formula: DataPipelineNode = { id: "formula", type: "formula", name: "计算", key: "new_field", label: "计算值", fieldType: "number", formula: "1", position: { x: 320, y: 480 } };
const merge: DataPipelineNode = { id: "merge", type: "merge", name: "合并", position: { x: 660, y: 320 } };

describe("pipeline graph editing", () => {
  it("splices a transform into the chosen branch without moving or rewriting other branches", () => {
    const original = draft([source, filter, formula, merge, output], [["source", "filter"], ["source", "formula"], ["filter", "merge"], ["formula", "merge"], ["merge", "output"]]);
    const inserted: DataPipelineNode = { id: "limit", type: "limit", name: "限量", count: 2, position: { x: 0, y: 0 } };
    const next = insertPipelineNodeAfter(original, inserted, "filter");
    expect(next.nodes.find(node => node.id === "formula")).toBe(formula);
    expect(next.edges.find(edge => edge.id === "edge-3")).toEqual(original.edges[3]);
    expect(next.edges.find(edge => edge.id === "edge-2")).toMatchObject({ sourceNodeId: "limit", targetNodeId: "merge" });
    expect(validateDataPipeline(next).map(node => node.id)).toContain("limit");
    expect(original.edges[2]?.sourceNodeId).toBe("filter");
  });
  it("preserves downstream edge identity when removing a single-input transform", () => {
    const next = removePipelineNode(draft(), "filter");
    expect(next.edges).toEqual([{ id: "edge-1", sourceNodeId: "source", targetNodeId: "output" }]);
    expect(next.nodes.map(node => node.position)).toEqual([source.position, output.position]);
    expect(validateDataPipeline(next)).toHaveLength(2);
  });
  it("requires explicit rewiring after deleting a multi-input merge", () => {
    const next = removePipelineNode(draft([source, filter, formula, merge, output], [["source", "filter"], ["source", "formula"], ["filter", "merge"], ["formula", "merge"], ["merge", "output"]]), "merge");
    expect(next.edges.some(edge => edge.targetNodeId === "output")).toBe(false);
    expect(() => validateDataPipeline(next)).toThrow();
  });
  it.each([["source", "source"], ["output", "filter"], ["filter", "source"], ["missing", "output"], ["source", "filter"], ["source", "output"]])("rejects invalid edit %s → %s", (from, to) => {
    expect(pipelineConnectionIssue(draft(), from, to)).toBeTypeOf("string");
  });
  it("rejects cycles through existing paths even for merge targets", () => {
    const graph = draft([source, merge, filter, output], [["source", "merge"], ["merge", "filter"], ["filter", "output"]]);
    expect(pipelineConnectionIssue(graph, "filter", "merge")).toContain("环路");
  });
  it("accepts a second merge input and excludes the original edge while reconnecting", () => {
    const graph = draft([source, formula, merge, output], [["source", "merge"], ["source", "formula"], ["merge", "output"]]);
    expect(pipelineConnectionIssue(graph, "formula", "merge")).toBeUndefined();
    expect(pipelineConnectionIssue(draft(), "source", "filter", "edge-0")).toBeUndefined();
  });
  it("does not resurrect a deliberately disconnected topology during insertion", () => {
    const next = insertPipelineNodeAfter(draft(undefined, []), formula, "source");
    expect(next.edges.map(edge => edge.targetNodeId)).toEqual(["formula"]);
  });
  it("resolves schema through connections, excluding unrelated transforms despite array order", () => {
    const graph = draft([source, formula, filter, output], [["source", "filter"], ["filter", "output"]]);
    expect(derivePipelineFieldHints(graph.nodes, "output", [{ key: "value", label: "值", type: "number" }], graph.edges).map(field => field.key)).toEqual(["value"]);
  });
});

describe("workbench graph geometry", () => {
  it("lays out all nodes independently without overlap, including disconnected assets", () => {
    const positions = layoutWorkbenchGraph(["source", "a", "b", "detached"], [{ source: "source", target: "a" }, { source: "source", target: "b" }]);
    expect(new Set([...positions.values()].map(point => `${point.x},${point.y}`)).size).toBe(4);
    for (const point of positions.values()) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
    expect(positions.get("a")!.x).toBeGreaterThan(positions.get("source")!.x);
  });
  it.each([[100, 0, "right", "left"], [-100, 0, "left", "right"], [0, 100, "bottom", "top"], [0, -100, "top", "bottom"]])("anchors a relation in direction %s,%s", (x, y, from, to) => {
    expect(graphEdgeSides({ x: 0, y: 0 }, { x: Number(x), y: Number(y) })).toEqual({ sourceHandle: from, targetHandle: to });
  });
  it("assigns distinct physical curves to parallel and opposing relations", () => {
    const lanes = graphEdgeLanes([{ id: "ab", source: "a", target: "b" }, { id: "ba", source: "b", target: "a" }, { id: "ab2", source: "a", target: "b" }]);
    expect(new Set([lanes.get("ab"), -lanes.get("ba")!, lanes.get("ab2")]).size).toBe(3);
  });
});
