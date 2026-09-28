import { describe, expect, it } from "vitest";
import type { SceneSnapshot, SceneClothState, ScenePhysicsBodyState,
  SceneSoftBodyState, SceneTetraSoftBodyState } from "@bim-studio/contracts";
import { validateDynamicSceneRuntime, type DynamicPhysicsRuntime } from "@bim-studio/deep-engine/runtime-package";
// F6 生产会话与指纹口径:预算常量/双跑指纹与引擎侧同源,不复制口径。
import { createSoftBodyRuntimeSession, fingerprintFloat64, SOFT_BODY_BUDGETS } from "@bim-studio/deep-engine/physics";
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

  it("lowers position servo motors and gear couplings, and the payload re-validates as a runtime package", () => {
    const bindings = [{ nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] }];
    const scene = fixture();
    scene.physics!.joints = [{
      id: "joint-a", kind: "revolute", bodyId: "body-a", connectedBodyId: "body-b",
      worldAnchor: { x: 0, y: 0, z: 0 }, localAnchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
      limits: { enabled: false, min: -1, max: 1 },
      motor: { enabled: true, targetVelocity: 0, strength: 0,
        position: { enabled: true, target: 1.5, stiffness: 40, damping: 12 } },
    }];
    scene.physics!.gears = [{
      id: "gear-b", driverJointId: "joint-a", followerJointId: "joint-c", ratio: -2, stiffness: 40, damping: 20,
    }, {
      id: "gear-a", driverJointId: "joint-a", followerJointId: "joint-c", ratio: 2, stiffness: 40, damping: 20,
    }];
    scene.physics!.joints.push({
      id: "joint-c", kind: "revolute", bodyId: "body-b", connectedBodyId: undefined as never,
      worldAnchor: { x: 0, y: 0, z: 0 }, localAnchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
      limits: { enabled: false, min: -1, max: 1 }, motor: { enabled: false, targetVelocity: 0, strength: 0 },
    });
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })!;
    expect(runtime.joints[0]!.motor.position).toMatchObject({ enabled: true, target: 1.5, stiffness: 40, damping: 12 });
    // 齿轮按 id 排序下译;同关节/跨 kind 的非法耦合 fail-closed。
    expect(runtime.gears).toEqual([
      { id: "gear-a", driverJointId: "joint-a", followerJointId: "joint-c", ratio: 2, stiffness: 40, damping: 20 },
      { id: "gear-b", driverJointId: "joint-a", followerJointId: "joint-c", ratio: -2, stiffness: 40, damping: 20 },
    ]);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics: runtime }).valid).toBe(true);
    // 负例:ratio 为零 / 同关节互连,一律 fail-closed。
    scene.physics!.gears = [{ id: "gear-x", driverJointId: "joint-a", followerJointId: "joint-c", ratio: 0, stiffness: 40, damping: 20 }];
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/无效或不匹配/);
    scene.physics!.gears = [{ id: "gear-x", driverJointId: "joint-a", followerJointId: "joint-a", ratio: 2, stiffness: 40, damping: 20 }];
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/无效或不匹配/);
    delete (scene.physics as { gears?: unknown }).gears;
    scene.physics!.joints = [scene.physics!.joints[0]!];
    scene.physics!.joints[0]!.motor = { enabled: false, targetVelocity: 0, strength: 0,
      position: { enabled: true, target: 1.5, stiffness: 40, damping: 12 } };
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: bindings })).toThrow(/位置伺服参数无效/);
  });
});

/** F6 遗留切片:作者软体/布料 → 运行包 softBodies 通道译层测试。
 * 整链口径:作者场景 → compileScenePhysicsRuntime → validateDynamicSceneRuntime
 * (运行包解析层)→ createSoftBodyRuntimeSession(F6 生产会话);确定性以
 * 同输入双跑指纹逐位一致为准(与 deep-engine/physics 家族口径一致)。
 * 作者世界系坐标选二进制精确值(0.0625/0.125 = 2^-n),使局部化减法逐位无损,
 * 期望值可与作者意图逐字段严格相等。 */
