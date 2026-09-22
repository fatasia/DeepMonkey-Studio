import type { IndustrialPrefabInstanceState, ScenePhysicsBodyState } from "@bim-studio/contracts";
import type { RigidBody, World as RapierWorldType } from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildLinearPrefabGeometry } from "../prefabs/linearPrefabGeometry";
import { roadPrefabSegmentColliders } from "../prefabs/roadPrefabColliders";
import { industrialPrefabProxyGroundOffset } from "./industrialPrefabProxy";
import { PhysicsWorldHost } from "./physicsWorldHost";
import { collectPhysicsCuboidDebugEntries } from "./rapierPhysicsDebugView";
import { ViewerEngine } from "./ViewerEngine";

type RapierModule = (typeof import("@dimforge/rapier3d-compat"))["default"];

interface PhysicsRuntimeStub {
  body: RigidBody;
  colliderHandle: number;
  extraColliderHandles?: readonly number[];
}

/** 与作者态一致的道路层次：隐藏的原语根 + 代理组（落地偏移）+ 分段/盖板几何。 */
function roadObject(state: IndustrialPrefabInstanceState): THREE.Mesh {
  const root = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ visible: false }));
  root.userData.primitiveKind = "box";
  const surface = new THREE.MeshStandardMaterial();
  const proxy = buildLinearPrefabGeometry(state, { surface, shoulder: surface.clone(), marking: surface.clone() })!;
  proxy.position.y = industrialPrefabProxyGroundOffset(root);
  root.add(proxy);
  root.updateWorldMatrix(true, true);
  return root;
}

function roadState(parameters: Record<string, unknown> = {}): IndustrialPrefabInstanceState {
  return { definitionId: "road.straight", definitionVersion: "1.0.0", kind: "road", operatingState: "idle",
    parameters: { lengthM: 20, carriagewayWidthM: 7, laneCount: 2, shoulderWidthM: 0.75, surface: "asphalt", marking: "center", ...parameters },
    placementPath: { points: [
      { id: "a", position: { x: 0, y: 0, z: 0 } },
      { id: "b", position: { x: 12, y: 0, z: 0 } },
      { id: "c", position: { x: 12, y: 0, z: 9 } },
    ], interpolation: "linear", closed: false, snapToGround: false, seed: 9 } };
}

const fixedBody = (): ScenePhysicsBodyState => ({ type: "fixed", mass: 1, friction: 0.9, restitution: 0 });

/** 最小引擎桩：真实原型方法 + 只注入物理链所需字段，不触碰渲染器。 */
function physicsHarness(state: IndustrialPrefabInstanceState, modelId = "road") {
  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
  const object = roadObject(state);
  const physicsColliderOwners = new Map<number, string | null>();
  const physicsBodies = new Map<string, PhysicsRuntimeStub>();
  Object.assign(engine, {
    models: new Map([[modelId, { id: modelId, assetModelId: modelId, name: "道路", object,
      kind: "primitive" as const, visible: true, opacity: 1 }]]),
    modelPrefabStates: new Map([[modelId, state]]),
    physicsBodyStates: new Map([[modelId, fixedBody()]]),
    physicsBodies,
    physicsColliderOwners,
    physicsJoints: new Map(),
    physicsState: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
    physicsHost: new PhysicsWorldHost(),
  });
  const physics = engine as unknown as {
    ensurePhysicsWorld(): Promise<void>;
    removePhysicsBody(id: string): void;
    physicsWorld: RapierWorldType;
    rapier: RapierModule;
  };
  return { engine, physics, physicsBodies, physicsColliderOwners };
}

function roadEntries(world: RapierWorldType, rapier: RapierModule, owners: Map<number, string | null>) {
  return collectPhysicsCuboidDebugEntries(world, rapier, owners).filter(entry => entry.modelId === "road");
}

