import type { AnimationClipInput, InstanceUpdate } from "@bim-studio/deep-engine";
import {
  GltfRenderAnimationRuntime,
  type DecodedMorphGlb, type GltfAnimatedNode, type GltfRenderAnimationTargets,
} from "@bim-studio/deep-engine/gltf";
import type { GpuMorphWeights } from "@bim-studio/deep-engine/webgpu";

export interface GltfAnimationTransitionProbeResult {
  readonly action: "gltf-animation-transition";
  readonly success: boolean;
  readonly interruptions: number;
  readonly maximumSwitchJump: number;
  readonly cancelledFrameRetriedOnce: boolean;
  readonly revisionsMonotonic: boolean;
  readonly finalAuthorSelectionWon: boolean;
}

/** Exercises the real glTF runtime's nested transition and partial-submit retry boundary. */
export function verifyGltfAnimationTransitions(): GltfAnimationTransitionProbeResult {
  let instanceX = Number.NaN, morphWeight = Number.NaN, cancelDuringMorph: AbortController | undefined;
  let instanceCalls = 0; const morphRevisions: number[] = [];
  const targets: GltfRenderAnimationTargets = {
    instances: { updateInstances(update: InstanceUpdate) {
      instanceX = update.instances[0]!.transform[12]!; instanceCalls++; return true;
    } },
    morphs: new Map([["morph-primitive", { updateWeights(weights: GpuMorphWeights) {
      morphWeight = weights.values[0]!; morphRevisions.push(weights.revision);
      cancelDuringMorph?.abort(new Error("lab transition submit cancelled"));
      cancelDuringMorph = undefined; return true;
    } }]]),
  };
  const runtime = new GltfRenderAnimationRuntime(sources(), targets, instanceProjection());
  runtime.update(0);
  let maximumSwitchJump = 0;
  for (let index = 0; index < 24; index++) {
    const beforeX = instanceX, beforeMorph = morphWeight;
    runtime.crossFade(selection(index % 2 === 0 ? "b" : "a"), 0.2);
    maximumSwitchJump = Math.max(maximumSwitchJump,
      Math.abs(instanceX - beforeX), Math.abs(morphWeight - beforeMorph));
    runtime.update(0.05);
  }

  const controller = new AbortController(); cancelDuringMorph = controller;
  let cancelled = false;
  try { runtime.update(0.05, controller.signal); }
  catch (error) { cancelled = error instanceof Error && error.message === "lab transition submit cancelled"; }
  const pendingTime = runtime.time, morphCallsBeforeRetry = morphRevisions.length,
    instanceCallsBeforeRetry = instanceCalls;
  const retried = runtime.retry();
  const cancelledFrameRetriedOnce = cancelled && retried.advanced === false && runtime.time === pendingTime
    && morphRevisions.length === morphCallsBeforeRetry && instanceCalls === instanceCallsBeforeRetry + 1
    && !runtime.hasPendingFrame;

  runtime.crossFade(selection("b", 0), 0.1); runtime.update(0.1);
  const finalAuthorSelectionWon = Math.abs(instanceX - 10) < 1e-6 && Math.abs(morphWeight - 1) < 1e-6;
  const revisionsMonotonic = morphRevisions.every((revision, index) =>
    index === 0 || revision > morphRevisions[index - 1]!);
  const success = maximumSwitchJump < 1e-6 && cancelledFrameRetriedOnce
    && revisionsMonotonic && finalAuthorSelectionWon;
  return Object.freeze({ action: "gltf-animation-transition", success, interruptions: 24,
    maximumSwitchJump, cancelledFrameRetriedOnce, revisionsMonotonic, finalAuthorSelectionWon });
}

function selection(id: "a" | "b", timeScale = 1) {
  return { transformClipId: `motion-${id}`, morphClipId: `shape-${id}`,
    playbackMode: "loop" as const, time: 0, timeScale };
}

function sources() {
  const nodes: readonly GltfAnimatedNode<number>[] = Object.freeze([
    Object.freeze({ sourceNodeIndex: 0, id: 0, parent: null, localTransform: trs(0) }),
  ]);
  const animation = { sceneIndex: 0, nodes, clips: [transformClip("motion-a", 0), transformClip("motion-b", 10)],
    decodedBytes: 0 };
  const morph: DecodedMorphGlb<number> = { abiVersion: 1, sceneIndex: 0, nodes,
    primitives: [{ id: "morph-primitive", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
      targets: [{ index: 0, name: "State", positionDeltas: new Float32Array([1, 0, 0]) }] }],
    bindings: [{ sourceNodeIndex: 0, nodeId: 0, sourceMeshIndex: 0,
      primitiveIds: ["morph-primitive"], initialWeights: new Float32Array([0]) }],
    morphClips: [morphClip("shape-a", 0), morphClip("shape-b", 1)], decodedBytes: 0 };
  return { animation, morph };
}
function instanceProjection() {
  return { instances: {
    materials: [{ id: "material", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    bindings: [{ nodeId: 0, id: "instance", geometry: "geometry", material: "material" }],
  } };
}
function transformClip(id: string, value: number): AnimationClipInput<number> {
  return { id, duration: 1, tracks: [{ nodeId: 0, path: "translation", interpolation: "LINEAR",
    times: [0, 1], values: [value, 0, 0, value, 0, 0] }] };
}
function morphClip(id: string, value: number) {
  return { id, duration: 1, tracks: [{ nodeId: 0, targetCount: 1, interpolation: "LINEAR" as const,
    times: new Float32Array([0, 1]), values: new Float32Array([value, value]) }] };
}
function trs(x: number) {
  return { kind: "trs" as const, translation: [x, 0, 0] as const,
    rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
