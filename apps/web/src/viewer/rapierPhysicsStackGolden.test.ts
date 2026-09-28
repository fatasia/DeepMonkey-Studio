import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PhysicsWorldHost } from "./physicsWorldHost";

/**
 * 三箱堆叠黄金案例(Web 侧)。参数与 Native
 * `packages/deep-engine-native/src/native_physics_golden_tests.rs` 的 stack 案例逐项对齐;
 * 改任何参数必须两侧同步,否则跨端配对数据作废。
 *
 * 0.2 m 立方、1 kg、摩擦 0.6、恢复系数 0、重力 -9.81 m/s²、1/60 s 固定步长、
 * 顶层箱 +X 0.15 m/s 初速,步进 180 步(3 s)。断言:堆叠静止(末 30 步位移/旋转阈值)、
 * 落点符合几何预期,且同输入重复运行逐位一致(确定性)。
 */
const STACK = {
  halfExtents: 0.1,
  mass: 1,
  friction: 0.6,
  restitution: 0,
  gravity: { x: 0, y: -9.81, z: 0 },
  fixedStep: 1 / 60,
  steps: 180,
  stabilityWindowStart: 150,
  topBoxInitialVelocity: { x: 0.15, y: 0, z: 0 },
  /** 末 30 步最大允许位移(米)与旋转(弧度)。阈值来自本测试首次实测裕量。 */
  driftMeters: 5e-3,
  driftRadians: 0.05,
} as const;

type Quat = [number, number, number, number];
interface Pose { p: [number, number, number]; q: Quat; }

const quatAngle = (a: Quat, b: Quat): number =>
  2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));

async function runStack(options: { solverIterations?: number } = {}) {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ ...STACK.gravity });
  if (options.solverIterations !== undefined) {
    world.integrationParameters.numSolverIterations = options.solverIterations;
  }
  // 地面 cuboid half=(2,0.1,2),中心 y=-0.1 → 顶面 y=0,首箱(中心 0.1)恰好接触不重叠。
  const ground = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
  world.createCollider(
    rapier.ColliderDesc.cuboid(2, 0.1, 2).setFriction(STACK.friction).setRestitution(STACK.restitution),
    ground,
  );
  const bodies = [0.1, 0.3, 0.5].map((y, index) => {
    const body = world.createRigidBody(
      rapier.RigidBodyDesc.dynamic().setTranslation(0, y, 0).setCcdEnabled(true),
    );
    world.createCollider(
      rapier.ColliderDesc.cuboid(STACK.halfExtents, STACK.halfExtents, STACK.halfExtents)
        .setMass(STACK.mass).setFriction(STACK.friction).setRestitution(STACK.restitution),
      body,
    );
    if (index === 2) body.setLinvel({ ...STACK.topBoxInitialVelocity }, true);
    return body;
  });
  const host = new PhysicsWorldHost();
  host.attach({
    setGravity: (gravity) => { world.gravity = { ...gravity }; },
    step: (timestep) => { world.timestep = timestep; world.step(); },
    dispose: () => world.free(),
  });
  host.configure({ enabled: true, playing: true, gravity: { ...STACK.gravity } });

  const snapshot = (): Pose[] => bodies.map((body) => {
    const t = body.translation(), r = body.rotation();
    return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
  });
  const poses: Pose[][] = [];
  for (let step = 0; step < STACK.steps; step += 1) {
    expect(host.advance(STACK.fixedStep).steps, `step ${step + 1}`).toBe(1);
    poses.push(snapshot());
  }
  const angularVelocities = bodies.map((body) => body.angvel());
  host.dispose();
  return { poses, angularVelocities };
}

describe("Rapier Web three-box stack golden", () => {
  it("settles a shoved stack within drift thresholds and repeats bit-exactly", async () => {
    const first = await runStack();
    const repeat = await runStack();
    expect(repeat.poses).toEqual(first.poses);

    const near = first.poses[STACK.stabilityWindowStart - 1];
    const end = first.poses[STACK.steps - 1];
    if (!near || !end) throw new Error("golden snapshots missing");
    end.forEach((pose, index) => {
      const previous = near[index];
      if (!previous) throw new Error("near snapshot missing");
      const drift = Math.hypot(pose.p[0] - previous.p[0], pose.p[1] - previous.p[1], pose.p[2] - previous.p[2]);
      const rotation = quatAngle(pose.q, previous.q);
      expect(drift, `box ${index + 1} drift over the last 30 steps`).toBeLessThan(STACK.driftMeters);
      expect(rotation, `box ${index + 1} rotation over the last 30 steps`).toBeLessThan(STACK.driftRadians);
    });

    const restingY = end.map((pose) => pose.p[1]);
    expect(restingY[0]).toBeGreaterThan(0.09);
    expect(restingY[0]).toBeLessThan(0.11);
    expect(restingY[1]).toBeGreaterThan(0.28);
    expect(restingY[1]).toBeLessThan(0.32);
    expect(restingY[2]).toBeGreaterThan(0.46);
    expect(restingY[2]).toBeLessThan(0.54);
    const topBox = end[2];
    if (!topBox) throw new Error("top box snapshot missing");
    expect(Math.abs(topBox.p[0]), "top box shove must not topple the stack off the pad").toBeLessThan(0.5);
    end.forEach((pose, index) => {
      expect(pose.p[1], `box ${index + 1} must stay on the ground`).toBeGreaterThan(0.09);
    });
    first.angularVelocities.forEach((velocity, index) => {
      const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
      expect(speed, `box ${index + 1} angular speed`).toBeLessThan(0.1);
    });
  });

  it("records per-step poses for the Web↔Native tolerance pairing (solver iterations aligned at 8)", async () => {
    const run = await runStack({ solverIterations: 8 });
    const payload = {
      meta: {
        end: "web",
        rapier: "0.19.3",
        scenario: "stack-3boxes",
        halfExtents: STACK.halfExtents,
        mass: STACK.mass,
        friction: STACK.friction,
        restitution: STACK.restitution,
        gravity: [STACK.gravity.x, STACK.gravity.y, STACK.gravity.z],
        fixedStepSeconds: STACK.fixedStep,
        steps: STACK.steps,
        solverIterations: 8,
        ccd: true,
        damping: { linear: 0, angular: 0 },
        topBoxInitialVelocity: [STACK.topBoxInitialVelocity.x, STACK.topBoxInitialVelocity.y, STACK.topBoxInitialVelocity.z],
        boxes: ["stack-box-1", "stack-box-2", "stack-box-3"],
      },
      poses: run.poses,
    };
    const outputDirectory = resolve(__dirname, "../../../../test-output/t17-cross-tolerance");
    mkdirSync(outputDirectory, { recursive: true });
    const file = resolve(outputDirectory, "web-stack-poses.json");
    writeFileSync(file, JSON.stringify(payload));
    expect(run.poses).toHaveLength(STACK.steps);
  });
});