describe("道路分段碰撞体接入查看器物理链", () => {
  it("路径式道路每段生成一个固定 cuboid，尺寸、偏移与旋向跟几何同源", async () => {
    const { physics, physicsBodies, physicsColliderOwners } = physicsHarness(roadState());
    await physics.ensurePhysicsWorld();
    // ensurePhysicsWorld 收尾按 physicsBodyStates 统一创建，与真实加载路径同一条代码路径。
    const runtime = physicsBodies.get("road");
    expect(runtime).toBeDefined();
    const body = runtime!.body;
    // 3 个路径点 → 2 段 → 2 个碰撞体（1 主句柄 + 1 附加句柄）。
    expect(body.numColliders()).toBe(2);
    const owned = [...physicsColliderOwners.entries()].filter(([, owner]) => owner === "road");
    expect(owned).toHaveLength(2);
    const entries = roadEntries(physics.physicsWorld, physics.rapier, physicsColliderOwners);
    expect(entries).toHaveLength(2);
    // 代理相对根对象有 -0.5 落地偏移（BoxGeometry min.y），碰撞体偏移随之平移；缺省厚度 0.16 时顶面对齐路面顶。
    const straight = entries.find(entry => Math.abs(entry.centerOffset.x - 6) < 1e-6)!;
    expect(straight).toBeDefined();
    expect(straight.halfExtents).toMatchObject({ x: 6, y: 0.08, z: (7 + 2 * 0.75) / 2 });
    expect(straight.centerOffset.y).toBeCloseTo(-0.5);
    expect(straight.centerOffset.z).toBeCloseTo(0);
    const branch = entries.find(entry => Math.abs(entry.centerOffset.z - 4.5) < 1e-6)!;
    expect(branch.halfExtents).toMatchObject({ x: 4.5, y: 0.08, z: 4.25 });
    expect(branch.centerOffset).toMatchObject({ x: 12, y: -0.5 });
    // 支路 yaw = atan2(9, 0) = π/2，几何以 -yaw 摆放，碰撞体旋向一致（body 无旋转 → 世界系即局部系）。
    const branchHandle = owned.find(([handle]) => handle !== runtime!.colliderHandle)![0]!;
    const rotation = physics.physicsWorld.getCollider(branchHandle)!.rotation();
    expect(rotation.y).toBeCloseTo(-Math.SQRT1_2);
    expect(rotation.w).toBeCloseTo(Math.SQRT1_2);
    expect(rotation.x).toBeCloseTo(0);
    expect(rotation.z).toBeCloseTo(0);
  });

  it("厚度取作者 colliderThicknessM 参数，顶面仍与路面顶对齐", async () => {
    const { physics, physicsColliderOwners } = physicsHarness(roadState({ colliderThicknessM: 0.4 }));
    await physics.ensurePhysicsWorld();
    const entries = roadEntries(physics.physicsWorld, physics.rapier, physicsColliderOwners);
    expect(entries).toHaveLength(2);
    expect(entries.every(entry => Math.abs(entry.halfExtents.y - 0.2) < 1e-6)).toBe(true);
    // 碰撞体中心 y = 路径点 y + 0.08 - 0.4/2 = -0.12；加代理落地偏移 -0.5 → -0.62。
    expect(entries.every(entry => Math.abs(entry.centerOffset.y + 0.62) < 1e-6)).toBe(true);
  });

  it("移除刚体时主句柄与附加句柄一并注销归属表，不留悬挂条目", async () => {
    const { physics, physicsBodies, physicsColliderOwners } = physicsHarness(roadState());
    await physics.ensurePhysicsWorld();
    expect(physicsBodies.has("road")).toBe(true);
    physics.removePhysicsBody("road");
    expect(physicsBodies.has("road")).toBe(false);
    expect([...physicsColliderOwners.values()].filter(owner => owner === "road")).toHaveLength(0);
    expect(roadEntries(physics.physicsWorld, physics.rapier, physicsColliderOwners)).toHaveLength(0);
  });
  it("非 fixed 道路刚体不走分段碰撞，维持整包围盒与质量语义", async () => {
    const { engine, physics, physicsBodies, physicsColliderOwners } = physicsHarness(roadState());
    Object.assign(engine, { physicsBodyStates: new Map([["road", { type: "dynamic", mass: 3, friction: 0.9, restitution: 0 } as ScenePhysicsBodyState]]) });
    await physics.ensurePhysicsWorld();
    // dynamic 道路是作者数据自相矛盾的形态：不静默当静态路面，回退单碰撞体路径并保留作者质量。
    const runtime = physicsBodies.get("road");
    expect(runtime).toBeDefined();
    expect(runtime!.body.numColliders()).toBe(1);
    expect([...physicsColliderOwners.values()].filter(owner => owner === "road")).toHaveLength(1);
  });
});

describe("非道路对象维持整包围盒回退", () => {
  it("普通原语仍是单碰撞体，道路无铺设路径时分段表为空", async () => {
    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine;
    const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    box.scale.set(2, 3, 4);
    box.updateWorldMatrix(true, true);
    const physicsColliderOwners = new Map<number, string | null>();
    Object.assign(engine, {
      models: new Map([["box", { id: "box", assetModelId: "box", name: "箱体", object: box,
        kind: "primitive" as const, visible: true, opacity: 1 }]]),
      modelPrefabStates: new Map(),
      physicsBodyStates: new Map([["box", fixedBody()]]),
      physicsBodies: new Map(),
      physicsColliderOwners,
      physicsJoints: new Map(),
      physicsState: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
      physicsHost: new PhysicsWorldHost(),
    });
    const physics = engine as unknown as { ensurePhysicsWorld(): Promise<void>; physicsWorld: RapierWorldType; rapier: RapierModule };
    await physics.ensurePhysicsWorld();
    const entries = collectPhysicsCuboidDebugEntries(physics.physicsWorld, physics.rapier, physicsColliderOwners)
      .filter(entry => entry.modelId === "box");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.halfExtents).toMatchObject({ x: 1, y: 1.5, z: 2 });
    // 道路缺铺设路径时分段表为空，物理链据此走整包围盒回退，不会产生零碰撞体刚体。
    const { placementPath: _removed, ...withoutPath } = roadState();
    expect(roadPrefabSegmentColliders(withoutPath)).toEqual([]);
  });
});
