import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import type { DeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneDynamicRuntimePackage, startSceneViewerDynamicPlayback } from "./sceneViewerDynamicPlayback";

function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "source", projectId: "project", name: "fixture", primitives: [], models: [], measurements: [],
    camera: { mode: "orbit", position: { x: 0, y: 1, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
}
function animated(): SceneSnapshot {
  return { ...scene(), primitives: [{ modelId: "pump", name: "pump", kind: "box", color: "#808080", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
    animation: { duration: 1, loop: true, camera: [], models: [
      { id: "frame-0", time: 0, modelId: "pump", transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
      { id: "frame-1", time: 1, modelId: "pump", transform: { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } },
    ] } } as SceneSnapshot;
}
function controlled(): SceneSnapshot {
  const input = animated();
  input.animation = { ...input.animation!, models: [], stateMachine: {
    enabled: true, initialStateId: "idle", activeStateId: "idle", transitionDuration: 0.25,
    states: [
      { id: "idle", name: "Idle", modelId: "pump", clipId: "Idle", loop: true },
      { id: "work", name: "Work", modelId: "pump", clipId: "Work", loop: false },
    ],
    parameters: { advance: true },
    transitions: [{ id: "idle-work", fromStateId: "idle", toStateId: "work", parameter: "advance", equals: true }],
  } };
  return input;
}

describe("scene viewer dynamic playback wiring", () => {
  it("builds a v7 carrier package from the real TRS lowering", () => {
    const runtimePackage = compileSceneDynamicRuntimePackage(animated(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" });
    expect(runtimePackage.schemaVersion).toBe(7);
    expect(runtimePackage.entrypoints.dynamicRuntime).toBe("scene.dynamic");
    const dynamic = runtimePackage.payloads["scene.dynamic"] as { animation: { durationMs: number; tracks: unknown[] } };
    expect(dynamic.animation.durationMs).toBe(1000);
    expect(dynamic.animation.tracks).toHaveLength(3);
    expect(runtimePackage.resources.find(resource => resource.kind === "dynamic-runtime")).toBeTruthy();
  });
  it("rejects snapshots without a playable dynamic channel", () => {
    expect(() => compileSceneDynamicRuntimePackage(scene(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" })).toThrow(/动态运行通道/);
  });
  it("starts engine playback on the presentation scheduler for animated snapshots", () => {
    const calls: Array<{ runtimePackage: DeepRuntimePackage; options: Record<string, unknown> | undefined }> = [];
    let stopped = false;
    const host = { startDynamicRuntimePlayback: (runtimePackage: DeepRuntimePackage, options?: Record<string, unknown>) => {
      calls.push({ runtimePackage, options });
      return () => { stopped = true; };
    } };
    const presented: number[] = [];
    const stop = startSceneViewerDynamicPlayback(host, animated(), {
      packageId: "viewer.dynamic", packageVersion: "1.0.0",
      onFramePresented: frame => presented.push(frame.timeMs),
    });
    expect(stop).toBeTypeOf("function");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.runtimePackage.entrypoints.dynamicRuntime).toBe("scene.dynamic");
    expect(calls[0]!.options).toMatchObject({ loop: true });
    expect((calls[0]!.options as { onFramePresented?: unknown }).onFramePresented).toBeTypeOf("function");
    stop?.();
    expect(stopped).toBe(true);
  });
  it("mounts the formal controller in the product viewer and stops its active model", () => {
    const calls: unknown[] = [];
    let playback: { autoplay: boolean; loopMode: "once" | "loop" } = { autoplay: true, loopMode: "loop" };
    const host = {
      startDynamicRuntimePlayback: () => { throw new Error("timeline must stay idle"); },
      getModelAnimationPlaybackState: () => playback,
      setModelAnimationPlaybackState: (_id: string, state: typeof playback) => { playback = state; },
      controlAnimation: (id: string, control: unknown) => (calls.push(["control", id, control]), true),
      transitionAnimationClip: (...args: unknown[]) => (calls.push(["transition", ...args]), true),
    };
    const stop = startSceneViewerDynamicPlayback(host, controlled(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" });
    expect(calls).toEqual([
      ["control", "pump", { action: "play", clipId: "Idle" }],
      ["transition", "pump", "Idle", "Work", 0.25],
    ]);
    expect(playback.loopMode).toBe("once");
    stop?.(); stop?.();
    expect(calls.at(-1)).toEqual(["control", "pump", { action: "stop" }]);
  });
  it("stays silent for static snapshots instead of faking playback", () => {
    const host = { startDynamicRuntimePlayback: () => { throw new Error("must not start"); } };
    expect(startSceneViewerDynamicPlayback(host, scene(), { packageId: "viewer.dynamic", packageVersion: "1.0.0" })).toBeUndefined();
  });

  it("carries the physics channel into the published package when bindings are provided", () => {
    // B3-a: the published physics channel used to be dropped on the Web viewer path
    // (compileDynamicRuntime was called without physics options), so published scenes
    // ran no physics in Web while Native consumed the channel.
    const input = scene();
    input.physics = { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 }, joints: [] };
    input.primitives = [{ modelId: "crate", name: "crate", kind: "box", color: "#808080", visible: true, opacity: 1,
      physics: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0.1 },
      transform: { position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    const physics = { objectBindings: [{ nodeId: "crate", instanceIds: ["crate:0"] }],
      coordinateOrigin: { x: 0, y: 0, z: 0 } };
    const withPhysics = compileSceneDynamicRuntimePackage(input, { packageId: "viewer.dynamic",
      packageVersion: "1.0.0", physics });
    expect((withPhysics.payloads["scene.dynamic"] as { physics?: { enabled: boolean; bodies: unknown[] } }).physics)
      .toMatchObject({ enabled: true, bodies: [expect.objectContaining({ id: "crate" })] });
    // Without bindings the physics channel cannot be compiled: fail closed rather than
    // silently publishing a scene whose authored physics is dropped.
    expect(() => compileSceneDynamicRuntimePackage(input, { packageId: "viewer.dynamic",
      packageVersion: "1.0.0" })).toThrow(/动态运行通道/);
  });

  it("starts playback for a physics-only snapshot so published physics is not silently skipped", () => {
    const input = scene();
    input.physics = { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 }, joints: [] };
    input.primitives = [{ modelId: "crate", name: "crate", kind: "box", color: "#808080", visible: true, opacity: 1,
      physics: { type: "dynamic", mass: 1, friction: 0.5, restitution: 0.1 },
      transform: { position: { x: 0, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
    let started = 0;
    const host = { startDynamicRuntimePlayback: () => { started++; return () => {}; } };
    const stop = startSceneViewerDynamicPlayback(host, input, { packageId: "viewer.dynamic",
      packageVersion: "1.0.0", physics: { objectBindings: [{ nodeId: "crate", instanceIds: ["crate:0"] }],
        coordinateOrigin: { x: 0, y: 0, z: 0 } } });
    expect(started).toBe(1);
    expect(typeof stop).toBe("function");
  });
});
