import { describe, expect, it } from "vitest";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import { SceneAnimationMixer } from "./SceneAnimationMixer.js";
import { AnimationStateMachine } from "./stateMachine.js";
import { applyAnimationConstraint, sampleAnimationPath } from "./pathConstraints.js";
import { AnimationError, type AnimationClipInput } from "./types.js";

const clip = (id: string, from: number, to: number): AnimationClipInput<string> => ({ id, duration: 1, tracks: [
  { nodeId: "node", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [from, 0, 0, to, 0, 0] },
] });

describe("AnimationStateMachine", () => {
  it("starts the initial state and conditionally cross-fades in declaration order", () => {
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(clip("idle", 0, 0)); mixer.registerClip(clip("run", 0, 10)); mixer.registerClip(clip("stop", 10, 0));
    const machine = new AnimationStateMachine(mixer, {
      states: [
        { id: "idle", layerId: "idle-layer", clipId: "idle", loop: true },
        { id: "run", layerId: "run-layer", clipId: "run", loop: true },
        { id: "stop", layerId: "stop-layer", clipId: "stop", loop: false },
      ],
      transitions: [
        { from: "idle", to: "run", duration: 0.2, condition: { parameter: "speed", greaterThan: 0 } },
        { from: "run", to: "stop", duration: 0, condition: { parameter: "stop", equals: true } },
      ],
      initialState: "idle", parameters: { speed: 0, stop: false },
    });
    expect(machine.snapshot.currentState).toBe("idle");
    machine.setParameter("speed", 2);
    expect(machine.update(1 / 60)).toBe(true);
    expect(machine.snapshot.currentState).toBe("run");
    machine.setParameter("stop", true);
    expect(machine.drainTransitions()).toBe(1);
    expect(machine.snapshot.currentState).toBe("stop");
  });

  it("supports explicit target transitions and does not transition when the condition is false", () => {
    const mixer = new SceneAnimationMixer<string>();
    mixer.registerClip(clip("a", 0, 1)); mixer.registerClip(clip("b", 1, 2));
    const machine = new AnimationStateMachine(mixer, {
      states: [{ id: "a", layerId: "a-layer", clipId: "a" }, { id: "b", layerId: "b-layer", clipId: "b" }],
      transitions: [{ from: "a", to: "b", duration: 1, condition: { parameter: "armed", equals: true } }], initialState: "a",
    });
    expect(machine.transitionTo("b")).toBe(false);
    expect(machine.snapshot.currentState).toBe("a");
    machine.setParameter("armed", true);
    expect(machine.transitionTo("b", 0)).toBe(true);
    expect(machine.snapshot.currentState).toBe("b");
  });

  it("rejects unknown states, empty condition groups, and budgets", () => {
    const mixer = new SceneAnimationMixer<string>(); mixer.registerClip(clip("a", 0, 1));
    expect(() => new AnimationStateMachine(mixer, { states: [{ id: "a", layerId: "a-layer", clipId: "a" }], transitions: [{ from: "a", to: "ghost", duration: 0 }], initialState: "a" })).toThrow(AnimationError);
    expect(() => new AnimationStateMachine(mixer, { states: [{ id: "a", layerId: "a-layer", clipId: "a" }], transitions: [], initialState: "a" }, { transitionBudget: 257 })).toThrow(AnimationError);
  });

  it("uses a bounded transition drain to prevent transition storms", () => {
    const mixer = new SceneAnimationMixer<string>();
    for (const id of ["a", "b", "c"]) mixer.registerClip(clip(id, 0, 1));
    const machine = new AnimationStateMachine(mixer, {
      states: ["a", "b", "c"].map((id) => ({ id, layerId: `${id}-layer`, clipId: id })),
      transitions: [{ from: "a", to: "b", duration: 0 }, { from: "b", to: "c", duration: 0 }], initialState: "a",
    });
    expect(machine.drainTransitions(1)).toBe(1);
    expect(machine.snapshot.currentState).toBe("b");
    expect(machine.drainTransitions(1)).toBe(1);
    expect(machine.snapshot.currentState).toBe("c");
  });
});

describe("animation paths and constraints", () => {
  it("samples linear and polyline paths with clamp and loop semantics", () => {
    expect(sampleAnimationPath({ kind: "linear", nodeId: "node", from: [0, 0, 0], to: [10, 0, 0], durationSeconds: 2 }, 1).position).toEqual([5, 0, 0]);
    expect(sampleAnimationPath({ kind: "linear", nodeId: "node", from: [0, 0, 0], to: [10, 0, 0], durationSeconds: 2 }, 4).position).toEqual([10, 0, 0]);
    expect(sampleAnimationPath({ kind: "polyline", nodeId: "node", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], durationSeconds: 2 }, 1).position).toEqual([10, 0, 0]);
    expect(sampleAnimationPath({ kind: "polyline", nodeId: "node", points: [[0, 0, 0], [10, 0, 0]], durationSeconds: 2, loop: true }, 2.5).position).toEqual([2.5, 0, 0]);
  });

  it("clamps distance constraints and keeps look-at pure", () => {
    const clamped = applyAnimationConstraint({ nodeId: "node", kind: "distance", target: [0, 0, 0], minDistance: 2, maxDistance: 4 }, [1, 0, 0]);
    expect(clamped.position).toEqual([2, 0, 0]); expect(clamped.constrained).toBe(true);
    const lookAt = applyAnimationConstraint({ nodeId: "node", kind: "look-at", target: [0, 1, 0] }, [1, 2, 3]);
    expect(lookAt.position).toEqual([1, 2, 3]); expect(lookAt.constrained).toBe(false);
  });

  it("fails closed on invalid paths, constraints, and time", () => {
    expect(() => sampleAnimationPath({ kind: "linear", nodeId: "node", from: [0, 0, 0], to: [1, 1, 1], durationSeconds: 1 }, Number.NaN)).toThrow(AnimationError);
    expect(() => sampleAnimationPath({ kind: "polyline", nodeId: "node", points: [[0, 0, 0]], durationSeconds: 1 }, 0)).toThrow(AnimationError);
    expect(() => applyAnimationConstraint({ nodeId: "node", kind: "distance", target: [0, 0, 0], minDistance: 5, maxDistance: 1 }, [1, 0, 0])).toThrow(AnimationError);
  });

  it("keeps the state machine on the existing graph transaction path", () => {
    const graph = new SceneTransformGraph<string>(); graph.create({ id: "node" });
    const mixer = new SceneAnimationMixer<string>(); mixer.registerClip(clip("move", 0, 10));
    const machine = new AnimationStateMachine(mixer, { states: [{ id: "move", layerId: "move-layer", clipId: "move", loop: false }], transitions: [], initialState: "move" });
    machine.update(0);
    const frame = mixer.sampleAndApply(graph, 0.5);
    expect(frame.updatedNodeIds).toEqual(["node"]);
    expect(graph.getNode("node")?.localTransform).toMatchObject({ kind: "trs", translation: [5, 0, 0] });
  });
});
