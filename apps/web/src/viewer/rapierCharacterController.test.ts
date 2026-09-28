import { describe, expect, it } from "vitest";
import {
  configureCharacterController,
  mountRapierCharacterController,
  moveRapierCharacter,
  normalizeCharacterController,
  RAPIER_CHARACTER_DEFAULTS,
} from "./rapierCharacterController";

describe("角色控制器参数归一化(与 Native from_runtime 同语义)", () => {
  it("全部省略时回落 Rapier 默认,可选项不产生启用段", () => {
    const normalized = normalizeCharacterController(undefined);
    expect(normalized.offset).toBe(RAPIER_CHARACTER_DEFAULTS.offset);
    expect(normalized.maxSlopeClimbAngle).toBe(RAPIER_CHARACTER_DEFAULTS.maxSlopeClimbAngle);
    expect(normalized.minSlopeSlideAngle).toBe(RAPIER_CHARACTER_DEFAULTS.minSlopeSlideAngle);
    expect(normalized.autostep).toBeUndefined();
    expect(normalized.snapToGround).toBeUndefined();
  });

  it("显式字段逐项透传,越界值钳回合同区间", () => {
    const normalized = normalizeCharacterController({
      offset: 0.02,
      maxSlopeClimbAngle: 0.7,
      minSlopeSlideAngle: 0.5,
      autostep: { enabled: true, maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: true },
      snapToGround: { enabled: true, distance: 0.25 },
    });
    expect(normalized.offset).toBe(0.02);
    expect(normalized.maxSlopeClimbAngle).toBe(0.7);
    expect(normalized.autostep).toEqual({
      maxHeight: 0.3,
      minWidth: 0.2,
      includeDynamicBodies: true,
    });
    expect(normalized.snapToGround).toEqual({ distance: 0.25 });

    const wild = normalizeCharacterController({
      offset: 100,
      maxSlopeClimbAngle: 9,
      snapToGround: { enabled: true, distance: -1 },
    });
    expect(wild.offset).toBe(10);
    expect(wild.maxSlopeClimbAngle).toBe(Math.PI / 2);
    // 越界值钳回合同下界(仅缺省字段回落默认值,非法值不回落)。
    expect(wild.snapToGround?.distance).toBe(1e-3);
  });

  it("enabled=false 的可选项不启用,configure 返回同一归一化结果", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    const collider = world.createCollider(rapier.ColliderDesc.cuboid(0.25, 0.5, 0.25), body);
    const normalized = configureCharacterController(
      mountRapierCharacterController(world, collider, {
        offset: 0.03,
        autostep: { enabled: false },
        snapToGround: { enabled: false },
      }).controller,
      { offset: 0.03, autostep: { enabled: false }, snapToGround: { enabled: false } },
    );
    expect(normalized.offset).toBe(0.03);
    expect(normalized.autostep).toBeUndefined();
    expect(normalized.snapToGround).toBeUndefined();
    world.free();
  });
});

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
