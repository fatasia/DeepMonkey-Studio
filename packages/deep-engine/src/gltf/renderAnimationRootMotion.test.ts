import { describe, expect, it } from "vitest";
import type { AnimationClipInput } from "../animation/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import type { GltfRenderAnimationRuntimeOptions } from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationRuntime, GltfRenderAnimationRuntimeError } from "./renderAnimationRuntime.js";
import type { QuatTuple } from "./renderAnimationRootMotion.js";

describe("GltfRenderAnimationRuntime root motion", () => {
  it("records per-advance translation deltas on the unwrapped timeline", () => {
    const runtime = walkRuntime();
    const first = runtime.update(0.5).rootMotion;
    expect(first).toMatchObject({ clipId: "walk", unwrappedTime: 0.5, loop: 0 });
    expect(first!.translation[0]).toBeCloseTo(1);
    const second = runtime.update(0.5).rootMotion;
    expect(second).toMatchObject({ unwrappedTime: 1, loop: 1 });
    expect(second!.translation[0]).toBeCloseTo(-1);
  });

  it("records the rendered wrap discontinuity once per loop revolution", () => {
    const runtime = walkRuntime();
    runtime.update(0.75);
    const wrapped = runtime.update(0.5).rootMotion!;
    expect(wrapped.unwrappedTime).toBeCloseTo(1.25);
    expect(wrapped.loop).toBe(1);
    expect(wrapped.translation[0]).toBeCloseTo(-1);
  });

  it("aggregates recorded motion strictly after a since time", () => {
    const runtime = walkRuntime({ selection: { playbackMode: "once" } });
    runtime.update(0.5); runtime.update(0.5);
    expect(runtime.accumulatedRootMotion()).toMatchObject({ translation: [2, 0, 0], samples: 2 });
    expect(runtime.accumulatedRootMotion(0.5)).toMatchObject({ translation: [1, 0, 0], samples: 1 });
    expect(runtime.accumulatedRootMotion(1)).toBeNull();
    expect(runtime.accumulatedRootMotion()!.rotation[3]).toBeCloseTo(1);
    expect(runtime.update(0.5).rootMotion).toBeNull();
  });

  it("records rotation deltas as previous⁻¹ ⊗ current in world space", () => {
    const runtime = spinRuntime();
    const first = runtime.update(0.5).rootMotion!;
    expect(rotationAngleY(first.rotation)).toBeCloseTo(Math.PI / 4, 5);
    const second = runtime.update(0.5).rootMotion!;
    expect(rotationAngleY(second.rotation)).toBeCloseTo(Math.PI / 4, 5);
    const total = runtime.accumulatedRootMotion()!;
    expect(rotationAngleY(total.rotation)).toBeCloseTo(Math.PI / 2, 5);
  });

  it("nets zero rotation across a loop revolution of rendered poses", () => {
    const runtime = spinRuntime({ selection: { playbackMode: "loop" } });
    runtime.update(0.5); runtime.update(0.5);
    const total = runtime.accumulatedRootMotion()!;
    expect(rotationAngleY(total.rotation)).toBeCloseTo(0, 5);
  });

  it("re-arms the baseline on seek so jumps are never recorded as motion", () => {
    const runtime = walkRuntime();
    runtime.update(0.25);
    runtime.seek(0.5);
    const sample = runtime.update(0.25).rootMotion!;
    expect(sample.translation[0]).toBeCloseTo(0.5);
    expect(runtime.accumulatedRootMotion()!.samples).toBe(2);
  });

  it("records nothing for zero or paused advances", () => {
    const runtime = walkRuntime();
    expect(runtime.update(0).rootMotion).toBeNull();
    runtime.pause();
    expect(runtime.update(0.5).rootMotion).toBeNull();
    runtime.resume();
    expect(runtime.update(0.5).rootMotion!.translation[0]).toBeCloseTo(1);
    expect(runtime.accumulatedRootMotion()!.samples).toBe(1);
  });

  it("keeps only the newest samples inside the history ring", () => {
    const runtime = walkRuntime({ rootMotion: { rootNodeId: "root", historyCapacity: 2 } });
    runtime.update(0.25); runtime.update(0.25); runtime.update(0.25);
    expect(runtime.accumulatedRootMotion()).toMatchObject({ translation: [1, 0, 0], samples: 2 });
  });

  it("emits events and root motion from the same settled advance", () => {
    const runtime = new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [walkClip()] } },
      {}, { rootMotion: { rootNodeId: "root" }, events: { markers: [{ clipId: "walk", eventId: "half", time: 0.25 }] } });
    const update = runtime.update(0.5);
    expect(update.events.events).toHaveLength(1);
    expect(update.rootMotion!.translation[0]).toBeCloseTo(1);
    expect(runtime.unwrappedTime).toBeCloseTo(0.5);
  });

  it("defers root motion of a failed frame and records it exactly once on recovery", () => {
    let failInstance = false;
    const runtime = new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [walkClip()] } },
      { instances: { updateInstances() {
        if (failInstance) { failInstance = false; throw new Error("instance upload failed"); }
        return true;
      } } },
      { rootMotion: { rootNodeId: "root" }, instances: instanceProjection() });
    runtime.update(0);
    failInstance = true;
    expect(() => runtime.update(0.3)).toThrow("instance upload failed");
    const recovered = runtime.update(0).rootMotion!;
    expect(recovered.translation[0]).toBeCloseTo(0.6);
    expect(recovered.unwrappedTime).toBeCloseTo(0.3);
    runtime.retry();
    expect(runtime.accumulatedRootMotion()!.samples).toBe(1);
  });

  it("stays inert without root motion options and rejects unknown tracked nodes", () => {
    const runtime = new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [walkClip()] } }, {});
    const update = runtime.update(0.5);
    expect(update.rootMotion).toBeNull();
    expect(update.events.events).toEqual([]);
    expect(runtime.accumulatedRootMotion()).toBeNull();
    expect(runtime.unwrappedTime).toBeCloseTo(0.5);
    expect(() => new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [walkClip()] } }, {},
      { rootMotion: { rootNodeId: "ghost" } })).toThrowError(expect.objectContaining<GltfRenderAnimationRuntimeError>({
      code: "invalid-targets",
    }));
  });
});

