import { describe, expect, it } from "vitest";
import { collectPhysicsDebugEntries, collectPhysicsCuboidDebugEntries } from "./rapierPhysicsDebugView";

// B3 缺口 5 + T0 刀 3：Node 内真挂 rapier WASM（与角色控制器测试同模式），
// 钉死调试数据的的世界位姿/形状描述/偏移语义，供调试线框层消费。
describe("collectPhysicsDebugEntries", () => {
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

    const entries = collectPhysicsDebugEntries(world, rapier, owners);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    // 世界位姿取自刚体；偏移与半尺寸取自碰撞体本身。
    expect(entry.modelId).toBe("model-a");
    expect(entry.handle).toBe(collider.handle);
    expect(entry.translation).toEqual({ x: 1, y: 2, z: 3 });
    expect(entry.rotationQuaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(entry.shape).toEqual({ kind: "cuboid", halfExtents: { x: 0.5, y: 0.25, z: 0.75 } });
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

    const entries = collectPhysicsDebugEntries(world, rapier, owners);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.modelId).toBeNull();
    expect(entries[0]!.shape).toEqual({ kind: "cuboid", halfExtents: { x: 50, y: 0.05, z: 50 } });
    world.free();
  });

  it("describes ball and convex/trimesh shapes with collider-local vertices", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const owners = new Map<number, string | null>();
    const ball = world.createCollider(rapier.ColliderDesc.ball(0.4).setTranslation(0, 1, 0));
    owners.set(ball.handle, "ball-model");
    // 凸包：四面体顶点（自动凸包路径，indices 为 null 时渲染退化为包围盒）。
    const hullPoints = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const hull = world.createCollider(rapier.ColliderDesc.convexHull(hullPoints)!);
    owners.set(hull.handle, "hull-model");
    // 三角网格：两个三角形（trimesh 索引必在）。
    const meshVertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]);
    const meshIndices = new Uint32Array([0, 1, 2, 1, 3, 2]);
    const trimesh = world.createCollider(rapier.ColliderDesc.trimesh(meshVertices, meshIndices));
    owners.set(trimesh.handle, "mesh-model");

    const entries = collectPhysicsDebugEntries(world, rapier, owners);
    expect(entries).toHaveLength(3);
    const ballEntry = entries.find((entry) => entry.modelId === "ball-model")!;
    expect(ballEntry.shape).toEqual({ kind: "ball", radius: 0.4 });
    const hullEntry = entries.find((entry) => entry.modelId === "hull-model")!;
    expect(hullEntry.shape.kind).toBe("convex");
    expect((hullEntry.shape as { vertices: Float32Array }).vertices.length).toBe(12);
    const meshEntry = entries.find((entry) => entry.modelId === "mesh-model")!;
    expect(meshEntry.shape.kind).toBe("trimesh");
    expect((meshEntry.shape as { indices: Uint32Array }).indices).toEqual(meshIndices);
    world.free();
  });

  it("counts unsupported shapes as skipped instead of dropping silently", async () => {
    // heightfield 归属不支持形状：统计进 skippedUnsupported（调用方传 stats 时）。
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const owners = new Map<number, string | null>();
    const heightfield = world.createCollider(
      rapier.ColliderDesc.heightfield(1, 1, new Float32Array([0, 0, 0, 0]), { x: 2, y: 1, z: 2 }),
    );
    owners.set(heightfield.handle, "terrain");
    const stats = { skippedUnsupported: 0 };
    const entries = collectPhysicsDebugEntries(world, rapier, owners, stats);
    expect(entries).toHaveLength(0);
    expect(stats.skippedUnsupported).toBe(1);
    world.free();
  });

  it("legacy cuboid alias forwards to the same collector", async () => {
    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
    const owners = new Map<number, string | null>();
    const collider = world.createCollider(rapier.ColliderDesc.cuboid(1, 1, 1));
    owners.set(collider.handle, null);
    expect(collectPhysicsCuboidDebugEntries(world, rapier, owners)).toEqual(
      collectPhysicsDebugEntries(world, rapier, owners),
    );
    world.free();
  });
});
