import { describe, expect, it } from "vitest";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import { SceneAnimationMixer } from "./SceneAnimationMixer.js";
import { AnimationError, type AnimationClipInput } from "./types.js";

describe("SceneAnimationMixer playback", () => {
  it("supports loop, clamp, negative time scale, and seek", () => {
    const graph = graphWithNodes("loop", "clamp", "reverse");
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(linearClip("move", ["loop", "clamp", "reverse"], 0, 10));
    mixer.play({ id: "loop-layer", clipId: "move", time: 0.75, wrapMode: "loop", nodeMask: ["loop"] });
    mixer.play({ id: "clamp-layer", clipId: "move", time: 0.75, wrapMode: "clamp", nodeMask: ["clamp"] });
    mixer.play({ id: "reverse-layer", clipId: "move", time: 0.25, timeScale: -1, wrapMode: "loop", nodeMask: ["reverse"] });
    const result = mixer.sampleAndApply(graph, 0.5);
    expect(result.updatedNodeIds).toEqual(["clamp", "loop", "reverse"]);
    expect(x(graph, "loop")).toBeCloseTo(2.5);
    expect(x(graph, "clamp")).toBe(10);
    expect(x(graph, "reverse")).toBeCloseTo(7.5);
    mixer.seek("loop-layer", 0.5);
    mixer.setTimeScale("loop-layer", 0);
    mixer.sampleAndApply(graph, 0);
    expect(x(graph, "loop")).toBe(5);
  });

  it("cross-fades override layers with deterministic normalized quaternion blending", () => {
    const graph = graphWithNodes("node");
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(constantClip("idle", "node", 0, [0, 0, 0, 1]));
    mixer.registerClip(constantClip("active", "node", 10, [0, 1, 0, 0]));
    mixer.play({ id: "idle-layer", clipId: "idle", wrapMode: "clamp" });
    mixer.sampleAndApply(graph, 0);
    mixer.crossFade("idle-layer", { id: "active-layer", clipId: "active", wrapMode: "clamp" }, 2);
    const middle = mixer.sampleAndApply(graph, 1);
    expect(x(graph, "node")).toBeCloseTo(5);
    const rotation = trs(graph, "node").rotation;
    expect(Math.hypot(...rotation)).toBeCloseTo(1, 12);
    expect(Math.abs(rotation[1])).toBeCloseTo(Math.SQRT1_2, 8);
    expect(middle.activeLayers).toBe(2);
    expect(mixer.sampleAndApply(graph, 1).activeLayers).toBe(1);
    expect(x(graph, "node")).toBe(10);
  });

  it("rebases an interrupted layer set from the graph's exact current pose", () => {
    const graph = graphWithNodes("node"), mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(linearClip("first", ["node"], 0, 10));
    mixer.registerClip(linearClip("latest", ["node"], 10, 20));
    mixer.play({ id: "first-layer", clipId: "first", time: 0.5, timeScale: 0, wrapMode: "clamp" });
    mixer.sampleAndApply(graph, 0);
    expect(x(graph, "node")).toBe(5);

    expectCode(() => mixer.rebaseFromCurrentGraphPose(), "invalid-layer");
    mixer.stop("first-layer");
    mixer.rebaseFromCurrentGraphPose();
    mixer.play({ id: "latest-layer", clipId: "latest", time: 0, timeScale: 0, wrapMode: "clamp", weight: 0 });
    mixer.fade("latest-layer", 1, 1);
    mixer.sampleAndApply(graph, 0);
    expect(x(graph, "node")).toBe(5);
    mixer.sampleAndApply(graph, 0.5);
    expect(x(graph, "node")).toBe(7.5);
  });

  it("combines override and additive layers relative to the additive reference pose", () => {
    const graph = graphWithNodes("node");
    graph.update("node", { localTransform: trsAt(10) });
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(linearClip("override", ["node"], 10, 20));
    mixer.registerClip(linearClip("offset", ["node"], 0, 4));
    mixer.play({ id: "override-layer", clipId: "override", time: 1, wrapMode: "clamp", weight: 0.5 });
    mixer.play({ id: "add-layer", clipId: "offset", time: 1, wrapMode: "clamp", blendMode: "additive", weight: 0.5 });
    mixer.sampleAndApply(graph, 0);
    expect(x(graph, "node")).toBe(17);
  });

  it("applies additive scale and shortest-arc rotation deltas", () => {
    const graph = graphWithNodes("node");
    graph.update("node", { localTransform: { ...trsAt(0), scale: [2, 2, 2] } });
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip({ id: "additive", duration: 1, tracks: [
      { nodeId: "node", path: "scale", interpolation: "LINEAR", times: [0, 1], values: [1, 1, 1, 3, 3, 3] },
      { nodeId: "node", path: "rotation", interpolation: "LINEAR", times: [0, 1], values: [0, 0, 0, 1, 0, 1, 0, 0] },
    ] });
    mixer.play({ id: "add", clipId: "additive", time: 1, wrapMode: "clamp", blendMode: "additive", weight: 0.5 });
    mixer.sampleAndApply(graph, 0);
    const transform = trs(graph, "node");
    expect(transform.scale).toEqual([3, 3, 3]);
    expect(Math.abs(transform.rotation[1])).toBeCloseTo(Math.SQRT1_2, 8);
    expect(Math.abs(transform.rotation[3])).toBeCloseTo(Math.SQRT1_2, 8);
  });

  it("applies node masks and commits all sampled nodes in one graph generation", () => {
    const graph = graphWithNodes("a", "b");
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(linearClip("both", ["b", "a"], 0, 10));
    mixer.play({ id: "masked", clipId: "both", time: 1, wrapMode: "clamp", nodeMask: ["b"] });
    const generation = graph.generation;
    const result = mixer.sampleAndApply(graph, 0);
    expect(result.updatedNodeIds).toEqual(["b"]);
    expect(graph.generation).toBe(generation + 1);
    expect(x(graph, "a")).toBe(0);
    expect(x(graph, "b")).toBe(10);
  });
});

