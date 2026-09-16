import { describe, expect, it } from "vitest";
import type { AnimationClipInput } from "../animation/types.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import { GltfRenderAnimationRuntime, GltfRenderAnimationRuntimeError } from "./renderAnimationRuntime.js";
import type { DecodedMorphGlb } from "./morphTypes.js";
import type { DecodedSkinnedGlb } from "./skinTypes.js";

describe("GltfRenderAnimationRuntime", () => {
  it("routes one sampled frame through fused, skin, morph, then instance targets", () => {
    const calls: string[] = [], targets = targetFixture(calls);
    const runtime = new GltfRenderAnimationRuntime(sources(), targets, instanceOptions());
    const initial = runtime.update(0);
    expect(initial).toMatchObject({ advanced: true, application: {
      frameRevision: 0, invokedTargets: 4, changedTargets: 4, skippedTargets: 0, unbound: [],
    } });
    expect(calls).toEqual(["fused:0/0", "skin:0", "morph:0", "instances:1"]);

    calls.length = 0;
    const moving = runtime.update(0.5);
    expect(moving.frame.time).toBe(0.5);
    expect(moving.application).toMatchObject({ invokedTargets: 4, changedTargets: 4, skippedTargets: 0 });
    expect(calls).toEqual(["fused:1/1", "skin:1", "morph:1", "instances:2"]);
    expect(moving.frame.instanceUpdate!.instances[0]!.transform[12]).toBe(2);

    calls.length = 0;
    expect(runtime.update(0).application).toMatchObject({ invokedTargets: 0, changedTargets: 0, skippedTargets: 4 });
    expect(calls).toEqual([]);
  });

  it("retries a partially submitted frame before consuming another delta", () => {
    const calls: string[] = [], base = targetFixture(calls);
    let failInstance = false;
    const runtime = new GltfRenderAnimationRuntime(sources(), { ...base, instances: {
      updateInstances(update) {
        calls.push(`instances:${update.instances[0]!.transform[12]}`);
        if (failInstance) { failInstance = false; throw new Error("instance upload failed"); }
        return true;
      },
    } }, instanceOptions());
    runtime.update(0); calls.length = 0; failInstance = true;

    expect(() => runtime.update(0.5)).toThrow("instance upload failed");
    expect(runtime.time).toBe(0.5); expect(runtime.hasPendingFrame).toBe(true);
    expect(() => runtime.seek(0.75)).toThrowError(expect.objectContaining({ code: "pending-frame" }));
    expect(calls).toEqual(["fused:1/1", "skin:1", "morph:1", "instances:2"]);

    calls.length = 0;
    const recovered = runtime.update(0.25);
    expect(recovered.advanced).toBe(false); expect(recovered.frame.time).toBe(0.5);
    expect(recovered.application).toMatchObject({ invokedTargets: 1, skippedTargets: 3 });
    expect(calls).toEqual(["instances:2"]); expect(runtime.hasPendingFrame).toBe(false);
    expect(runtime.update(0.25).frame.time).toBe(0.75);
  });

  it("cross-fades synchronized clips and completes once playback without a boundary wrap", () => {
    const calls: string[] = [], runtime = new GltfRenderAnimationRuntime(sources(), targetFixture(calls), instanceOptions());
    runtime.update(0.25); calls.length = 0;
    const started = runtime.crossFade({ transformClipId: "motion-2", morphClipId: "shape-2", playbackMode: "once" }, 1);
    expect(started.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo(1.5);
    expect(started.application.invokedTargets).toBe(0);

    const middle = runtime.update(0.5);
    expect(middle.frame.time).toBe(0.5); expect(runtime.isFinished).toBe(false);
    expect(middle.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo(6.25);
    expect(middle.frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(0.625);
    const completed = runtime.update(0.5);
    expect(completed.frame.time).toBe(1); expect(completed.frame.finished).toBe(true);
    expect(completed.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo(11);
    expect(completed.frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(0);

    calls.length = 0;
    const held = runtime.update(0.25);
    expect(held.frame.time).toBe(1); expect(held.application.invokedTargets).toBe(0); expect(calls).toEqual([]);
  });

  it("supports immediate zero-duration poses and cancels switches before state changes", () => {
    const runtime = new GltfRenderAnimationRuntime(sources(), targetFixture([]), instanceOptions());
    runtime.update(0.25);
    const controller = new AbortController(); controller.abort(new Error("cancel switch"));
    expect(() => runtime.crossFade({ transformClipId: "motion-2", morphClipId: "shape-2" }, 0.5, controller.signal))
      .toThrow("cancel switch");
    expect(runtime.time).toBe(0.25);

    const pose = runtime.crossFade({ transformClipId: "pose", morphClipId: null, playbackMode: "once" }, 0);
    expect(pose.frame.time).toBe(0); expect(pose.frame.finished).toBe(true);
    expect(pose.frame.instanceUpdate!.instances[0]!.transform[12]).toBe(7);
    expect(runtime.update(1).frame.revision).toBe(pose.frame.revision);
  });

  it("interrupts an active cross-fade from its exact blended pose with latest-selection wins", () => {
    const runtime = new GltfRenderAnimationRuntime(sources(), targetFixture([]), instanceOptions());
    runtime.update(0.25);
    runtime.crossFade({ transformClipId: "motion-2", morphClipId: "shape-2" }, 1);
    const blended = runtime.update(0.4);
    const beforeTransform = blended.frame.instanceUpdate!.instances[0]!.transform[12]!;
    const beforeMorph = blended.frame.morphWeights[0]!.weights.values[0]!;

    const interrupted = runtime.crossFade({ transformClipId: "pose", morphClipId: null,
      playbackMode: "once" }, 0.5);
    expect(interrupted.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo(beforeTransform);
    expect(interrupted.frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(beforeMorph);

    const middle = runtime.update(0.25);
    expect(middle.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo((beforeTransform + 7) / 2);
    expect(middle.frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(beforeMorph / 2);
    const completed = runtime.update(0.25);
    expect(completed.frame.instanceUpdate!.instances[0]!.transform[12]).toBeCloseTo(7);
    expect(completed.frame.morphWeights[0]!.weights.values[0]).toBeCloseTo(0);
    expect(runtime.isFinished).toBe(true);

    for (let index = 0; index < 24; index += 1) {
      const selection = index % 2 === 0
        ? { transformClipId: "motion-2", morphClipId: "shape-2" }
        : { transformClipId: "motion", morphClipId: "shape" };
      expect(() => runtime.crossFade(selection, 0.5)).not.toThrow();
      runtime.update(0.01);
    }
  });

  it("does not advance on pre-cancel and resumes a mid-submit cancellation exactly once", () => {
    const controller = new AbortController(), calls: string[] = [], base = targetFixture(calls);
    const runtime = new GltfRenderAnimationRuntime(sources(), base, instanceOptions());
    controller.abort(new Error("cancelled"));
    expect(() => runtime.update(0.5, controller.signal)).toThrow("cancelled");
    expect(runtime.time).toBe(0); expect(runtime.hasPendingFrame).toBe(false);

    const during = new AbortController();
    const fused = base.morphSkinning!.get("fused")!;
    base.morphSkinning!.set("fused", { updateDynamics(value) {
      const changed = fused.updateDynamics(value); during.abort(new Error("stop after fused")); return changed;
    } });
    expect(() => runtime.update(0.5, during.signal)).toThrow("stop after fused");
    expect(runtime.time).toBe(0.5); expect(runtime.hasPendingFrame).toBe(true);
    const fusedCalls = calls.filter((call) => call.startsWith("fused:")).length;
    runtime.retry();
    expect(calls.filter((call) => call.startsWith("fused:")).length).toBe(fusedCalls);
    expect(runtime.hasPendingFrame).toBe(false);
  });

  it("rejects invalid target registries without sampling", () => {
    expect(() => new GltfRenderAnimationRuntime(sources(), {
      skins: new Map([["fused", {} as never]]),
    })).toThrowError(expect.objectContaining<GltfRenderAnimationRuntimeError>({ code: "invalid-targets" }));
  });
});

function targetFixture(calls: string[]) {
  return {
    instances: { updateInstances: (value: { instances: readonly { transform: ArrayLike<number> }[] }) => {
      calls.push(`instances:${value.instances[0]!.transform[12]}`); return true;
    } },
    skins: new Map([["skin", { updatePalette: (value: { revision: number }) => {
      calls.push(`skin:${value.revision}`); return true;
    } }]]),
    morphs: new Map([["morph", { updateWeights: (value: { revision: number }) => {
      calls.push(`morph:${value.revision}`); return true;
    } }]]),
    morphSkinning: new Map([["fused", { updateDynamics: (value: {
      morphWeights: { revision: number }; palette: { revision: number };
    }) => { calls.push(`fused:${value.morphWeights.revision}/${value.palette.revision}`); return true; } }]]),
  };
}

function instanceOptions() {
  return { instances: {
    materials: [{ id: "material", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    bindings: [{ nodeId: "mesh", id: "instance", geometry: "geometry", material: "material" }],
  } };
}

function sources() {
  const nodes: readonly GltfAnimatedNode<string>[] = Object.freeze([
    Object.freeze({ sourceNodeIndex: 0, id: "joint", parent: null, localTransform: trs() }),
    Object.freeze({ sourceNodeIndex: 1, id: "mesh", parent: null, localTransform: trs([1, 0, 0]) }),
  ]);
  const animation = { sceneIndex: 0, nodes, clips: [transformClip(), secondTransformClip(), poseClip()] };
  const primitive = (id: string) => ({ id, sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
    joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) });
  const skinning: DecodedSkinnedGlb<string> = { abiVersion: 1, sceneIndex: 0, nodes,
    skins: [{ id: "skin-id", sourceSkinIndex: 0, sourceJointIndices: new Uint32Array([0]), joints: ["joint"],
      sourceSkeletonIndex: 0, skeleton: "joint", inverseBindMatrices: new Float32Array(identity()) }],
    primitives: [primitive("fused"), primitive("skin")], bindings: [{ sourceNodeIndex: 1, nodeId: "mesh",
      sourceSkinIndex: 0, skinId: "skin-id", sourceMeshIndex: 0, primitiveIds: ["fused", "skin"] }], decodedBytes: 0 };
  const morphPrimitive = (id: string) => ({ id, sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
    targets: [{ index: 0, name: "Smile", positionDeltas: new Float32Array([1, 0, 0]) }] });
  const morph: DecodedMorphGlb<string> = { abiVersion: 1, sceneIndex: 0, nodes,
    primitives: [morphPrimitive("fused"), morphPrimitive("morph")], bindings: [{ sourceNodeIndex: 1,
      nodeId: "mesh", sourceMeshIndex: 0, primitiveIds: ["fused", "morph"], initialWeights: new Float32Array([0]) }],
    morphClips: [morphClip(), secondMorphClip()], decodedBytes: 0 };
  return { animation, skinning, morph };
}

function transformClip(): AnimationClipInput<string> {
  return { id: "motion", duration: 1, tracks: [
    { nodeId: "joint", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [0, 0, 0, 4, 0, 0] },
    { nodeId: "mesh", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [1, 0, 0, 3, 0, 0] },
  ] };
}
function secondTransformClip(): AnimationClipInput<string> {
  return { id: "motion-2", duration: 1, tracks: [
    { nodeId: "joint", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [4, 0, 0, 8, 0, 0] },
    { nodeId: "mesh", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [9, 0, 0, 11, 0, 0] },
  ] };
}
function poseClip(): AnimationClipInput<string> {
  return { id: "pose", duration: 0, tracks: [
    { nodeId: "mesh", path: "translation", interpolation: "STEP", times: [0], values: [7, 0, 0] },
  ] };
}
function morphClip(): MorphWeightClip<string> {
  return { id: "shape", duration: 1, tracks: [{ nodeId: "mesh", targetCount: 1, interpolation: "LINEAR",
    times: new Float32Array([0, 1]), values: new Float32Array([0, 1]) }] };
}
function secondMorphClip(): MorphWeightClip<string> {
  return { id: "shape-2", duration: 1, tracks: [{ nodeId: "mesh", targetCount: 1, interpolation: "LINEAR",
    times: new Float32Array([0, 1]), values: new Float32Array([1, 0]) }] };
}
function trs(translation: readonly [number, number, number] = [0, 0, 0]) {
  return { kind: "trs" as const, translation, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
function identity(): number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
