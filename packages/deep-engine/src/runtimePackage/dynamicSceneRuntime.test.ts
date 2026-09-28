import { describe, expect, it } from "vitest";
import { validateDynamicSceneRuntime } from "./dynamicSceneRuntime.js";

const animation = { schema: "deep-engine.dynamic-animation", schemaVersion: 1, durationMs: 1000, tracks: [{ targetId: "node-a", property: "translation", keyframes: [{ timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] }, { timeMs: 1000, value: [1, 0, 0, 0, 0, 0, 1] }] }] };
const base = () => ({ schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "scene-dynamic", revision: 1, animation });

describe("dynamic scene runtime ABI", () => {
  it("accepts deterministic animation tracks", () => expect(validateDynamicSceneRuntime(base()).valid).toBe(true));
  it("accepts camera tracks and rejects non-boolean playback metadata", () => {
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, autoplay: true, loop: true, tracks: [{ ...animation.tracks[0], targetId: "scene.camera", property: "camera-position" }] } }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, autoplay: "yes" } }).valid).toBe(false);
  });
  it("accepts playback ranges inside the duration and rejects degenerate or out-of-range bounds", () => {
    // B2-b:区间可下译进包;校验层要求 0 <= inMs < outMs <= durationMs。
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: 200, outMs: 800 } } }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: 800, outMs: 800 } } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: 200, outMs: 1200 } } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: 0, outMs: 1000 } } }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: -1, outMs: 800 } } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, playbackRangeMs: { inMs: 0, outMs: 800, extra: 1 } } }).valid).toBe(false);
  });
  it("accepts strictly ordered offline replay revisions", () => { const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "telemetry", events: [{ revision: 1, timeMs: 0, payload: { value: 1 } }] } }).valid).toBe(true); });
  it("rejects unknown fields, unsorted keyframes and duplicate replay revisions", () => {
    expect(validateDynamicSceneRuntime({ ...base(), extra: true }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), animation: { ...animation, tracks: [{ ...animation.tracks[0], keyframes: [animation.tracks[0].keyframes[1], animation.tracks[0].keyframes[0]] }] } }).valid).toBe(false);
    const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, dataReplay: { schema: "deep-engine.dynamic-data-replay", schemaVersion: 1, channel: "x", events: [{ revision: 1, timeMs: 0, payload: null }, { revision: 1, timeMs: 1, payload: null }] } }).valid).toBe(false);
  });
  it("rejects unsafe interaction target shapes and empty channels", () => {
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "x", revision: 1 }).valid).toBe(false);
    const value = base(); delete (value as { animation?: unknown }).animation; expect(validateDynamicSceneRuntime({ ...value, interaction: { schema: "deep-engine.dynamic-interaction", schemaVersion: 1, trigger: "command", action: "clip", targetId: null } }).valid).toBe(false);
  });
  it("accepts the v2 clip controller while preserving strict v1 and reference checks", () => {
    const controller = {
      schema: "deep-engine.animation-controller", schemaVersion: 1,
      initialStateId: "robot:idle", activeStateId: "robot:idle", transitionDurationMs: 250,
      states: [
        { id: "robot:idle", modelId: "robot", clipId: "Idle", loop: true },
        { id: "robot:work", modelId: "robot", clipId: "Work Cycle", loop: true },
      ],
      parameters: { advance: false },
      transitions: [{ id: "idle-work", fromStateId: "robot:idle", toStateId: "robot:work", parameter: "advance", equals: true }],
    };
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: controller }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ ...base(), animationController: controller }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 4 }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: { ...controller, activeStateId: "missing" } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: { ...controller, transitions: [{ ...controller.transitions[0], parameter: "missing" }] } }).valid).toBe(false);
  });
  it("accepts kinematic bodies with character parameters and rejects unknown body types", () => {
    const physics = {
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "kinematic", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 1, friction: 0.5, restitution: 0,
        character: { offset: 0.02, autostep: { enabled: true, maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false }, snapToGround: { enabled: true, distance: 0.2 } },
        collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }], joints: [],
    };
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics }).valid).toBe(true);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], type: "unsupported" }] } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], type: "dynamic" }] } }).valid).toBe(false);
  });

  it("accepts deterministic v3 physics and fails closed on unsupported multibody features", () => {
    const physics = {
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "dynamic", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 2, friction: 0.5, restitution: 0.1,
        collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }],
      joints: [{ id: "joint-a", kind: "revolute", solver: "impulse", bodyId: "body-a", connectedBodyId: null,
        worldAnchor: [0, 0, 0], localAnchor: [0, 0, 0], axis: [0, 1, 0],
        limits: { enabled: true, min: -1, max: 1 }, motor: { enabled: true, targetVelocity: 2, strength: 4 } }],
    };
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics }).valid).toBe(true);
    const velocityBody = { ...physics.bodies[0], initialLinearVelocity: [80, 0, 0] };
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [velocityBody] } }).value?.physics?.bodies[0]?.initialLinearVelocity).toEqual([80, 0, 0]);
    for (const body of [{ ...velocityBody, initialLinearVelocity: [1_001, 0, 0] }, { ...velocityBody, type: "fixed" }]) {
      expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
        physics: { ...physics, bodies: [body] } }).valid).toBe(false);
    }
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 2, id: "scene", revision: 1, physics }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, joints: [{ ...physics.joints[0], solver: "multibody" }] } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1,
      physics: { ...physics, bodies: [{ ...physics.bodies[0], collider: { kind: "mesh", instanceIds: ["instance-a"] } }] } }).valid).toBe(false);
  });

  it("parses position servo motors and gear couplings, rejecting gains or references that fail closed", () => {
    const physics = {
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, 0, 0],
      bodies: [
        { id: "body-a", type: "dynamic", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 1, friction: 0.6, restitution: 0,
          collider: { kind: "render-bounds", instanceIds: ["instance-a"] } },
        { id: "body-b", type: "dynamic", initialPose: { translation: [0, 0, -0.04], rotation: [0, 0, 0, 1] }, mass: 0.6, friction: 0.6, restitution: 0,
          collider: { kind: "render-bounds", instanceIds: ["instance-b"] } },
      ],
      joints: [
        { id: "joint-a", kind: "revolute", solver: "impulse", bodyId: "body-a", connectedBodyId: null,
          worldAnchor: [0, 0, 0], localAnchor: [0, 0, 0], axis: [0, 0, 1],
          limits: { enabled: false, min: -1, max: 1 },
          motor: { enabled: true, targetVelocity: 4, strength: 10,
            position: { enabled: true, target: 1.5, stiffness: 40, damping: 12 } } },
        { id: "joint-b", kind: "revolute", solver: "impulse", bodyId: "body-b", connectedBodyId: null,
          worldAnchor: [0, 0, -0.04], localAnchor: [0, 0, 0], axis: [0, 0, 1],
          limits: { enabled: false, min: -1, max: 1 }, motor: { enabled: false, targetVelocity: 0, strength: 0 } },
      ],
      gears: [{ id: "gear-1", driverJointId: "joint-a", followerJointId: "joint-b", ratio: -2, stiffness: 40, damping: 20 }],
    };
    const envelope = { schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics };
    expect(validateDynamicSceneRuntime(envelope).valid).toBe(true);
    const parsed = validateDynamicSceneRuntime(envelope).value?.physics;
    expect(parsed?.joints[0]?.motor.position).toEqual({ enabled: true, target: 1.5, stiffness: 40, damping: 12 });
    expect(parsed?.gears).toEqual([{ id: "gear-1", driverJointId: "joint-a", followerJointId: "joint-b", ratio: -2, stiffness: 40, damping: 20 }]);
    // fail-closed 矩阵:伺服缺总开关 / multibody 伺服 / 零刚度 / 跨 kind 耦合 / 未排序 gear id / 未知字段。
    const rejects = [
      { ...physics, joints: [physics.joints[0], { ...physics.joints[1], motor: { enabled: false, targetVelocity: 0, strength: 0, position: { enabled: true, target: 1, stiffness: 40, damping: 12 } } }] },
      { ...physics, joints: [{ ...physics.joints[0], solver: "multibody" }, physics.joints[1]] },
      { ...physics, gears: [{ id: "gear-1", driverJointId: "joint-a", followerJointId: "joint-b", ratio: -2, stiffness: 0, damping: 20 }] },
      { ...physics, gears: [{ id: "gear-1", driverJointId: "joint-a", followerJointId: "joint-a", ratio: -2, stiffness: 40, damping: 20 }] },
      { ...physics, gears: [{ id: "gear-1", driverJointId: "joint-a", followerJointId: "joint-b", ratio: -2, stiffness: 40, damping: 20 }, { id: "gear-0", driverJointId: "joint-a", followerJointId: "joint-b", ratio: 2, stiffness: 40, damping: 20 }] },
    ];
    for (const broken of rejects) {
      expect(validateDynamicSceneRuntime({ ...envelope, physics: broken }).valid).toBe(false);
    }
    expect(validateDynamicSceneRuntime({ ...envelope, physics: { ...physics, extra: 1 } }).valid).toBe(false);
  });

  it("accepts hull, simplified-mesh and primitive colliders with precision marks and rejects incomplete payloads", () => {
    const physics = (collider: Record<string, unknown>) => ({
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "fixed", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] }, mass: 1, friction: 0.5, restitution: 0, collider }], joints: [],
    });
    const run = (collider: Record<string, unknown>) => validateDynamicSceneRuntime(
      { schema: "deep-engine.dynamic-runtime", schemaVersion: 3, id: "scene", revision: 1, physics: physics(collider) });
    const precision = { approximate: true, reasons: ["topology-error:NON_MANIFOLD_EDGE"], hullVertexCount: 4, topologyOk: false };
    const hull = { kind: "convex-hull", instanceIds: ["instance-a"], points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], precision };
    expect(run(hull).valid).toBe(true);
    expect(run({ ...hull, precision: { ...precision, concaveSource: true, triangleCount: 96 } }).valid).toBe(true);
    // generated kinds 缺 precision → 拒整包。
    const { precision: _omitted, ...withoutPrecision } = hull;
    expect(run(withoutPrecision).valid).toBe(false);
    // 凸包点数不足 / 非有限点 → 拒绝。
    expect(run({ ...hull, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }).valid).toBe(false);
    expect(run({ ...hull, points: [[0, 0, 0], [1, 0, 0], [0, Number.NaN, 0], [0, 0, 1]] }).valid).toBe(false);
    const mesh = { kind: "simplified-mesh", instanceIds: ["instance-a"],
      positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2],
      precision: { approximate: false, triangleCount: 1, tolerance: 0.005, topologyOk: true } };
    expect(run(mesh).valid).toBe(true);
    expect(run({ ...mesh, indices: [0, 1] }).valid).toBe(false);
    expect(run({ ...mesh, indices: [0, 1, 7] }).valid).toBe(false);
    expect(run({ ...mesh, precision: undefined }).valid).toBe(false);
    const primitive = { kind: "primitive", instanceIds: ["instance-a"], primitive: { shape: "sphere", radius: 0.5 } };
    expect(run(primitive).valid).toBe(true);
    expect(run({ kind: "primitive", instanceIds: ["instance-a"], primitive: { shape: "cuboid", halfExtents: [0.5, 0.25, 1] } }).valid).toBe(true);
    expect(run({ kind: "primitive", instanceIds: ["instance-a"], primitive: { shape: "cylinder", radius: 1, halfHeight: 0.5 } }).valid).toBe(true);
    expect(run({ ...primitive, primitive: { shape: "sphere" } }).valid).toBe(false);
    expect(run({ ...primitive, primitive: { shape: "sphere", radius: 0 } }).valid).toBe(false);
    expect(run({ ...primitive, primitive: { shape: "wedge" } }).valid).toBe(false);
    // 精度标记字段越界(非法拓扑码/超差公差)→ 拒绝。
    expect(run({ ...hull, precision: { ...precision, topologyIssueCodes: ["not-a-code"] } }).valid).toBe(false);
    expect(run({ ...hull, precision: { ...precision, tolerance: -1 } }).valid).toBe(false);
    // render-bounds 允许省略 precision(向后兼容),但拒绝携带几何字段。
    expect(run({ kind: "render-bounds", instanceIds: ["instance-a"] }).valid).toBe(true);
    expect(run({ kind: "render-bounds", instanceIds: ["instance-a"], points: [[0, 0, 0]] }).valid).toBe(false);
  });

  it("parses clip event markers and fails closed on duplicates, bad times or unknown fields", () => {
    // T14：事件标记可选；旧包（缺字段）语义不变；clip 时长不在包 ABI 内，
    // `0 <= time < duration` 由消费端时钟校验，解析层只做有界性与唯一性。
    const controller = {
      schema: "deep-engine.animation-controller", schemaVersion: 1,
      initialStateId: "robot:idle", activeStateId: "robot:idle", transitionDurationMs: 250,
      states: [{ id: "robot:idle", modelId: "robot", clipId: "Idle", loop: true }],
      parameters: {}, transitions: [],
      events: [{ clipId: "Idle", eventId: "footstep", time: 0.25 }],
    };
    const accepted = validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: controller });
    expect(accepted.valid).toBe(true);
    expect(accepted.value?.animationController?.events).toEqual([{ clipId: "Idle", eventId: "footstep", time: 0.25 }]);
    const withoutEvents = { ...controller }; delete (withoutEvents as { events?: unknown }).events;
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2, animationController: withoutEvents }).valid).toBe(true);
    const duplicate = validateDynamicSceneRuntime({ ...base(), schemaVersion: 2,
      animationController: { ...controller, events: [{ clipId: "Idle", eventId: "x", time: 0.1 }, { clipId: "Idle", eventId: "x", time: 0.2 }] } });
    expect(duplicate.valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2,
      animationController: { ...controller, events: [{ clipId: "Idle", eventId: "x", time: -0.1 }] } }).valid).toBe(false);
    expect(validateDynamicSceneRuntime({ ...base(), schemaVersion: 2,
      animationController: { ...controller, events: [{ clipId: "Idle", eventId: "x", time: 0.1, extra: 1 }] } }).valid).toBe(false);
  });

  it("accepts sdf-grid colliders on fixed bodies and fails closed on payload violations (F6)", () => {
    const sdf = { origin: [-0.125, -0.125, -0.125], cellSize: 0.25, dimensions: [2, 2, 2],
      distances: [-1, 1, 1, -1, 1, -1, -1, 1] };
    const physics = () => ({
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-sdf", type: "fixed", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        mass: 1, friction: 0.5, restitution: 0,
        collider: { kind: "sdf-grid", instanceIds: ["instance-a"], sdf,
          precision: { approximate: true, reasons: ["sdf-voxel-discretization"], tolerance: 0.217 } } }],
      joints: [],
    });
    const run = (physicsValue: unknown) => validateDynamicSceneRuntime({ ...base(), schemaVersion: 3, id: "scene", revision: 1, physics: physicsValue });
    expect(run(physics()).valid).toBe(true);
    // 非 fixed 刚体携带 sdf-grid → 拒。
    const dynamic = physics(); (dynamic.bodies[0] as { type: string }).type = "dynamic";
    expect(run(dynamic).valid).toBe(false);
    // generated kind 缺 precision → 拒。
    const noPrecision = physics(); delete (noPrecision.bodies[0]!.collider as { precision?: unknown }).precision;
    expect(run(noPrecision).valid).toBe(false);
    // distances 长度与网格不符 → 拒。
    expect(run({ ...physics(), bodies: [{ ...physics().bodies[0]!, collider: { ...physics().bodies[0]!.collider, sdf: { ...sdf, distances: sdf.distances.slice(1) } } }] }).valid).toBe(false);
    // 尺寸越界 → 拒。
    expect(run({ ...physics(), bodies: [{ ...physics().bodies[0]!, collider: { ...physics().bodies[0]!.collider, sdf: { ...sdf, dimensions: [1, 2, 2], distances: [-1, 1, 1, -1] } } }] }).valid).toBe(false);
    // 非有限距离 → 拒。
    expect(run({ ...physics(), bodies: [{ ...physics().bodies[0]!, collider: { ...physics().bodies[0]!.collider, sdf: { ...sdf, distances: [-1, 1, 1, -1, 1, -1, -1, Number.NaN] } } }] }).valid).toBe(false);
    // 未知字段 → 拒(strict fields)。
    expect(run({ ...physics(), bodies: [{ ...physics().bodies[0]!, collider: { ...physics().bodies[0]!.collider, extra: 1 } } ] }).valid).toBe(false);
  });

  it("accepts cloth and soft-body channels within budgets and fails closed on violations (F6)", () => {
    const physics = (softBodies: unknown) => ({
      schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true, playing: true, gravity: [0, -9.81, 0],
      bodies: [{ id: "body-a", type: "fixed", initialPose: { translation: [0, 0, 0], rotation: [0, 0, 0, 1] },
        mass: 1, friction: 0.5, restitution: 0, collider: { kind: "render-bounds", instanceIds: ["instance-a"] } }],
      joints: [], softBodies,
    });
    const run = (softBodies: unknown) => validateDynamicSceneRuntime({ ...base(), schemaVersion: 3, id: "scene", revision: 1, physics: physics(softBodies) });
    const cloth = { kind: "cloth", id: "flag-a", columns: 8, rows: 8, spacing: 0.05, mass: 0.02, compliance: 0, damping: 0.01,
      substeps: 4, perturbation: 0.001, seed: 7, origin: [0, 1, 0], pinned: [0, 7],
      wind: { direction: [0, 0, -1], baseSpeed: 2, gustFrequency: 0.7, spatialScale: 1.5, seed: 11 } };
    const softBody = { kind: "soft-body", id: "ball-a", mass: 0.2, damping: 0.02, substeps: 4, pinned: [],
      positions: [[0, 2, 0], [0.1, 2, 0], [0, 2.1, 0], [0, 2, 0.1], [0.05, 2.12, 0.05]],
      tets: [[0, 1, 2, 4], [0, 1, 3, 4], [0, 2, 3, 4], [1, 2, 3, 4]],
      complianceDistance: 0, complianceVolume: 0, groundY: 0 };
    expect(run([cloth]).valid).toBe(true);
    expect(run([softBody]).valid).toBe(true);
    // id 未排序 → 拒("flag-a" > "ball-a")。
    expect(run([cloth, softBody]).valid).toBe(false);
    // 粒子预算超限 → 拒。
    expect(run([{ ...cloth, id: "flag-big", columns: 64, rows: 300 }]).valid).toBe(false);
    // tet 索引越界 → 拒。
    expect(run([{ ...softBody, tets: [[0, 1, 2, 99]] }]).valid).toBe(false);
    // 非升序 pinned → 拒。
    expect(run([{ ...cloth, pinned: [7, 0] }]).valid).toBe(false);
    // 零风向 → 拒。
    expect(run([{ ...cloth, wind: { ...cloth.wind, direction: [0, 0, 0] } }]).valid).toBe(false);
    // substeps 越界 → 拒。
    expect(run([{ ...cloth, substeps: 32 }]).valid).toBe(false);
    // damping ≥ 1 → 拒。
    expect(run([{ ...softBody, damping: 1 }]).valid).toBe(false);
    // 未知字段 → 拒。
    expect(run([{ ...cloth, extra: 1 }]).valid).toBe(false);
  });
});
