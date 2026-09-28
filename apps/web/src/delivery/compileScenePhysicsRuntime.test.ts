import { describe, expect, it } from "vitest";
import type { SceneSnapshot, ScenePhysicsBodyState } from "@bim-studio/contracts";
import { validateDynamicSceneRuntime } from "@bim-studio/deep-engine/runtime-package";
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
    const scene = fixture();
    scene.models[1]!.physics!.initialLinearVelocity = { x: 80, y: 0, z: 0 };
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 100, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-b", instanceIds: ["instance-b"] }, { nodeId: "body-a", instanceIds: ["instance-a"] },
    ] });
    expect(runtime).toMatchObject({ schemaVersion: 1, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", initialLinearVelocity: [80, 0, 0], collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }, { id: "body-b" }],
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

  it("rejects initial velocity on fixed bodies and values beyond the supported metre-per-second range", () => {
    const bindings = [{ nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] }];
    const scene = fixture();
    scene.models[0]!.physics!.initialLinearVelocity = { x: 80, y: 0, z: 0 };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/初速度要求 dynamic/);
    delete scene.models[0]!.physics!.initialLinearVelocity;
    scene.models[1]!.physics!.initialLinearVelocity = { x: 1_001, y: 0, z: 0 };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/±1000 m\/s/);
  });

  it("fails closed when collision geometry or multibody features are unsupported", () => {
    expect(() => compileScenePhysicsRuntime(fixture(), { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [] })).toThrow(/没有可用于碰撞体/);
    const scene = fixture(); scene.physics!.joints![0]!.solver = "multibody";
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [
      { nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] },
    ] })).toThrow(/multibody/);
  });

  it("lowers hull, simplified-mesh and primitive colliders and the payload re-validates as a runtime package", () => {
    const scene = fixture();
    scene.models[1]!.physics!.collider = { kind: "convex-hull",
      precision: { approximate: true, reasons: ["topology-error:NON_MANIFOLD_EDGE"], hullVertexCount: 4, topologyOk: false },
      points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] };
    scene.models[0]!.physics!.collider = { kind: "simplified-mesh",
      positions: [{ x: -0.5, y: 0, z: -0.5 }, { x: 0.5, y: 0, z: -0.5 }, { x: 0, y: 0, z: 0.5 }],
      indices: [0, 1, 2], precision: { approximate: false, triangleCount: 1, tolerance: 0.005, topologyOk: true } };
    const bindings = [{ nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] }];
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })!;
    expect(runtime.bodies[0]!.collider).toMatchObject({ kind: "convex-hull",
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      precision: { approximate: true, reasons: ["topology-error:NON_MANIFOLD_EDGE"], hullVertexCount: 4 } });
    expect(runtime.bodies[1]!.collider).toMatchObject({ kind: "simplified-mesh",
      positions: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0, 0, 0.5]], indices: [0, 1, 2] });
    // 编译产物必须能通过运行包解析层(端到端 ABI 闭环)。
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics: runtime }).valid).toBe(true);
    // primitive 显式几何(球/柱/盒)逐一下译;halfExtents 按合同从 Vector3Value 落为元组。
    const primitives = [
      { kind: "primitive", primitive: { shape: "sphere", radius: 0.5 } },
      { kind: "primitive", primitive: { shape: "cylinder", radius: 0.4, halfHeight: 0.2 } },
      { kind: "primitive", primitive: { shape: "cuboid", halfExtents: { x: 0.5, y: 0.25, z: 1 } } },
    ] as const;
    for (const collider of primitives) {
      scene.models[1]!.physics!.collider = collider;
      const compiled = compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })!;
      const lowered = collider.primitive.shape === "cuboid"
        ? { shape: "cuboid", halfExtents: [collider.primitive.halfExtents.x, collider.primitive.halfExtents.y, collider.primitive.halfExtents.z] }
        : collider.primitive;
      expect(compiled.bodies[0]!.collider).toMatchObject({ kind: "primitive", primitive: lowered });
    }
  });

  it("rejects generated colliders without precision marks or with invalid geometry", () => {
    const bindings = [{ nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] }];
    const scene = fixture();
    scene.models[0]!.physics!.collider = { kind: "convex-hull", points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }] };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/精度标记/);
    scene.models[0]!.physics!.collider = { kind: "convex-hull", precision: {}, points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/至少需要 4 个/);
    scene.models[0]!.physics!.collider = { kind: "simplified-mesh", precision: {}, positions: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], indices: [0, 1, 2] };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/几何无效/);
    scene.models[0]!.physics!.collider = { kind: "primitive", primitive: { shape: "sphere", radius: 0 } };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/正半径/);
  });
});
