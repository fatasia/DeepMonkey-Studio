import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import {
  SURFACE_FIELD_KEYS, addNode, bindSurfaceField, canvasEdges, canvasNodes, connect, disconnect,
  emptyShaderGraph, fragmentStageOf, loadShaderGraphDraft, registryByCategory, removeNode,
  resolveShaderGraphDraft, saveShaderGraphDraft, surfaceBindings, updateNodeConfig,
  type KeyValueStore,
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

/** 表面输出绑定:写入形状对齐引擎 lowerOutput 的 surface 分支,删除节点同步清绑定。 */
describe("shader node surface bindings", () => {
  it("bindSurfaceField writes a surface output with engine-shaped fields and preserves earlier binds", () => {
    let asset = addNode(emptyAsset(), "multiply").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    asset = bindSurfaceField(asset, "metallic", nodeId);
    asset = bindSurfaceField(asset, "roughness", nodeId);
    const stage = fragmentStageOf(asset);
    const surface = stage.outputs.find(o => o.semantic === "surface")!;
    expect(surface).toEqual({
      semantic: "surface", model: "standard-pbr", context: "deep-lighting-v1",
      fields: { metallic: nodeId, roughness: nodeId },
    });
    expect(surfaceBindings(asset)).toEqual({ metallic: nodeId, roughness: nodeId });
  });

  it("unbind removes one field and drops the whole surface entry when the last field goes", () => {
    let asset = addNode(emptyAsset(), "multiply").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    asset = bindSurfaceField(asset, "baseColor", nodeId);
    asset = bindSurfaceField(asset, "alpha", nodeId);
    asset = bindSurfaceField(asset, "baseColor", undefined);
    expect(surfaceBindings(asset)).toEqual({ alpha: nodeId });
    asset = bindSurfaceField(asset, "alpha", undefined);
    expect(surfaceBindings(asset)).toEqual({});
    expect(fragmentStageOf(asset).outputs.some(o => o.semantic === "surface")).toBe(false);
  });

  it("removeNode clears bindings that pointed at the removed node", () => {
    let asset = addNode(emptyAsset(), "multiply").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    asset = bindSurfaceField(asset, "emission", nodeId);
    asset = removeNode(asset, nodeId);
    expect(surfaceBindings(asset)).toEqual({});
    expect(fragmentStageOf(asset).nodes).toHaveLength(0);
  });

  it("surface field keys cover the seven engine surface slots", () => {
    expect([...SURFACE_FIELD_KEYS]).toEqual(["baseColor", "normal", "metallic", "roughness", "occlusion", "emission", "alpha"]);
  });
});

/** 草稿持久化:合法资产 roundtrip;损坏/非法/键缺失一律拒载回退空白图。 */
describe("shader graph draft persistence", () => {
  function memoryStore(): KeyValueStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => { map.set(key, value); },
      removeItem: key => { map.delete(key); },
    };
  }

  it("save then load roundtrips an equal asset", () => {
    const store = memoryStore();
    let asset = addNode(emptyShaderGraph(), "add").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    asset = bindSurfaceField(asset, "baseColor", nodeId);
    saveShaderGraphDraft(store, "k1", asset);
    expect(loadShaderGraphDraft(store, "k1")).toEqual(asset);
  });

  it("rejects corrupted json, invalid graphs, and mismatched schema or target", () => {
    const store = memoryStore();
    store.setItem("corrupt", "{not json");
    store.setItem("wrong-schema", JSON.stringify({ ...emptyShaderGraph(), schemaVersion: 99 }));
    store.setItem("wrong-target", JSON.stringify({ ...emptyShaderGraph(), target: "webgpu-depth" }));
    const broken = emptyShaderGraph();
    const stage = broken.stages[0]!;
    store.setItem("invalid-graph", JSON.stringify({
      ...broken,
      stages: [{ ...stage, nodes: [
        { id: "add-1", op: "add", type: "f32" }, { id: "add-1", op: "add", type: "f32" },
      ] }],
    }));
    expect(loadShaderGraphDraft(store, "corrupt")).toBeUndefined();
    expect(loadShaderGraphDraft(store, "wrong-schema")).toBeUndefined();
    expect(loadShaderGraphDraft(store, "wrong-target")).toBeUndefined();
    expect(loadShaderGraphDraft(store, "invalid-graph")).toBeUndefined();
  });

  it("missing store or key yields undefined load and an empty resolve; save is a safe noop", () => {
    const store = memoryStore();
    expect(loadShaderGraphDraft(undefined, "k")).toBeUndefined();
    expect(loadShaderGraphDraft(store, undefined)).toBeUndefined();
    expect(resolveShaderGraphDraft(store, "missing")).toEqual(emptyShaderGraph());
    expect(() => saveShaderGraphDraft(undefined, "k", emptyShaderGraph())).not.toThrow();
    expect(store.map.size).toBe(0);
  });
});
