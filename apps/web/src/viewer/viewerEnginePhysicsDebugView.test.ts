import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { ScenePhysicsBodyState } from "@bim-studio/contracts";
import { ViewerEngine } from "./ViewerEngine";
import { PhysicsWorldHost } from "./physicsWorldHost";
import { createPhysicsDebugOverlay } from "./rapierPhysicsDebugOverlay";
import { createPhysicsJointDebugLayer } from "./rapierPhysicsDebugJoints";
import { createPhysicsContactDebugLayer } from "./rapierPhysicsDebugContacts";

// T0 刀 3：宿主级调试可视化行为（真挂 rapier WASM，无渲染器——
// Object.create 装配既有宿主字段，与 roadPrefabPhysics 同模式）。

const bodyState = (type: ScenePhysicsBodyState["type"]): ScenePhysicsBodyState =>
  ({ type, mass: 1, friction: 0.7, restitution: 0.15 });

function harness() {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const makeBox = (name: string) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.updateWorldMatrix(true, true);
    return mesh;
  };
  const dynamicBox = makeBox("dyn");
  const fixedBox = makeBox("fix");
  const overlay = createPhysicsDebugOverlay();
  const jointLayer = createPhysicsJointDebugLayer();
  const contactLayer = createPhysicsContactDebugLayer();
  const physicsColliderOwners = new Map<number, string | null>();
  const shared = {
    models: new Map([
      ["dyn", { id: "dyn", assetModelId: "dyn", name: "动态箱", object: dynamicBox, kind: "primitive" as const, visible: true, opacity: 1 }],
      ["fix", { id: "fix", assetModelId: "fix", name: "静态箱", object: fixedBox, kind: "primitive" as const, visible: true, opacity: 1 }],
    ]),
    modelPrefabStates: new Map(),
    physicsBodyStates: new Map([
      ["dyn", bodyState("dynamic")],
      ["fix", bodyState("fixed")],
    ]),
    physicsBodies: new Map(),
    physicsColliderOwners,
    physicsJoints: new Map(),
    physicsState: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
    physicsHost: new PhysicsWorldHost(),
    physicsDebugVisible: false,
    physicsDebugFilter: "all",
    physicsDebugSelectedId: undefined,
    physicsDebugLayers: { colliders: true, contacts: true, joints: true },
    physicsDebugOverlay: overlay,
    physicsJointDebugLayer: jointLayer,
    physicsContactDebugLayer: contactLayer,
    physicsReplayFrame: undefined,
    lastContactSampled: 0,
    requestRender: () => {},
  };
  Object.assign(engine, shared);
  const host = engine as unknown as typeof shared & {
    ensurePhysicsWorld(): Promise<void>;
    physicsWorld: InstanceType<(typeof import("@dimforge/rapier3d-compat"))["default"]["World"]> | undefined;
    rapier: (typeof import("@dimforge/rapier3d-compat"))["default"] | undefined;
    updatePhysicsDebugView(): void;
    collectPhysicsDebugJointViz(): Array<{ id: string; kind: string; anchor: { x: number; y: number; z: number }; axis: { x: number; y: number; z: number } }>;
    setPhysicsDebugVisible(enabled: boolean): void;
    setPhysicsDebugFilter(filter: string, selectedId?: string): void;
    filterColliderEntries(entries: Array<{ modelId: string | null }>): Array<{ modelId: string | null }>;
    resolveColliderEntryKind(entry: { modelId: string | null }): string;
    getPhysicsDebugSnapshot(): { debug: { colliderCount: number; contactCount: number; jointCount: number }; available: boolean };
    setPhysicsDebugLayers(layers: { colliders: boolean; contacts: boolean; joints: boolean }): void;
  };
  return { engine, host, overlay, jointLayer, contactLayer };
}

