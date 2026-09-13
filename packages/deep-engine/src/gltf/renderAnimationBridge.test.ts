import { describe, expect, it } from "vitest";
import type { AnimationClipInput } from "../animation/types.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { InstanceUpdate } from "../renderPacketTypes.js";
import type { MorphSkinningDynamics } from "../webgpu/gpuMorphSkinningTypes.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import { GltfRenderAnimationBridge } from "./renderAnimationBridge.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import type { DecodedMorphGlb } from "./morphTypes.js";
import type { DecodedSkinnedGlb } from "./skinTypes.js";

describe("GltfRenderAnimationBridge", () => {
  it("samples transform, skin, and morph outputs into reusable render-ready banks", () => {
    const sources = fixture();
    const bridge = new GltfRenderAnimationBridge({ animation: sources.animation, skinning: sources.skinning, morph: sources.morph }, {
      instances: { materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
        bindings: [{ nodeId: "mesh", id: "instance", geometry: "geometry", material: "material" }] },
    });
    const initial = bridge.frame, frame = bridge.update(0.5);
    expect(frame).not.toBe(initial);
    expect(frame).toMatchObject({ revision: 1, time: 0.5, paused: false });
    expect([...node(frame, "root").worldTransform]).toEqual([
      1.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1.5, 0, 5, 0, 0, 1,
    ]);
    expect([...node(frame, "mesh").worldTransform].slice(12, 15)).toEqual([6.5, 0, 0]);
    expect([...frame.morphWeights[0]!.weights.values]).toEqual([0.5, 0.25]);
    expect([...frame.skinPalettes[0]!.palette.matrices].slice(12, 15)).toEqual([-1, 1, 0]);
    expect(frame.morphSkinning[0]).toMatchObject({ primitiveId: "asset/mesh/0/primitive/0" });
    expect(acceptInstanceUpdate(frame.instanceUpdate!)).toBe(frame.instanceUpdate);
    expect(acceptDynamics(frame.morphSkinning[0]!.dynamics)).toBe(frame.morphSkinning[0]!.dynamics);
    expect(frame.instanceUpdate!.instances[0]!.transform).toBe(node(frame, "mesh").worldTransform);

    expect(bridge.update(0)).toBe(frame);
    bridge.pause(); expect(bridge.update(0.25)).toBe(frame); expect(bridge.frame.paused).toBe(true);
    bridge.resume();
    const looped = bridge.update(0.5);
    expect(looped).toBe(initial); expect(looped.revision).toBe(2); expect(looped.time).toBe(0);
    expect(looped.skinPalettes[0]!.palette.revision).toBe(0);
    expect(looped.morphWeights[0]!.weights.revision).toBe(2);
  });

  it("supports clamp, seek, negative time scale, and clips with missing channels", () => {
    const sources = fixture(), bridge = new GltfRenderAnimationBridge({ animation: sources.animation, morph: sources.morph }, {
      selection: { wrapMode: "clamp", transformClipId: "motion", morphClipId: null, time: 1 },
    });
    expect(node(bridge.frame, "root").worldTransform[12]).toBe(10);
    const rotated = node(bridge.frame, "joint").worldTransform;
    expect(rotated[0]).toBeCloseTo(-2); expect(rotated[5]).toBeCloseTo(-2);
    bridge.setTimeScale(-1); bridge.update(0.5);
    expect(node(bridge.frame, "root").worldTransform[12]).toBe(5);
    const before = node(bridge.frame, "mesh").worldTransform;
    bridge.play({ transformClipId: null, morphClipId: "shape", wrapMode: "clamp", time: 0.5 });
    expect(node(bridge.frame, "mesh").worldTransform[12]).toBe(1);
    expect(node(bridge.frame, "mesh").worldTransform).not.toBe(before);
    expect([...bridge.frame.morphWeights[0]!.weights.values]).toEqual([0.5, 0.25]);
    expect(bridge.seek(2).time).toBe(1);
  });

  it("fails closed for mismatched identities, timelines, bindings, and singular palettes", () => {
    const sources = fixture();
    const mismatched = { ...sources.morph, nodes: sources.morph.nodes.map((node, index) => index === 0 ? { ...node, id: "other" } : node) };
    expectCode(() => new GltfRenderAnimationBridge({ animation: sources.animation, morph: mismatched }), "node-mismatch");
    const longMorph = { ...sources.morph, morphClips: [{ ...sources.morph.morphClips[0]!, duration: 2 }] };
    expectCode(() => new GltfRenderAnimationBridge({ animation: sources.animation, morph: longMorph }), "invalid-input");
    expectCode(() => new GltfRenderAnimationBridge({ animation: sources.animation }, {
      selection: { transformClipId: "missing" },
    }), "missing-clip");
    expectCode(() => new GltfRenderAnimationBridge({ animation: sources.animation }, {
      instances: { materials: [], bindings: [
        { nodeId: "root", id: "same", geometry: "g", material: "m" },
        { nodeId: "mesh", id: "same", geometry: "g", material: "m" },
      ] },
    }), "duplicate-binding");
    const singularNodes = sources.animation.nodes.map((node) => node.id === "mesh"
      ? { ...node, localTransform: trs([1, 0, 0], [0, 0, 0]) } : node);
    expectCode(() => new GltfRenderAnimationBridge({ skinning: { ...sources.skinning, nodes: singularNodes } }), "singular-transform");
    expectCode(() => new GltfRenderAnimationBridge({ animation: sources.animation }, { selection: { time: Number.NaN } }), "invalid-time");
  });
});