describe("SceneAnimationMixer failure closure and bounds", () => {
  it("does not advance time or partially update when a matrix target rejects the batch", () => {
    const graph = graphWithNodes("a");
    graph.create({ id: "b", localTransform: { kind: "matrix", matrix: [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } });
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(linearClip("clip", ["a", "b"], 0, 10));
    mixer.play({ id: "layer", clipId: "clip", wrapMode: "clamp" });
    const generation = graph.generation;
    expectCode(() => mixer.sampleAndApply(graph, 0.5), "matrix-target");
    expect(graph.generation).toBe(generation);
    expect(x(graph, "a")).toBe(0);
    graph.update("b", { localTransform: trsAt(0) });
    mixer.sampleAndApply(graph, 0.5);
    expect(x(graph, "a")).toBe(5);
  });

  it("rolls back earlier node writes when a later graph update rejects derived overflow", () => {
    const graph = graphWithNodes("a", "root");
    graph.create({ id: "child", parent: "root", localBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      localTransform: { ...trsAt(0), scale: [1e15, 1, 1] } });
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip({ id: "overflow", duration: 1, tracks: [
      { nodeId: "a", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [0, 0, 0, 10, 0, 0] },
      { nodeId: "root", path: "scale", interpolation: "LINEAR", times: [0, 1], values: [1, 1, 1, 1e15, 1, 1] },
    ] });
    mixer.play({ id: "layer", clipId: "overflow", wrapMode: "clamp" });
    const generation = graph.generation;
    expectCode(() => mixer.sampleAndApply(graph, 0.5), "graph-rejected");
    expect(graph.generation).toBe(generation);
    expect(x(graph, "a")).toBe(0);
    graph.update("child", { localTransform: trsAt(0) });
    mixer.sampleAndApply(graph, 0);
    expect(x(graph, "a")).toBe(0);
  });

  it("rejects invalid time, duplicate tracks/layers, missing nodes, and invalid masks", () => {
    const graph = graphWithNodes("node");
    const mixer = new SceneAnimationMixer<string>();
    const clip = linearClip("clip", ["node"], 0, 1);
    mixer.registerClip(clip);
    expectCode(() => mixer.registerClip(clip), "duplicate-clip");
    mixer.play({ id: "layer", clipId: "clip" });
    expectCode(() => mixer.play({ id: "layer", clipId: "clip" }), "duplicate-layer");
    expectCode(() => mixer.sampleAndApply(graph, Number.NaN), "invalid-time");
    expectCode(() => mixer.play({ id: "mask", clipId: "clip", nodeMask: ["node", "node"] }), "invalid-layer");
    const missing = new SceneAnimationMixer<string>();
    missing.registerClip(linearClip("missing", ["ghost"], 0, 1));
    missing.play({ id: "missing-layer", clipId: "missing" });
    expectCode(() => missing.sampleAndApply(graph, 0), "missing-node");
  });

  it("reuses bounded scratch storage across deterministic 10k-node frames", () => {
    const count = 10_000;
    const graph = new SceneTransformGraph<number>({ maxNodes: count });
    graph.transaction((draft) => { for (let id = count - 1; id >= 0; id -= 1) draft.create({ id }); });
    const tracks = Array.from({ length: count }, (_, id) => ({
      nodeId: id, path: "translation" as const, interpolation: "STEP" as const, times: [0], values: [1, 0, 0],
    })).reverse();
    const mixer = new SceneAnimationMixer<number>({ maxTracksPerClip: count, maxAnimatedNodes: count });
    mixer.registerClip({ id: "static", duration: 0, tracks });
    mixer.play({ id: "layer", clipId: "static", wrapMode: "clamp" });
    const first = mixer.sampleAndApply(graph, 0);
    expect(first.updatedNodeIds).toHaveLength(count);
    expect(first.updatedNodeIds.slice(0, 3)).toEqual([0, 1, 2]);
    expect(mixer.stats.pooledNodeAccumulators).toBe(count);
    const generation = graph.generation;
    expect(mixer.sampleAndApply(graph, 0).updatedNodeIds).toEqual([]);
    expect(mixer.stats.pooledNodeAccumulators).toBe(count);
    expect(graph.generation).toBe(generation);
  });
});

function graphWithNodes(...ids: string[]): SceneTransformGraph<string> {
  const graph = new SceneTransformGraph<string>();
  graph.transaction((draft) => { for (const id of ids) draft.create({ id }); });
  return graph;
}

function linearClip(id: string, nodes: readonly string[], from: number, to: number): AnimationClipInput<string> {
  return { id, duration: 1, tracks: nodes.map((nodeId) => ({ nodeId, path: "translation", interpolation: "LINEAR",
    times: [0, 1], values: [from, 0, 0, to, 0, 0] })) };
}

function constantClip(id: string, nodeId: string, translation: number, rotation: readonly [number, number, number, number]): AnimationClipInput<string> {
  return { id, duration: 0, tracks: [
    { nodeId, path: "translation", interpolation: "STEP", times: [0], values: [translation, 0, 0] },
    { nodeId, path: "rotation", interpolation: "STEP", times: [0], values: rotation },
  ] };
}

function trsAt(value: number) {
  return { kind: "trs" as const, translation: [value, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
function trs(graph: SceneTransformGraph<string>, id: string) {
  const transform = graph.getNode(id)!.localTransform;
  if (transform.kind !== "trs") throw new Error("Expected TRS.");
  return transform;
}
function x(graph: SceneTransformGraph<string>, id: string): number { return trs(graph, id).translation[0]; }
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected animation operation to fail."); }
  catch (error) { expect(error).toBeInstanceOf(AnimationError); expect((error as AnimationError).code).toBe(code); }
}
