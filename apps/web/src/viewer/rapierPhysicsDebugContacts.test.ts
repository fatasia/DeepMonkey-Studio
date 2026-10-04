import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { collectPhysicsContactPoints, createPhysicsContactDebugLayer, MAX_CONTACT_POINTS } from "./rapierPhysicsDebugContacts";

// T0 刀 3：Node 内真挂 rapier WASM（与关节/视图测试同模式），
// 钉死即时接触查询的配对去重、筛选与上限语义。
async function makeWorld() {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ x: 0, y: -9.81, z: 0 });
  return { rapier, world };
}

describe("collectPhysicsContactPoints", () => {
  it("下落体接触地面时收集到世界系接触点与法线，配对不重复计数", async () => {
    const { rapier, world } = await makeWorld();
    const ground = world.createCollider(rapier.ColliderDesc.cuboid(50, 0.05, 50).setTranslation(0, -0.05, 0));
    const owners = new Map<number, string | null>([[ground.handle, null]]);
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0, 0.45, 0));
    const box = world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS), body);
    owners.set(box.handle, "box");
    for (let step = 0; step < 60; step += 1) {
      world.timestep = 1 / 60;
      world.step();
    }
    const collection = collectPhysicsContactPoints(world, owners);
    expect(collection.sampled).toBeGreaterThan(0);
    expect(collection.points.length).toBe(collection.sampled * 3);
    expect(collection.normals.length).toBe(collection.sampled * 6);
    // 接触点在接触面附近（y≈0，容差 0.1）。
    const pointY = collection.points[1]!;
    expect(Math.abs(pointY)).toBeLessThan(0.1);
    world.free();
  });

  it("分离体零接触；筛选下不在可见集内的碰撞体对不产出", async () => {
    const { rapier, world } = await makeWorld();
    const owners = new Map<number, string | null>();
    const a = world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(0, 5, 0));
    const b = world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(0, 15, 0));
    owners.set(a.handle, "a");
    owners.set(b.handle, "b");
    world.timestep = 1 / 60;
    world.step();
    expect(collectPhysicsContactPoints(world, owners).sampled).toBe(0);
    // 相同世界，筛选排除所有体：可见集为空集 → 即便有接触也不产出（上下文语义由宿主组合）。
    expect(collectPhysicsContactPoints(world, owners, new Set(["other"])).sampled).toBe(0);
    world.free();
  });

  it("筛选：体与地面接触时，可见集含该体即产出（地面 null 恒为上下文）", async () => {
    const { rapier, world } = await makeWorld();
    const ground = world.createCollider(rapier.ColliderDesc.cuboid(50, 0.05, 50).setTranslation(0, -0.05, 0));
    const owners = new Map<number, string | null>([[ground.handle, null]]);
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0, 0.45, 0));
    const box = world.createCollider(rapier.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    owners.set(box.handle, "box");
    for (let step = 0; step < 60; step += 1) {
      world.timestep = 1 / 60;
      world.step();
    }
    expect(collectPhysicsContactPoints(world, owners, new Set(["box"])).sampled).toBeGreaterThan(0);
    expect(collectPhysicsContactPoints(world, owners, new Set(["unrelated"])).sampled).toBe(0);
    world.free();
  });
});

describe("createPhysicsContactDebugLayer", () => {
  it("同步点数并截断超上限输入；setVisible/dispose 生命周期", () => {
    const layer = createPhysicsContactDebugLayer();
    layer.setVisible(true);
    expect(layer.object.visible).toBe(true);
    const count = MAX_CONTACT_POINTS + 4;
    const points: number[] = [];
    const normals: number[] = [];
    for (let index = 0; index < count; index += 1) {
      points.push(index, 0, 0);
      normals.push(index, 0, 0, index, 1, 0);
    }
    layer.sync(points, normals);
    const geometry = (layer.object.children[0] as THREE.Points).geometry;
    expect(geometry.drawRange.count).toBe(MAX_CONTACT_POINTS);
    layer.sync([], undefined);
    expect(geometry.drawRange.count).toBe(0);
    const parent = new THREE.Group();
    parent.add(layer.object);
    layer.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
