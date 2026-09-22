import { describe, expect, it } from "vitest";
import { mountRapierCharacterController, moveRapierCharacter } from "./rapierCharacterController";

describe("Rapier 角色控制器适配", () => {
  it("计算碰撞后位移并排队下一次 kinematic 位姿", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    const collider = world.createCollider(rapier.ColliderDesc.cuboid(0.25, 0.5, 0.25), body);
    const mounted = mountRapierCharacterController(world, collider, { snapToGround: { enabled: true, distance: 0.2 } });

    const result = moveRapierCharacter(mounted, body, { x: 0.25, y: -0.1, z: 0 });
    expect(result.movement.x).toBeCloseTo(0.25, 6);
    expect(body.nextTranslation().x).toBeCloseTo(0.25, 6);
    expect(result.grounded).toBe(false);
    world.free();
  });

  it("拒绝非有限位移和错误刚体类型", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: 0, z: 0 });
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic());
    const collider = world.createCollider(rapier.ColliderDesc.ball(0.25), body);
    const mounted = mountRapierCharacterController(world, collider, undefined);
    expect(() => moveRapierCharacter(mounted, body, { x: Number.NaN, y: 0, z: 0 })).toThrow("有限数值");
    expect(() => moveRapierCharacter(mounted, body, { x: 0, y: 0, z: 0 })).toThrow("kinematic");
    world.free();
  });
});
