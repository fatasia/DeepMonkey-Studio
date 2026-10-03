import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import {
  addNode, canvasEdges, canvasNodes, connect, disconnect,
  fragmentStageOf, registryByCategory, removeNode, updateNodeConfig,
} from "./shaderNodeCanvasModel.js";

function emptyAsset(): ShaderGraphAssetV1 {
  return {
    schemaVersion: 1,
    id: "test-graph",
    target: "webgpu-forward",
    properties: [],
    stages: [{ stage: "fragment", nodes: [], edges: [], outputs: [] }],
  };
}

describe("shader node canvas model", () => {
  it("registry groups 17 ops into five categories", () => {
    const groups = registryByCategory();
    expect(Object.keys(groups).sort()).toEqual(["input", "math", "stage", "texture"]);
  });

  it("addNode appends to fragment stage with deterministic ids and literal default config", () => {
    let asset = emptyAsset();
    const first = addNode(asset, "add");
    asset = first.asset;
    const second = addNode(asset, "add");
    asset = second.asset;
    const nodes = canvasNodes(asset);
    expect(nodes.map(n => n.id)).toEqual(["add-1", "add-2"]);
    expect(nodes[0]!.label).toBe("Add");
  });

  it("connect then disconnect manages edges by target input slot", () => {
    let asset = emptyAsset();
    asset = addNode(asset, "add").asset;
    asset = addNode(asset, "literal").asset;
    const ids = canvasNodes(asset).map(n => n.id);
    asset = connect(asset, ids[1]!, ids[0]!, 0);
    expect(canvasEdges(asset).map(e => [e.source, e.target, e.targetHandle])).toEqual([[ids[1], ids[0], "in-0"]]);
    // 同槽位重连替换旧边
    asset = addNode(asset, "multiply").asset;
    const third = canvasNodes(asset).map(n => n.id)[2]!;
    asset = connect(asset, third, ids[0]!, 0);
    const edges = canvasEdges(asset);
    expect(edges.length).toBe(1);
    expect(edges[0]!.source).toBe(third);
    // 断开
    asset = disconnect(asset, third, ids[0]!, 0);
    expect(canvasEdges(asset).length).toBe(0);
  });

  it("updateNodeConfig edits literal value", () => {
    let asset = addNode(emptyAsset(), "literal").asset;
    const id = canvasNodes(asset)[0]!.id;
    asset = updateNodeConfig(asset, id, { value: 3 });
    expect(canvasNodes(asset)[0]!.config).toEqual({ value: 3 });
  });

  it("removeNode drops the node and its edges", () => {
    let asset = emptyAsset();
    asset = addNode(asset, "add").asset;
    asset = addNode(asset, "literal").asset;
    const ids = canvasNodes(asset).map(n => n.id);
    asset = connect(asset, ids[1]!, ids[0]!, 0);
    asset = removeNode(asset, ids[1]!);
    expect(canvasNodes(asset).map(n => n.id)).not.toContain(ids[1]);
    expect(canvasEdges(asset).length).toBe(0);
  });

  it("fragmentStageOf returns an empty stage for assets without one", () => {
    const stage = fragmentStageOf(emptyAsset());
    expect(stage.stage).toBe("fragment");
    expect(stage.nodes).toEqual([]);
  });
});
