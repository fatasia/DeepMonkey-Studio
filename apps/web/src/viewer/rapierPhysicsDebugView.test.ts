import { describe, expect, it } from "vitest";
import { collectPhysicsCuboidDebugEntries } from "./rapierPhysicsDebugView";

// B3 缺口 5：Node 内真挂 rapier WASM（与角色控制器测试同模式），
// 钉死调试数据的世界位姿/半尺寸/偏移语义，供调试线框层消费。
describe("collectPhysicsCuboidDebugEntries", () => {
  it("returns body world pose plus collider half extents and center offset", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.fixed().setTranslation(1, 2, 3),
    );
    const owners = new Map<number, string | null>();
    const collider = world.createCollider(
      rapier.ColliderDesc.cuboid(0.5, 0.25, 0.75).setTranslation(0, 0.5, 0),
      body,
    );
    owners.set(collider.handle, "model-a");

    const entries = collectPhysicsCuboidDebugEntries(world, rapier, owners);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // 世界位姿取自刚体；偏移与半尺寸取自碰撞体本身。
    expect(entry.modelId).toBe("model-a");
    expect(entry.translation).toEqual({ x: 1, y: 2, z: 3 });
    expect(entry.rotationQuaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(entry.halfExtents).toEqual({ x: 0.5, y: 0.25, z: 0.75 });
    expect(entry.centerOffset).toEqual({ x: 0, y: 0.5, z: 0 });
    world.free();
  });

  it("skips stale handles and keeps the ground as a null-owner entry", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const owners = new Map<number, string | null>();
    const ground = world.createCollider(
      rapier.ColliderDesc.cuboid(50, 0.05, 50).setTranslation(0, -0.05, 0),
    );
    owners.set(ground.handle, null);
    // 失效句柄：body 移除后其句柄若残留于归属表（真实路径在 removePhysicsBody
    // 会同步注销），收集必须跳过不抛错、不产条目。
    const tempBody = world.createRigidBody(rapier.RigidBodyDesc.fixed());
    const tempCollider = world.createCollider(rapier.ColliderDesc.cuboid(1, 1, 1), tempBody);
    owners.set(tempCollider.handle, "ghost");
    world.removeRigidBody(tempBody);

    const entries = collectPhysicsCuboidDebugEntries(world, rapier, owners);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.modelId).toBeNull();
    expect(entries[0]!.halfExtents).toEqual({ x: 50, y: 0.05, z: 50 });
    world.free();
  });
});