describe("物理调试视图宿主行为（T0 刀 3）", () => {
  it("开启后线框对象数=场景碰撞体数（2 体 + 默认地面 = 3），关闭后三组图层全隐藏零残留", async () => {
    const { host, overlay, jointLayer, contactLayer } = harness();
    await host.ensurePhysicsWorld();
    host.setPhysicsDebugVisible(true);
    const lines = overlay.object.children;
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.visible)).toBe(true);
    expect(overlay.object.visible).toBe(true);
    host.setPhysicsDebugVisible(false);
    expect(overlay.object.visible).toBe(false);
    expect(jointLayer.object.visible).toBe(false);
    expect(contactLayer.object.visible).toBe(false);
  });

  it("筛选=动态只留动态体线框；筛选=静态含默认地面（静态语义）", async () => {
    const { host, overlay } = harness();
    await host.ensurePhysicsWorld();
    host.setPhysicsDebugVisible(true);
    host.setPhysicsDebugFilter("dynamic");
    const visible = overlay.object.children.filter((line) => line.visible);
    expect(visible).toHaveLength(1);
    // 动态绿。
    expect(((visible[0] as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex()).toBe(0x43a047);
    host.setPhysicsDebugFilter("fixed");
    expect(overlay.object.children.filter((line) => line.visible)).toHaveLength(2); // 静态箱 + 地面
  });

  it("筛选=选中聚焦该对象：白色线框、唯一可见；关节同步按选中过滤", async () => {
    const { host, overlay, jointLayer } = harness();
    Object.assign(host, {
      physicsState: {
        enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 },
        joints: [{ id: "j1", kind: "revolute", bodyId: "dyn", worldAnchor: { x: 0, y: 0, z: 0 },
          localAnchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 1, z: 0 },
          limits: { enabled: true, min: -0.5, max: 0.5 }, motor: { enabled: false, targetVelocity: 0, strength: 0 } }],
      },
    });
    await host.ensurePhysicsWorld();
    host.setPhysicsDebugVisible(true);
    host.setPhysicsDebugFilter("selected", "dyn");
    const visible = overlay.object.children.filter((line) => line.visible);
    expect(visible).toHaveLength(1);
    expect(((visible[0] as THREE.LineSegments).material as THREE.LineBasicMaterial).color.getHex()).toBe(0xffffff);
    // 关节涉及选中体：保留；轴线层 drawRange=8 端点。
    const jointGeometry = (jointLayer.object.children[0] as THREE.LineSegments).geometry;
    expect(jointGeometry.drawRange.count).toBe(8);
    host.setPhysicsDebugFilter("selected", "fix");
    expect(jointGeometry.drawRange.count).toBe(0);
  });

  it("接触点：动态体落地面后调试同步给出接触计数，快照 debug 字段可读", async () => {
    const { host, contactLayer } = harness();
    await host.ensurePhysicsWorld();
    const world = host.physicsWorld!;
    for (let step = 0; step < 90; step += 1) {
      world.timestep = 1 / 60;
      world.step();
    }
    host.setPhysicsDebugVisible(true);
    const snapshot = host.getPhysicsDebugSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.debug.colliderCount).toBe(3);
    expect(snapshot.debug.contactCount).toBeGreaterThan(0);
    expect(contactLayer.object.visible).toBe(true);
    const geometry = (contactLayer.object.children[0] as THREE.Points).geometry;
    expect(geometry.drawRange.count).toBeGreaterThan(0);
    // 图层开关关闭接触：计数清零、层隐藏。
    host.setPhysicsDebugLayers({ colliders: true, contacts: false, joints: true });
    expect(contactLayer.object.visible).toBe(false);
    expect(host.getPhysicsDebugSnapshot().debug.contactCount).toBe(0);
  });

  it("性能预算：1000 碰撞体线框 60 帧同步 + 真实接触遍历 ≤2s（UX 纪律 4）", async () => {
    const { collectPhysicsDebugEntries } = await import("./rapierPhysicsDebugView");
    const { collectPhysicsContactPoints } = await import("./rapierPhysicsDebugContacts");
    const module = (await import("@dimforge/rapier3d-compat")).default;
    const world = new module.World({ x: 0, y: -9.81, z: 0 });
    // 1000 个静态碰撞体（真句柄，收集与接触查询走真实 WASM 路径）。
    const owners = new Map<number, string | null>();
    for (let index = 0; index < 1000; index += 1) {
      const collider = world.createCollider(
        module.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(index % 10, Math.floor(index / 100), index % 7),
      );
      owners.set(collider.handle, `body-${index}`);
    }
    const entries = collectPhysicsDebugEntries(world, module, owners);
    expect(entries).toHaveLength(1000);
    const overlay = createPhysicsDebugOverlay();
    const kindOf = () => "dynamic" as const;
    const started = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      entries[frame % 1000]!.translation.y += 0.001; // 模拟步进位姿变化
      overlay.sync(entries, kindOf);
    }
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    const contactStarted = performance.now();
    for (let frame = 0; frame < 10; frame += 1) collectPhysicsContactPoints(world, owners);
    expect(performance.now() - contactStarted).toBeLessThan(2_000);
    overlay.dispose();
    world.free();
  });
});