function fixture(): { animation: { sceneIndex: number; nodes: readonly GltfAnimatedNode<string>[]; clips: readonly AnimationClipInput<string>[] };
  skinning: DecodedSkinnedGlb<string>; morph: DecodedMorphGlb<string> } {
  const nodes: readonly GltfAnimatedNode<string>[] = Object.freeze([
    Object.freeze({ sourceNodeIndex: 0, id: "root", parent: null, localTransform: trs() }),
    Object.freeze({ sourceNodeIndex: 1, id: "joint", parent: "root", localTransform: trs([0, 1, 0]) }),
    Object.freeze({ sourceNodeIndex: 2, id: "mesh", parent: "root", localTransform: trs([1, 0, 0]) }),
  ]);
  const animation = { sceneIndex: 0, nodes, clips: [transformClip()] };
  const primitiveId = "asset/mesh/0/primitive/0";
  const skinning: DecodedSkinnedGlb<string> = { abiVersion: 1, sceneIndex: 0, nodes,
    skins: [{ id: "skin", sourceSkinIndex: 0, sourceJointIndices: new Uint32Array([1]), joints: ["joint"],
      sourceSkeletonIndex: 1, skeleton: "joint", inverseBindMatrices: new Float32Array(identity()) }],
    primitives: [{ id: primitiveId, sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
      joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) }],
    bindings: [{ sourceNodeIndex: 2, nodeId: "mesh", sourceSkinIndex: 0, skinId: "skin", sourceMeshIndex: 0,
      primitiveIds: [primitiveId] }], decodedBytes: 0 };
  const morph: DecodedMorphGlb<string> = { abiVersion: 1, sceneIndex: 0, nodes,
    primitives: [{ id: primitiveId, sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
      targets: [{ index: 0, name: "Smile", positionDeltas: new Float32Array([1, 0, 0]) },
        { index: 1, name: "Blink", positionDeltas: new Float32Array([0, 1, 0]) }] }],
    bindings: [{ sourceNodeIndex: 2, nodeId: "mesh", sourceMeshIndex: 0, primitiveIds: [primitiveId],
      initialWeights: new Float32Array([0.1, 0.2]) }], morphClips: [morphClip()], decodedBytes: 0 };
  return { animation, skinning, morph };
}

function transformClip(): AnimationClipInput<string> {
  return { id: "motion", duration: 1, tracks: [
    { nodeId: "root", path: "translation", interpolation: "LINEAR", times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 10, 0, 0]) },
    { nodeId: "joint", path: "rotation", interpolation: "STEP", times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]) },
    { nodeId: "root", path: "scale", interpolation: "CUBICSPLINE", times: new Float32Array([0, 1]),
      values: new Float32Array([0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 2, 2, 2, 0, 0, 0]) },
  ] };
}
function morphClip(): MorphWeightClip<string> {
  return { id: "shape", duration: 1, tracks: [{ nodeId: "mesh", targetCount: 2, interpolation: "CUBICSPLINE",
    times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 0.5, 0, 0]) }] };
}
function trs(translation: readonly [number, number, number] = [0, 0, 0], scale: readonly [number, number, number] = [1, 1, 1]) {
  return { kind: "trs" as const, translation, rotation: [0, 0, 0, 1] as const, scale };
}
function identity(): number[] { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function node(frame: ReturnType<GltfRenderAnimationBridge<string>["update"]>, id: string) {
  return frame.nodeWorldTransforms.find((entry) => entry.nodeId === id)!;
}
function acceptInstanceUpdate(value: InstanceUpdate): InstanceUpdate { return value; }
function acceptDynamics(value: MorphSkinningDynamics): MorphSkinningDynamics { return value; }
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected bridge construction to fail."); }
  catch (error) { expect(error).toBeInstanceOf(GltfRenderAnimationBridgeError); expect((error as GltfRenderAnimationBridgeError).code).toBe(code); }
}
