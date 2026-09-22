import { describe, expect, it } from "vitest";
import type { ScenePhysicsJointState } from "@bim-studio/contracts";
import { mountRapierJoint, mountRapierRevoluteJoint, normalizePhysicsJoints, removeMountedRapierJoint } from "./rapierPhysicsJoint";

const joint = (patch: Partial<ScenePhysicsJointState> = {}): ScenePhysicsJointState => ({
  id: "joint-a", kind: "revolute", bodyId: "body-a",
  worldAnchor: { x: 0, y: 1, z: 0 }, localAnchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 4 },
  limits: { enabled: true, min: -0.4, max: 0.4 },
  motor: { enabled: true, targetVelocity: 1.5, strength: 0.8 },
  ...patch,
});

describe("Rapier product joint adapter", () => {
  it("normalizes axes, ranges and duplicate author IDs", () => {
    const normalized = normalizePhysicsJoints([
      joint({ limits: { enabled: true, min: 20, max: -20 }, motor: { enabled: true, targetVelocity: 1e6, strength: -2 } }),
      joint({ bodyId: "duplicate" }),
      joint({ id: "", bodyId: "missing" }),
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      axis: { x: 0, y: 0, z: 1 },
      limits: { min: -Math.PI * 2, max: Math.PI * 2 },
      motor: { targetVelocity: 100, strength: 0 },
    });
  });

  it("keeps a distinct connected rigid body and rejects self joints", () => {
    expect(normalizePhysicsJoints([joint({ connectedBodyId: " body-b " })])[0]?.connectedBodyId).toBe("body-b");
    expect(normalizePhysicsJoints([joint({ connectedBodyId: "body-a" })])).toEqual([]);
  });

  it("fails closed for unsupported multibody limits or motors", () => {
    expect(normalizePhysicsJoints([joint({ solver: "multibody" })])).toEqual([]);
    const supported = joint({ solver: "multibody", limits: { enabled: false, min: -0.4, max: 0.4 },
      motor: { enabled: false, targetVelocity: 0, strength: 0 } });
    expect(normalizePhysicsJoints([supported])[0]?.solver).toBe("multibody");
    expect(normalizePhysicsJoints([
      { ...supported, connectedBodyId: "body-b" },
      { ...supported, id: "joint-b", bodyId: "body-b", connectedBodyId: "body-a" },
    ])).toEqual([]);
  });

  it("mounts a real limited velocity joint and keeps it bounded", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (args[0] !== "using deprecated parameters for the initialization function; pass a single object instead") originalWarn(...args);
    };
    try { await rapier.init(); } finally { console.warn = originalWarn; }
    const world = new rapier.World({ x: 0, y: 0, z: 0 });
    const fixed = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const moving = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
    world.createCollider(rapier.ColliderDesc.cuboid(0.2, 0.5, 0.2), moving);
    const runtime = mountRapierRevoluteJoint(rapier, world, fixed, moving, joint());

    let peakAngularVelocity = 0;
    for (let frame = 0; frame < 180; frame += 1) {
      world.timestep = 1 / 60;
      world.step();
      peakAngularVelocity = Math.max(peakAngularVelocity, Math.abs(moving.angvel().z));
    }

    expect(runtime.isValid()).toBe(true);
    expect(runtime.limitsEnabled()).toBe(true);
    expect(runtime.limitsMin()).toBeCloseTo(-0.4, 5);
    expect(runtime.limitsMax()).toBeCloseTo(0.4, 5);
    expect(peakAngularVelocity).toBeGreaterThan(0.01);
    world.free();
  });

  it("converts the authored world pivot into the connected body's local anchor", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: 0, z: 0 });
    const halfTurn = Math.PI / 4;
    const connected = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(2, 1, 0)
      .setRotation({ x: 0, y: 0, z: Math.sin(halfTurn), w: Math.cos(halfTurn) }));
    const moving = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(3, 1, 0));
    world.createCollider(rapier.ColliderDesc.cuboid(0.2, 0.2, 0.2), moving);
    const runtime = mountRapierRevoluteJoint(rapier, world, connected, moving, joint({
      connectedBodyId: "body-b", worldAnchor: { x: 2, y: 1.5, z: 0 }, localAnchor: { x: -0.5, y: 0, z: 0 },
      motor: { enabled: false, targetVelocity: 0, strength: 0 },
    }));

    expect(runtime.anchor1().x).toBeCloseTo(0.5, 6);
    expect(runtime.anchor1().y).toBeCloseTo(0, 6);
    expect(runtime.anchor2().x).toBeCloseTo(-0.5, 6);
    for (let frame = 0; frame < 60; frame += 1) { world.timestep = 1 / 60; world.step(); }
    expect(runtime.isValid()).toBe(true);
    world.free();
  });

  it("creates and removes a real product multibody joint", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const root = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const link = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0.5, 2, 0));
    world.createCollider(rapier.ColliderDesc.ball(0.2), link);
    const state = joint({ solver: "multibody", worldAnchor: { x: 0, y: 2, z: 0 }, localAnchor: { x: -0.5, y: 0, z: 0 },
      limits: { enabled: false, min: 0, max: 0 }, motor: { enabled: false, targetVelocity: 0, strength: 0 } });
    const runtime = mountRapierJoint(rapier, world, root, link, state);

    expect(runtime.solver).toBe("multibody");
    expect(runtime.joint.isValid()).toBe(true);
    for (let frame = 0; frame < 60; frame += 1) { world.timestep = 1 / 60; world.step(); }
    expect(Math.abs(link.translation().x - 0.5)).toBeGreaterThan(0.001);
    removeMountedRapierJoint(world, runtime);
    expect(runtime.joint.isValid()).toBe(false);
    world.free();
  });
});
