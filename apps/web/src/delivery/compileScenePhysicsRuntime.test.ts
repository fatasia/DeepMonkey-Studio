import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileScenePhysicsRuntime } from "./compileScenePhysicsRuntime";

function fixture(): SceneSnapshot {
  const transform = { position: { x: 100, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  return {
    schemaVersion: 1, id: "scene", projectId: "project", name: "physics", createdAt: "", updatedAt: "",
    camera: { mode: "orbit", position: { x: 100, y: 1, z: 5 }, target: { x: 100, y: 0, z: 0 } },
    primitives: [], measurements: [],
    models: [
      { modelId: "body-b", name: "B", visible: true, opacity: 1, transform, physics: { type: "fixed", mass: 1, friction: 0.4, restitution: 0 } },
      { modelId: "body-a", name: "A", visible: true, opacity: 1, transform, physics: { type: "dynamic", mass: 2, friction: 0.5, restitution: 0.1 } },
    ],
    physics: { enabled: true, playing: true, gravity: { x: 0, y: -9.81, z: 0 }, joints: [{
      id: "joint-a", kind: "revolute", bodyId: "body-a", connectedBodyId: "body-b",
      worldAnchor: { x: 101, y: 2, z: 3 }, localAnchor: { x: 0, y: 1, z: 0 }, axis: { x: 0, y: 1, z: 0 },
      limits: { enabled: true, min: -1, max: 1 }, motor: { enabled: true, targetVelocity: 2, strength: 4 },
    }] },
  };
}

describe("scene physics runtime compilation", () => {
  it("lowers sorted render-bound bodies, collision data and localized joints", () => {
    const runtime = compileScenePhysicsRuntime(fixture(), { coordinateOrigin: { x: 100, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-b", instanceIds: ["instance-b"] }, { nodeId: "body-a", instanceIds: ["instance-a"] },
    ] });
    expect(runtime).toMatchObject({ schemaVersion: 1, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }, { id: "body-b" }],
      joints: [{ id: "joint-a", solver: "impulse", connectedBodyId: "body-b", worldAnchor: [1, 2, 3] }] });
  });

  it("lowers kinematic bodies and preserves the character controller contract", () => {
    const scene = fixture();
    scene.models[0]!.physics = {
      type: "kinematic", mass: 1, friction: 0.4, restitution: 0,
      character: { offset: 0.02, maxSlopeClimbAngle: 0.7, autostep: { enabled: true, maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false }, snapToGround: { enabled: true, distance: 0.2 } },
    };
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 100, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-b", instanceIds: ["instance-b"] }, { nodeId: "body-a", instanceIds: ["instance-a"] },
    ] });
    expect(runtime?.bodies[1]).toMatchObject({ type: "kinematic", character: { offset: 0.02, autostep: { enabled: true }, snapToGround: { enabled: true } } });
  });

  it("fails closed when character controller data is attached to a dynamic body", () => {
    const scene = fixture();
    scene.models[0]!.physics = { type: "dynamic", mass: 1, friction: 0.4, restitution: 0, character: { offset: 0.02 } };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] },
    ] })).toThrow(/要求 kinematic/);
  });

  it("fails closed when collision geometry or multibody features are unsupported", () => {
    expect(() => compileScenePhysicsRuntime(fixture(), { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [] })).toThrow(/没有可用于碰撞体/);
    const scene = fixture(); scene.physics!.joints![0]!.solver = "multibody";
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] },
    ] })).toThrow(/multibody/);
  });
});
