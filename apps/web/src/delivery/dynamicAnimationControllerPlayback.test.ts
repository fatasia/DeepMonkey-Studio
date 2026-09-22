import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SceneAnimationStateMachineState } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { buildDeepRuntimePackage, type DeepRuntimePackage, type DynamicSceneRuntime, type RuntimeJson } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneAnimationController } from "./compileSceneAnimationController";
import { DynamicAnimationControllerPlayer } from "./dynamicAnimationControllerPlayback";

function stateMachine(): SceneAnimationStateMachineState {
  return {
    enabled: true,
    initialStateId: "robot:idle",
    activeStateId: "robot:idle",
    transitionDuration: 0.25,
    states: [
      { id: "robot:idle", name: "Idle", modelId: "robot", clipId: "Idle", loop: true },
      { id: "robot:work", name: "Work", modelId: "robot", clipId: "Work Cycle", loop: true },
    ],
    parameters: { advance: false },
    transitions: [{ id: "idle-work", fromStateId: "robot:idle", toStateId: "robot:work", parameter: "advance", equals: true }],
  };
}

function runtimePackage(dynamicRuntime: DynamicSceneRuntime): DeepRuntimePackage {
  const packet = JSON.parse(readFileSync(new URL("../../../../packages/deep-engine-native/fixtures/render_packet_v1.json", import.meta.url), "utf8"));
  delete packet.schema; delete packet.version;
  for (const geometry of packet.geometries) {
    geometry.vertices = new Float32Array(geometry.vertices);
    geometry.indices = new Uint32Array(geometry.indices);
  }
  for (const instance of packet.instances) instance.transform = new Float32Array(instance.transform);
  return buildDeepRuntimePackage({
    packageId: "controller.fixture", packageVersion: "1.0.0",
    renderPacket: { id: "render", revision: 1, value: packet as RenderPacket },
    dynamicRuntime: { id: dynamicRuntime.id, revision: dynamicRuntime.revision, value: dynamicRuntime as unknown as RuntimeJson },
  });
}

describe("scene animation controller compile-to-player path", () => {
  it("compiles persisted authoring state into the explicit dynamic-runtime v2 ABI", () => {
    const runtime = compileSceneAnimationController({ id: "scene.controller", revision: 4, stateMachine: stateMachine() });
    expect(runtime).toMatchObject({
      schemaVersion: 2, id: "scene.controller", revision: 4,
      animationController: { schemaVersion: 1, activeStateId: "robot:idle", transitionDurationMs: 250 },
    });
    expect(compileSceneAnimationController({ id: "scene.controller", revision: 4, stateMachine: { ...stateMachine(), enabled: false } })).toBeUndefined();
    expect(() => compileSceneAnimationController({ id: "scene.controller", revision: 4, stateMachine: { ...stateMachine(), activeStateId: "missing" } })).toThrow(/compilation failed/);
  });

  it("starts the active clip and consumes one matching transition without mutating the package", () => {
    const runtime = compileSceneAnimationController({ id: "scene.controller", revision: 4, stateMachine: stateMachine() })!;
    const before = structuredClone(runtime);
    const playClip = vi.fn(() => true);
    const transitionClip = vi.fn(() => true);
    const player = new DynamicAnimationControllerPlayer(runtimePackage(runtime), { playClip, transitionClip });
    expect(player.start()).toBe(true);
    expect(playClip).toHaveBeenCalledWith("robot", "Idle", true);
    expect(player.evaluate()).toEqual({ applied: false, activeStateId: "robot:idle" });
    expect(player.setParameter("advance", true)).toBe(true);
    expect(player.evaluate()).toMatchObject({ applied: true, activeStateId: "robot:work", transition: { id: "idle-work" } });
    expect(transitionClip).toHaveBeenCalledWith({ modelId: "robot", fromClipId: "Idle", toClipId: "Work Cycle", durationMs: 250, loop: true });
    expect(runtime).toEqual(before);
  });

  it("fails closed when a host rejects a transition or a parameter is not declared", () => {
    const runtime = compileSceneAnimationController({ id: "scene.controller", revision: 4, stateMachine: { ...stateMachine(), parameters: { advance: true } } })!;
    const player = new DynamicAnimationControllerPlayer(runtimePackage(runtime), { playClip: () => true, transitionClip: () => false });
    expect(player.setParameter("unknown", true)).toBe(false);
    expect(player.evaluate()).toMatchObject({ applied: false, activeStateId: "robot:idle" });
    expect(player.activeStateId).toBe("robot:idle");
  });
});
