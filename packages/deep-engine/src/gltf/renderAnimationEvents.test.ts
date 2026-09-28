import { describe, expect, it } from "vitest";
import type { AnimationClipInput } from "../animation/types.js";
import type { GltfAnimatedNode } from "./animationTypes.js";
import type { GltfAnimationClipEventMarker } from "./renderAnimationEvents.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationRuntime } from "./renderAnimationRuntime.js";

describe("GltfRenderAnimationRuntime events", () => {
  it("emits markers in unwrapped order and never replays on later updates", () => {
    const runtime = runtimeWithEvents([marker("half", 0.25), marker("late", 0.6)]);
    expect(runtime.update(0.3).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
    expect(runtime.update(0.3).events.events.map(summary)).toEqual(["walk/late@0.6#0"]);
    expect(runtime.update(0.3).events.events.map(summary)).toEqual([]);
    expect(runtime.update(0.29).events).toMatchObject({ events: [], truncated: false });
  });

  it("emits one event per crossed loop for a large multi-loop delta", () => {
    const runtime = runtimeWithEvents([marker("half", 0.5)]);
    const batch = runtime.update(3.5).events;
    expect(batch.events.map(summary)).toEqual([
      "walk/half@0.5#0", "walk/half@1.5#1", "walk/half@2.5#2", "walk/half@3.5#3",
    ]);
    expect(runtime.unwrappedTime).toBeCloseTo(3.5);
    expect(runtime.update(0.25).events.events.map(summary)).toEqual([]);
  });

  it("emits markers that land exactly on a loop wrap boundary once", () => {
    const runtime = runtimeWithEvents([marker("tick", 0.95)]);
    expect(runtime.update(0.9).events.events).toEqual([]);
    const wrapped = runtime.update(0.2).events.events.map(summary);
    expect(wrapped).toEqual(["walk/tick@0.95#0"]);
    expect(runtime.frame.time).toBeCloseTo(0.1);
    expect(runtime.update(1.9).events.events.map(summary)).toEqual(["walk/tick@1.95#1", "walk/tick@2.95#2"]);
  });

  it("skips events on forward seek and re-arms them after backward seek", () => {
    const runtime = runtimeWithEvents([marker("half", 0.25), marker("late", 0.6)]);
    expect(runtime.update(0.4).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
    expect(runtime.seek(0.9).events.events).toEqual([]);
    expect(runtime.update(0.05).events.events).toEqual([]);
    runtime.seek(0.1);
    expect(runtime.update(0.2).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
  });

  it("treats zero deltas as empty advances without moving the watermark", () => {
    const runtime = runtimeWithEvents([marker("half", 0.25)]);
    for (let index = 0; index < 3; index += 1) expect(runtime.update(0).events.events).toEqual([]);
    expect(runtime.update(0.3).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
  });

  it("rejects negative deltas before any state or watermark change", () => {
    const runtime = runtimeWithEvents([marker("half", 0.25)]);
    expect(() => runtime.update(-1)).toThrowError(expect.objectContaining<GltfRenderAnimationBridgeError>({
      code: "invalid-time",
    }));
    expect(runtime.time).toBe(0); expect(runtime.unwrappedTime).toBe(0);
    expect(runtime.update(0.3).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
  });

  it("emits nothing while time scale is negative and re-arms on forward replay", () => {
    const runtime = runtimeWithEvents([marker("half", 0.25)], { selection: { timeScale: -1 } });
    expect(runtime.update(0.5).events.events).toEqual([]);
    runtime.setTimeScale(1);
    expect(runtime.update(1).events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
  });

  it("clamps once playback at the terminal and stops emitting", () => {
    const runtime = runtimeWithEvents([marker("tick", 0.95)], { selection: { playbackMode: "once" } });
    expect(runtime.update(0.5).events.events).toEqual([]);
    expect(runtime.update(0.5).events.events.map(summary)).toEqual(["walk/tick@0.95#0"]);
    expect(runtime.update(0.5).events.events).toEqual([]);
    expect(runtime.isFinished).toBe(true);
  });

  it("defers events across a pending failed frame and emits them exactly once", () => {
    let failInstance = false;
    const runtime = new GltfRenderAnimationRuntime(
      { animation: { sceneIndex: 0, nodes: nodes(), clips: [clip("walk")] } },
      { instances: { updateInstances() {
        if (failInstance) { failInstance = false; throw new Error("instance upload failed"); }
        return true;
      } } },
      { events: { markers: [marker("half", 0.25), marker("late", 0.6)] }, instances: instanceProjection() },
    );
    runtime.update(0);
    failInstance = true;
    expect(() => runtime.update(0.3)).toThrow("instance upload failed");
    expect(runtime.hasPendingFrame).toBe(true);

    const recovered = runtime.update(0);
    expect(recovered.advanced).toBe(false);
    expect(recovered.events.events.map(summary)).toEqual(["walk/half@0.25#0"]);
    expect(runtime.update(0.4).events.events.map(summary)).toEqual(["walk/late@0.6#0"]);
    expect(runtime.update(0.05).events.events.map(summary)).toEqual([]);
  });

  it("resets the event timeline when a cross-fade rewinds the playhead", () => {
    const markers = [marker("walkHalf", 0.25), { clipId: "run", eventId: "runHalf", time: 0.5 }];
    const runtime = runtimeWithEvents(markers);
    expect(runtime.update(0.4).events.events.map(summary)).toEqual(["walk/walkHalf@0.25#0"]);
    const faded = runtime.crossFade({ transformClipId: "run" }, 0.5);
    expect(faded.events.events).toEqual([]);
    expect(runtime.update(0.6).events.events.map(summary)).toEqual(["run/runHalf@0.5#0"]);
  });

  it("emits nothing for paused updates and resumes detection once", () => {
    const runtime = runtimeWithEvents([marker("half", 0.5)]);
    runtime.pause();
    expect(runtime.update(0.5).events.events).toEqual([]);
    runtime.resume();
    expect(runtime.update(0.5).events.events.map(summary)).toEqual(["walk/half@0.5#0"]);
    expect(runtime.update(0.5).events.events).toEqual([]);
  });

  it("truncates bursts past the per-update cap deterministically", () => {
    const runtime = runtimeWithEvents([marker("a", 0.25), marker("b", 0.5)]);
    const batch = runtime.update(900).events;
    expect(batch.truncated).toBe(true);
    expect(batch.events).toHaveLength(1024);
    expect(batch.events[0]).toMatchObject({ eventId: "a", unwrappedTime: 0.25, loop: 0 });
    expect(batch.events[1023]).toMatchObject({ eventId: "a", unwrappedTime: 899.25, loop: 899 });
    expect(batch.events.filter((event) => event.eventId === "b")).toHaveLength(124);
  });

  it("produces identical event sequences for identical update sequences", () => {
    const drive = (runtime: GltfRenderAnimationRuntime) => [0.3, 0.4, 1.2, 0, 0.3].map(
      (delta) => runtime.update(delta).events.events.map(summary));
    expect(drive(runtimeWithEvents([marker("half", 0.25), marker("late", 0.6)])))
      .toEqual(drive(runtimeWithEvents([marker("half", 0.25), marker("late", 0.6)])));
  });

  it("rejects invalid marker registrations before sampling", () => {
    expect(() => runtimeWithEvents([{ clipId: "walk", eventId: "late", time: 1 }])).toThrowError(
      expect.objectContaining<GltfRenderAnimationBridgeError>({ code: "invalid-input" }));
    expect(() => runtimeWithEvents([{ clipId: "missing", eventId: "x", time: 0.5 }])).toThrowError(
      expect.objectContaining<GltfRenderAnimationBridgeError>({ code: "invalid-input" }));
    expect(() => runtimeWithEvents([marker("dupe", 0.5), marker("dupe", 0.25)])).toThrowError(
      expect.objectContaining<GltfRenderAnimationBridgeError>({ code: "invalid-input" }));
  });
});

function summary(event: { clipId: string; eventId: string; unwrappedTime: number; loop: number }): string {
  return `${event.clipId}/${event.eventId}@${event.unwrappedTime}#${event.loop}`;
}
function marker(eventId: string, time: number): GltfAnimationClipEventMarker {
  return { clipId: "walk", eventId, time };
}
function instanceProjection() {
  return {
    materials: [{ id: "material", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 }],
    bindings: [{ nodeId: "mesh", id: "instance", geometry: "geometry", material: "material" }],
  };
}

function runtimeWithEvents(markers: readonly GltfAnimationClipEventMarker[],
  options: { selection?: { timeScale?: number; playbackMode?: "loop" | "once" } } = {}) {
  return new GltfRenderAnimationRuntime({ animation: { sceneIndex: 0, nodes: nodes(), clips: [clip("walk"), clip("run")] } },
    {}, { events: { markers }, ...options });
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
function clip(id: string): AnimationClipInput<string> {
  return { id, duration: 1, tracks: [
    { nodeId: "root", path: "translation", interpolation: "LINEAR", times: [0, 1], values: [0, 0, 0, 2, 0, 0] },
  ] };
}
