import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "@bim-studio/deep-engine/shader-graph";
import {
  SURFACE_FIELD_KEYS, addNode, bindSurfaceField, canvasEdges, canvasNodes, connect, disconnect,
  diagnosticEdgeKeys, diagnosticNodeIds, emptyShaderGraph, fragmentStageOf, graphDiagnostics,
  loadShaderGraphDraft, registryByCategory, removeNode,
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
  it("registry groups all ops into six categories including the geometry family", () => {
    const groups = registryByCategory();
    expect(Object.keys(groups).sort()).toEqual(["geometry", "input", "math", "stage", "texture"]);
    expect(groups.geometry).toEqual(["cross", "scale", "transform-direction", "transform-position"]);
    expect(groups.math!.length).toBeGreaterThanOrEqual(20);
  });

  it("addNode defaults texture-sample config and fixed output types from the registry ports", () => {
    const sampler = addNode(emptyAsset(), "texture-sample");
    expect(canvasNodes(sampler.asset)[0]!.config).toEqual({ texture: "", sampler: "" });
    const cross = addNode(emptyAsset(), "cross");
    expect(canvasNodes(cross.asset)[0]).toMatchObject({ op: "cross", type: "vec3f" });
    const position = addNode(emptyAsset(), "transform-position");
    expect(canvasNodes(position.asset)[0]).toMatchObject({ op: "transform-position", type: "vec4f" });
  });

  it("canvasNodes exposes the op and canvasEdges carry engine-compatible diagnostic keys", () => {
    let asset = addNode(emptyAsset(), "one-minus").asset;
    asset = addNode(asset, "literal").asset;
    const ids = canvasNodes(asset).map(n => n.id);
    asset = connect(asset, ids[1]!, ids[0]!, 0);
    expect(canvasNodes(asset).map(n => n.op)).toEqual(["one-minus", "literal"]);
    expect(canvasEdges(asset)[0]).toMatchObject({ source: ids[1], target: ids[0], key: `${ids[0]}#0` });
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

/** 诊断组合:错误/警告分层并归因到节点与边;降级链失败透传 nodeId,不再只剩「输入待补全」。 */
describe("shader canvas graph diagnostics", () => {
  it("surfaces incomplete inputs as attributed errors while the draft itself stays loadable", () => {
    let asset = addNode(emptyAsset(), "smoothstep").asset;
    const issues = graphDiagnostics(asset);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "missing-input", nodeId: "smoothstep-1" });
    expect(diagnosticNodeIds(issues).has("smoothstep-1")).toBe(true);
    expect(diagnosticEdgeKeys(issues).size).toBe(0);
  });

  it("passes lowering failures through with the offending node id and no duplicate rows", () => {
    let asset = addNode(emptyAsset(), "add").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    const literal = addNode(asset, "literal");
    asset = literal.asset;
    asset = connect(asset, canvasNodes(asset)[1]!.id, nodeId, 1);
    const issues = graphDiagnostics(asset);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", code: "missing-input", nodeId });
    expect(diagnosticNodeIds(issues)).toEqual(new Set([nodeId]));
  });

  it("empty graphs and complete drafts report no diagnostics", () => {
    expect(graphDiagnostics(emptyShaderGraph())).toEqual([]);
    let asset = addNode(emptyShaderGraph(), "literal").asset;
    const nodeId = canvasNodes(asset)[0]!.id;
    asset = bindSurfaceField(asset, "metallic", nodeId);
    expect(graphDiagnostics(asset)).toEqual([]);
  });
});