/** Rotating `(1,0,0)` by the quaternion and reading the yaw about +Y. */
function rotationAngleY(quaternion: QuatTuple): number {
  const [x, y, z, w] = quaternion;
  const forwardX = 1 - 2 * (y * y + z * z);
  const forwardZ = 2 * (x * z - w * y);
  return Math.atan2(-forwardZ, forwardX);
}
function instanceProjection() {
  return {
    materials: [{ id: "material", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    bindings: [{ nodeId: "mesh", id: "instance", geometry: "geometry", material: "material" }],
  };
}
function walkRuntime(options: Partial<GltfRenderAnimationRuntimeOptions<string>> = {}) {
  return new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [walkClip()] } }, {},
    { rootMotion: { rootNodeId: "root" }, ...options });
}
function spinRuntime(options: Partial<GltfRenderAnimationRuntimeOptions<string>> = {}) {
  const spin: AnimationClipInput<string> = { id: "spin", duration: 1, tracks: [
    { nodeId: "root", path: "rotation", interpolation: "LINEAR", times: [0, 1],
      values: [0, 0, 0, 1, 0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] },
  ] };
  return new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [spin] } }, {},
    { rootMotion: { rootNodeId: "root" }, selection: { playbackMode: "once" }, ...options });
}

function nodes(): readonly GltfAnimatedNode<string>[] {
  return [
    Object.freeze({ sourceNodeIndex: 0, id: "root", parent: null, localTransform: trs() }),
    Object.freeze({ sourceNodeIndex: 1, id: "mesh", parent: "root", localTransform: trs() }),
  ];
}
function trs() {
  return { kind: "trs" as const, translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
function walkClip(): AnimationClipInput<string> {
  return { id: "walk", duration: 1, tracks: [
    { nodeId: "root", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [0, 0, 0, 2, 0, 0] },
  ] };
}