describe("F6 软体/布料译层(scene → softBodies 通道)", () => {
  const SOFT_ORIGIN = { x: 100, y: 10, z: 0 };
  const SOFT_BINDINGS = [{ nodeId: "body-a", instanceIds: ["instance-a"] }, { nodeId: "body-b", instanceIds: ["instance-b"] }];

  function clothFlagAuthor(): SceneClothState {
    return {
      kind: "cloth", id: "flag-a", columns: 12, rows: 12, spacing: 0.05, mass: 0.02,
      compliance: 0, damping: 0.01, substeps: 4, perturbation: 0.001, seed: 7,
      origin: { x: 100, y: 12, z: 0 }, pinned: [0, 11],
      wind: { direction: { x: 0, y: 0, z: -1 }, baseSpeed: 2.5, gustFrequency: 0.7, spatialScale: 1.5, seed: 11 },
    };
  }

  function softBallAuthor(): SceneTetraSoftBodyState {
    return {
      kind: "soft-body", id: "ball-a", mass: 0.2, damping: 0.02, substeps: 4, pinned: [],
      positions: [
        { x: 100, y: 12, z: 0 }, { x: 100.125, y: 12, z: 0 }, { x: 100, y: 12.125, z: 0 },
        { x: 100, y: 12, z: 0.125 }, { x: 100.0625, y: 12.125, z: 0.0625 },
      ],
      tets: [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]],
      complianceDistance: 0, complianceVolume: 0, groundY: 10,
    };
  }

  function softBodyScene(): SceneSnapshot {
    const scene = fixture();
    scene.physics!.softBodies = [clothFlagAuthor(), softBallAuthor()];
    return scene;
  }

  /** 译层 → 运行包解析层二道校验;非法载荷在这里(而不是会话层)先死。 */
  function compileSoftBodyPhysics(scene: SceneSnapshot = softBodyScene()): DynamicPhysicsRuntime {
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })!;
    const parsed = validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene.dynamic", revision: 1, physics: runtime });
    if (!parsed.valid) throw new Error(`运行包解析失败:${parsed.issues.map(issue => `${issue.path}: ${issue.message}`).join("; ")}`);
    return runtime;
  }

  it("逐字段下译布料旗与软球:世界系局部化(origin/positions/groundY)、风场、锚点、id 排序;解析层通过", () => {
    const runtime = compileScenePhysicsRuntime(softBodyScene(), { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })!;
    // 作者序 [flag-a, ball-a] → 输出按 id 字典序 [ball-a, flag-a](运行包合同要求)。
    // origin {100,12,0} → [0,2,0]、positions x−100/y−10、groundY 10 → 0:三个世界系
    // 字段族全部随坐标原点局部化。
    expect(runtime.softBodies).toEqual([
      { kind: "soft-body", id: "ball-a", mass: 0.2, damping: 0.02, substeps: 4, pinned: [],
        positions: [[0, 2, 0], [0.125, 2, 0], [0, 2.125, 0], [0, 2, 0.125], [0.0625, 2.125, 0.0625]],
        tets: [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]],
        complianceDistance: 0, complianceVolume: 0, groundY: 0 },
      { kind: "cloth", id: "flag-a", columns: 12, rows: 12, spacing: 0.05, mass: 0.02, compliance: 0,
        damping: 0.01, substeps: 4, perturbation: 0.001, seed: 7, origin: [0, 2, 0], pinned: [0, 11],
        wind: { direction: [0, 0, -1], baseSpeed: 2.5, gustFrequency: 0.7, spatialScale: 1.5, seed: 11 } },
    ]);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene.dynamic", revision: 1, physics: runtime }).valid).toBe(true);
  });

  it("默认关闭:legacy 场景(无字段或空数组)输出不含 softBodies 键,零行为变化", () => {
    const bindings = SOFT_BINDINGS;
    expect(Object.hasOwn(compileScenePhysicsRuntime(fixture(), { coordinateOrigin: SOFT_ORIGIN, objectBindings: bindings })!, "softBodies")).toBe(false);
    const scene = fixture();
    scene.physics!.softBodies = [];
    expect(Object.hasOwn(compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: bindings })!, "softBodies")).toBe(false);
  });

  it("端到端:布料旗 作者场景→译层→运行包→生产会话,240 tick 双跑指纹逐位一致", () => {
    const run = (): { fingerprint: string; positions: Float64Array } => {
      const session = createSoftBodyRuntimeSession(compileSoftBodyPhysics());
      for (let tick = 0; tick < 240; tick += 1) session.step();
      const positions = session.readout("flag-a")!;
      return { fingerprint: fingerprintFloat64(positions), positions };
    };
    const first = run();
    expect(run().fingerprint).toBe(first.fingerprint);
    expect(first.positions.length).toBe(12 * 12 * 3);
    // 双锚在局部化坐标(原点 x=100/y=10 消去)保持初始位:首锚 (0,2,z₀),尾锚 x=0.55。
    expect(first.positions[0]).toBe(0);
    expect(first.positions[1]).toBe(2);
    expect(Math.abs(first.positions[2]!)).toBeLessThanOrEqual(0.001);
    expect(first.positions[33]).toBeCloseTo(0.55, 5);
    // 风致 z 向展开(确定性行为),不发散。
    const zValues = Array.from(first.positions.filter((_, index) => index % 3 === 2));
    const spread = Math.max(...zValues) - Math.min(...zValues);
    expect(spread).toBeGreaterThan(0.01);
    expect(Number.isFinite(spread)).toBe(true);
  });

  it("端到端:软球落地 作者场景→译层→运行包→生产会话,groundY 局部化接触不穿透、体积守恒 ≤5%、双跑逐位", () => {
    const run = (): string => {
      const session = createSoftBodyRuntimeSession(compileSoftBodyPhysics());
      for (let tick = 0; tick < 180; tick += 1) session.step();
      return fingerprintFloat64(session.readout("ball-a")!);
    };
    const first = run();
    expect(run()).toBe(first);
    const session = createSoftBodyRuntimeSession(compileSoftBodyPhysics());
    for (let tick = 0; tick < 180; tick += 1) session.step();
    const positions = session.readout("ball-a")!;
    // 最低粒子被 groundY(作者世界 10 → 包局部 0)托住,不穿透。
    const minY = Math.min(...Array.from(positions.filter((_, index) => index % 3 === 1)));
    expect(minY).toBeGreaterThanOrEqual(-1e-9);
    expect(minY).toBeLessThan(0.2);
    const volume = session.volumeError("ball-a");
    expect(volume).toBeDefined();
    expect(volume!.totalRatio).toBeLessThanOrEqual(0.05);
    expect(session.volumeError("flag-a")).toBeUndefined();
  });

  it("fail-closed:预算护栏超限拒绝整包并给原因(实测/上限,常量与引擎会话同源)", () => {
    const compileThrows = (scene: SceneSnapshot, pattern: RegExp) =>
      expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })).toThrow(pattern);
    // 1) 软体数量 > 16
    const many = softBodyScene();
    many.physics!.softBodies = Array.from({ length: SOFT_BODY_BUDGETS.maxBodies + 1 }, (_, index) =>
      ({ ...clothFlagAuthor(), id: `flag-${String(index).padStart(2, "0")}` }));
    compileThrows(many, /软体数量 17 超出预算 16/);
    // 2) 单体贴算 > 16384
    const fat = softBodyScene();
    fat.physics!.softBodies = [{ ...clothFlagAuthor(), columns: 200, rows: 200 }];
    compileThrows(fat, /粒子数 40000 超出单体贴算 16384/);
    // 3) 四面体 > 32768
    const manyTets = softBodyScene();
    manyTets.physics!.softBodies = [{ ...softBallAuthor(),
      tets: Array.from({ length: SOFT_BODY_BUDGETS.maxTetsPerBody + 1 }, () => [0, 1, 2, 3] as [number, number, number, number]) }];
    compileThrows(manyTets, /四面体数 32769 超出预算 32768/);
    // 4) 总粒子 > 65536(单体恰在 16384 预算内,总量超限)
    const fatTotal = softBodyScene();
    fatTotal.physics!.softBodies = Array.from({ length: 5 }, (_, index) =>
      ({ ...clothFlagAuthor(), id: `flag-${index}`, columns: 128, rows: 128 }));
    compileThrows(fatTotal, /粒子总量 81920 超出预算 65536/);
    // 5) substeps > 16
    const fast = softBodyScene();
    fast.physics!.softBodies = [{ ...clothFlagAuthor(), substeps: SOFT_BODY_BUDGETS.maxSubsteps + 1 }];
    compileThrows(fast, /substeps 必须是 1\.\.16 的整数,实测 17/);
  });

  it("fail-closed:非法作者字段逐类拒绝并给原因", () => {
    // fixture 固定 [布料旗, 软球] 布局,回调按位取类型;误配字段由运行期护栏兜底。
    const mutateThrows = (mutate: (softBodies: [SceneClothState, SceneTetraSoftBodyState]) => void, pattern: RegExp) => {
      const scene = softBodyScene();
      mutate(scene.physics!.softBodies as [SceneClothState, SceneTetraSoftBodyState]);
      expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })).toThrow(pattern);
    };
    mutateThrows(softBodies => { softBodies[0]!.mass = 0; }, /质量必须是正有限数/);
    mutateThrows(softBodies => { softBodies[1]!.damping = 1; }, /damping 必须在 \[0,1\)/);
    mutateThrows(softBodies => { softBodies[0]!.substeps = 0; }, /substeps 必须是 1\.\.16 的整数,实测 0/);
    mutateThrows(softBodies => { softBodies[0]!.compliance = Number.NaN; }, /compliance 必须是非负有限数/);
    mutateThrows(softBodies => { softBodies[0]!.seed = 2 ** 31; }, /seed 必须是 int32 整数/);
    mutateThrows(softBodies => { softBodies[0]!.spacing = 0; }, /spacing 必须在 \(0, 1e6\] 米/);
    mutateThrows(softBodies => { softBodies[0]!.columns = 1; }, /columns 必须是 2\.\.4096/);
    mutateThrows(softBodies => { softBodies[0]!.pinned = [11, 0]; }, /锚点索引必须严格升序且唯一/);
    mutateThrows(softBodies => { softBodies[0]!.pinned = [144]; }, /锚点索引 144 越界/);
    mutateThrows(softBodies => { softBodies[0]!.pinned = [0, 0]; }, /严格升序且唯一/);
    mutateThrows(softBodies => { softBodies[0]!.wind!.direction = { x: 0, y: 0, z: 0 }; }, /风场方向必须是非零有限向量/);
    mutateThrows(softBodies => { softBodies[0]!.wind!.gustFrequency = 0; }, /gustFrequency 必须为正数/);
    mutateThrows(softBodies => { softBodies[1]!.positions = softBodies[1]!.positions.slice(0, 3); }, /至少需要 4 个顶点/);
    mutateThrows(softBodies => { softBodies[1]!.tets = [[0, 0, 1, 2]]; }, /互异顶点索引/);
    mutateThrows(softBodies => { softBodies[1]!.tets = [[0, 1, 2, 9]]; }, /互异顶点索引/);
    mutateThrows(softBodies => { softBodies[1]!.complianceDistance = -1; }, /complianceDistance 必须是非负有限数/);
    mutateThrows(softBodies => { softBodies[1]!.groundY = Number.NaN; }, /groundY 必须是有限数值/);
    mutateThrows(softBodies => { softBodies[0]!.origin = { x: Number.NaN, y: 12, z: 0 }; }, /flag-a\.origin/);
    mutateThrows(softBodies => { softBodies[1]!.id = "flag-a"; }, /软体 id 必须唯一/);
  });

  it("fail-closed:未知 kind 拒绝;软体通道无刚体并存时拒整包", () => {
    const unknown = softBodyScene();
    (unknown.physics!.softBodies as unknown[])[0] = { kind: "rope", id: "rope-a" };
    expect(() => compileScenePhysicsRuntime(unknown, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })).toThrow(/类型不受运行包支持/);
    const alone = softBodyScene();
    alone.models = [];
    expect(() => compileScenePhysicsRuntime(alone, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS }))
      .toThrow(/软体通道要求与至少一个可编译刚体并存/);
    const bare = fixture();
    bare.models = [];
    expect(() => compileScenePhysicsRuntime(bare, { coordinateOrigin: { x: 0, y: 0, z: 0 }, objectBindings: [] }))
      .toThrow(/已启用物理场景但没有可编译的刚体$/);
  });

  it("sdf-grid collider 同族下译:合法载荷过解析层;域外值 fail-closed", () => {
    const scene = softBodyScene();
    const distances = Array.from({ length: 64 }, () => 1);
    distances[21] = -1;
    const sdfGrid = { origin: { x: 0, y: 0, z: 0 }, cellSize: 0.05, dimensions: { x: 4, y: 4, z: 4 }, distances };
    scene.models[0]!.physics!.collider = {
      kind: "sdf-grid",
      precision: { approximate: true, reasons: ["sdf-discretization"], tolerance: 0.044 },
      sdfGrid,
    };
    const runtime = compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })!;
    // 几何位于刚体局部系,不随发布坐标原点平移(与 convex-hull/simplified-mesh 同口径)。
    // bodies 按 id 排序,bodies[1] = body-b(承载 sdf-grid 的刚体)。
    expect(runtime.bodies[1]!.collider).toMatchObject({
      kind: "sdf-grid",
      sdf: { origin: [0, 0, 0], cellSize: 0.05, dimensions: [4, 4, 4], distances },
    });
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene.dynamic", revision: 1, physics: runtime }).valid).toBe(true);
    // 非 fixed 刚体携带 sdf-grid → 译层先死并给作者侧原因。
    scene.models[0]!.physics!.type = "dynamic";
    expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })).toThrow(/要求 fixed 刚体/);
    scene.models[0]!.physics!.type = "fixed";
    const throws = (collider: NonNullable<ScenePhysicsBodyState["collider"]>, pattern: RegExp) => {
      scene.models[0]!.physics!.collider = collider;
      expect(() => compileScenePhysicsRuntime(scene, { coordinateOrigin: SOFT_ORIGIN, objectBindings: SOFT_BINDINGS })).toThrow(pattern);
    };
    throws({ kind: "sdf-grid", sdfGrid }, /缺少精度标记/);
    throws({ kind: "sdf-grid", precision: { approximate: true } }, /缺少体素场载荷/);
    throws({ kind: "sdf-grid", precision: { approximate: true }, sdfGrid: { ...sdfGrid, dimensions: { x: 1, y: 4, z: 4 } } }, /每维 2\.\.128/);
    throws({ kind: "sdf-grid", precision: { approximate: true }, sdfGrid: { ...sdfGrid, distances: distances.slice(0, 63) } }, /必须填满 64/);
    throws({ kind: "sdf-grid", precision: { approximate: true }, sdfGrid: { ...sdfGrid, cellSize: 0 } }, /cellSize 必须在 \(0, 1e6\] 米/);
    throws({ kind: "sdf-grid", precision: { approximate: true }, sdfGrid: { ...sdfGrid, origin: { x: Number.NaN, y: 0, z: 0 } } }, /origin 必须为有限数值/);
  });
});
