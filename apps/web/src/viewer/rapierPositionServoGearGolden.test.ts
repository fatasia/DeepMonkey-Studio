import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenePhysicsJointState } from "@bim-studio/contracts";
import type Rapier from "@dimforge/rapier3d-compat";
import type { PrismaticImpulseJoint, RevoluteImpulseJoint, RigidBody, World } from "@dimforge/rapier3d-compat";
import { PhysicsWorldHost } from "./physicsWorldHost";
import { mountRapierGearCoupling, mountRapierJoint } from "./rapierPhysicsJoint";

/**
 * T17 位置马达与齿轮耦合黄金案例(Web 侧)。参数与 Native
 * `packages/deep-engine-native/src/native_physics_motor_gear_tests.rs` 逐项对齐;
 * 改任何参数必须两侧同步,否则跨端配对数据作废。
 *
 * 位置马达:configureMotorPosition(target, stiffness, damping) 阶跃伺服,断言
 * 目标角/位 ± 容差收敛、越冲上界与双跑逐位确定性(revolute rad / prismatic m)。
 *
 * 齿轮耦合:两端 Rapier 均无原生齿轮约束,以从动侧位置马达伺服跟随实现
 * (宿主每步求解前读主动坐标并写从动目标,含速度前馈抵消 PD 斜坡滞后)。
 * 断言主动/从动累计转角比 == 设定比;外啮合反向用负 ratio 表达。
 */
const SERVO = {
  revoluteTarget: 1.5,
  prismaticTarget: 0.05,
  stiffness: 40,
  damping: 12,
  friction: 0.6,
  restitution: 0,
  fixedStep: 1 / 60,
  steps: 240,
  /** 末窗步数:阶跃收敛后取均值。 */
  settleWindow: 30,
  /** revolute 收敛带(弧度)与越冲上界;prismatic 收敛带(米)。 */
  revoluteBand: 0.01,
  prismaticBand: 0.005,
  overshoot: 0.15,
  lateralDrift: 1e-3,
} as const;

const GEAR = {
  driverVelocity: 4,
  motorStrength: 10,
  ratio: -2,
  stiffness: 40,
  // Native Rapier 0.35 的加速度基马达离散化响应弱于 Web 0.19:damping=8 时 Native
  // 齿条从动欠阻尼振荡亏 8.5%;双端同步提到 ζ≈1.6(20)后两端均进 ±2% 带。
  damping: 20,
  rackRatio: 2,
  fixedStep: 1 / 60,
  steps: 240,
  /** 稳态窗口起点(步):启动瞬态之后。 */
  steadyStart: 120,
  /** 窗口增量比相对容差(传动比断言)与绝对残差漂移上界(弧度/米)。 */
  ratioRelativeTolerance: 0.02,
  residualDrift: 0.1,
} as const;

type Vec3 = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** 机构/轮对互不碰撞(membership=1, filter=0)——耦合体间接触会把伺服拽离目标。 */
const NO_CONTACT_GROUPS = 0x0001_0000;

const jointState = (
  id: string,
  kind: "revolute" | "prismatic",
  bodyId: string,
  worldAnchor: Vec3,
  localAnchor: Vec3,
  axis: Vec3,
  options: {
    connectedBodyId?: string;
    motor?: { targetVelocity: number; strength: number; position?: { enabled: boolean; target: number; stiffness: number; damping: number } };
  } = {},
): ScenePhysicsJointState => ({
  id, kind, bodyId,
  ...(options.connectedBodyId ? { connectedBodyId: options.connectedBodyId } : {}),
  worldAnchor, localAnchor, axis,
  limits: { enabled: false, min: -1, max: 1 },
  motor: {
    enabled: Boolean(options.motor),
    targetVelocity: options.motor?.targetVelocity ?? 0,
    strength: options.motor?.strength ?? 0,
    ...(options.motor?.position ? { position: { ...options.motor.position } } : {}),
  },
});

interface Harness {
  rapier: typeof Rapier;
  world: World;
  fixed: RigidBody;
  host: PhysicsWorldHost;
}

async function buildWorld(solverIterations?: number): Promise<Harness> {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  if (solverIterations !== undefined) world.integrationParameters.numSolverIterations = solverIterations;
  const fixed = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const host = new PhysicsWorldHost();
  host.attach({
    setGravity: (gravity) => { world.gravity = { ...gravity }; },
    step: (timestep) => { world.timestep = timestep; world.step(); },
    dispose: () => world.free(),
  });
  host.configure({ enabled: true, playing: true, gravity: { x: 0, y: 0, z: 0 } });
  return { rapier, world, fixed, host };
}

function addBody(harness: Harness, position: Vec3, half: Vec3, mass: number, colliderOffset: Vec3 = v(0, 0, 0)): RigidBody {
  const body = harness.world.createRigidBody(
    harness.rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCcdEnabled(true),
  );
  harness.world.createCollider(
    harness.rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass)
      .setFriction(SERVO.friction).setRestitution(SERVO.restitution).setCollisionGroups(NO_CONTACT_GROUPS)
      .setTranslation(colliderOffset.x, colliderOffset.y, colliderOffset.z),
    body,
  );
  return body;
}

function readBody(body: RigidBody): { p: [number, number, number]; q: [number, number, number, number] } {
  const t = body.translation(), r = body.rotation();
  return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
}

/** 把 atan2/quat 反解出的主值角接续成单调连续角,越过 ±π 不回卷(与 Native unwrap_angle 同构)。 */
function unwrap(previous: number | undefined, raw: number): number {
  if (previous === undefined) return raw;
  let value = raw;
  while (value - previous > Math.PI) value -= 2 * Math.PI;
  while (previous - value > Math.PI) value += 2 * Math.PI;
  return value;
}

const shaftHalf = v(0.05, 0.05, 0.01);

describe("Rapier Web position-servo golden", () => {
  it("drives a revolute arm to the authored target angle within band, bit-exactly", async () => {
    const run = async () => {
      const harness = await buildWorld();
      const arm = addBody(harness, v(0, 0, 0), v(0.25, 0.02, 0.02), 1);
      mountRapierJoint(harness.rapier, harness.world, harness.fixed, arm,
        jointState("j1-arm-world", "revolute", "body-arm", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1), {
          motor: { targetVelocity: 0, strength: 0,
            position: { enabled: true, target: SERVO.revoluteTarget, stiffness: SERVO.stiffness, damping: SERVO.damping } },
        }));
      const poses: Array<ReturnType<typeof readBody>> = [];
      for (let step = 0; step < SERVO.steps; step += 1) {
        expect(harness.host.advance(SERVO.fixedStep).steps, `step ${step + 1}`).toBe(1);
        poses.push(readBody(arm));
      }
      harness.host.dispose();
      return poses;
    };

    const first = await run();
    const repeat = await run();
    expect(repeat).toEqual(first);

    const angles = first.map((pose) => unwrap(undefined, 2 * Math.atan2(pose.q[2], pose.q[3])));
    const window = angles.slice(SERVO.steps - SERVO.settleWindow);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    const peak = Math.max(...angles);
    console.log(`SERVO[revolute] mean=${mean.toFixed(5)} target=${SERVO.revoluteTarget} peak=${peak.toFixed(5)}`);
    expect(mean, `settled angle ${mean.toFixed(5)} rad`).toBeGreaterThanOrEqual(SERVO.revoluteTarget - SERVO.revoluteBand);
    expect(mean, `settled angle ${mean.toFixed(5)} rad`).toBeLessThanOrEqual(SERVO.revoluteTarget + SERVO.revoluteBand);
    expect(peak, `overshoot peak ${peak.toFixed(5)} rad`).toBeLessThanOrEqual(SERVO.revoluteTarget + SERVO.overshoot);
  });

  it("drives a prismatic slider to the authored target position within band and drift-free, bit-exactly", async () => {
    const run = async () => {
      const harness = await buildWorld();
      const slider = addBody(harness, v(0, 0, 0), v(0.03, 0.02, 0.02), 0.5);
      mountRapierJoint(harness.rapier, harness.world, harness.fixed, slider,
        jointState("j1-slider-world", "prismatic", "body-slider", v(0, 0, 0), v(0, 0, 0), v(1, 0, 0), {
          motor: { targetVelocity: 0, strength: 0,
            position: { enabled: true, target: SERVO.prismaticTarget, stiffness: SERVO.stiffness, damping: SERVO.damping } },
        }));
      const poses: Array<ReturnType<typeof readBody>> = [];
      for (let step = 0; step < SERVO.steps; step += 1) {
        expect(harness.host.advance(SERVO.fixedStep).steps, `step ${step + 1}`).toBe(1);
        poses.push(readBody(slider));
      }
      harness.host.dispose();
      return poses;
    };

    const first = await run();
    const repeat = await run();
    expect(repeat).toEqual(first);

    const xs = first.map((pose) => pose.p[0]);
    const window = xs.slice(SERVO.steps - SERVO.settleWindow);
    const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
    console.log(`SERVO[prismatic] mean=${mean.toFixed(5)} target=${SERVO.prismaticTarget}`);
    expect(mean, `settled position ${mean.toFixed(5)} m`).toBeGreaterThanOrEqual(SERVO.prismaticTarget - SERVO.prismaticBand);
    expect(mean, `settled position ${mean.toFixed(5)} m`).toBeLessThanOrEqual(SERVO.prismaticTarget + SERVO.prismaticBand);
    const drift = Math.max(...first.map((pose) => Math.max(Math.abs(pose.p[1]!), Math.abs(pose.p[2]!))));
    expect(drift, `lateral drift ${drift.toExponential(2)} m`).toBeLessThan(SERVO.lateralDrift);
  });

  it("records per-step servo-arm poses for the Web↔Native tolerance pairing (solver iterations aligned at 8)", async () => {
    const harness = await buildWorld(8);
    const arm = addBody(harness, v(0, 0, 0), v(0.25, 0.02, 0.02), 1);
    mountRapierJoint(harness.rapier, harness.world, harness.fixed, arm,
      jointState("j1-arm-world", "revolute", "body-arm", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1), {
        motor: { targetVelocity: 0, strength: 0,
          position: { enabled: true, target: SERVO.revoluteTarget, stiffness: SERVO.stiffness, damping: SERVO.damping } },
      }));
    const positions: Array<[number, number, number]> = [];
    // 旋转体质心不动,跨端配对的主量是关节角;unwrap 连续化后逐角度对比。
    const angles: number[] = [];
    for (let step = 0; step < SERVO.steps; step += 1) {
      expect(harness.host.advance(SERVO.fixedStep).steps, `step ${step + 1}`).toBe(1);
      const pose = readBody(arm);
      positions.push(pose.p);
      angles.push(unwrap(angles[angles.length - 1], 2 * Math.atan2(pose.q[2], pose.q[3])));
    }
    harness.host.dispose();
    const payload = {
      meta: {
        end: "web", rapier: "0.19.3", scenario: "position-servo-revolute",
        target: SERVO.revoluteTarget, stiffness: SERVO.stiffness, damping: SERVO.damping,
        gravity: [0, 0, 0], fixedStepSeconds: SERVO.fixedStep, steps: SERVO.steps,
        solverIterations: 8, bodies: ["body-arm"],
      },
      positions,
      angles,
    };
    const directory = resolve(__dirname, "../../../../test-output/t17-motor-gear");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "web-servo-poses.json"), JSON.stringify(payload));
    expect(positions).toHaveLength(SERVO.steps);
  });
});

describe("Rapier Web gear-coupling golden", () => {
  it("holds the authored −2:1 transmission ratio on the follower angle (position servo + velocity feedforward), bit-exactly", async () => {
    const run = async () => {
      const harness = await buildWorld();
      const gearA = addBody(harness, v(0, 0, 0), shaftHalf, 0.6, v(0, 0, 0.045));
      const gearB = addBody(harness, v(0, 0, -0.04), shaftHalf, 0.6, v(0, 0, -0.045));
      const driverState = jointState("j1-gear-a-world", "revolute", "body-gear-a", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
        { motor: { targetVelocity: GEAR.driverVelocity, strength: GEAR.motorStrength } });
      const followerState = jointState("j2-gear-b-world", "revolute", "body-gear-b", v(0, 0, -0.04), v(0, 0, 0), v(0, 0, 1), {});
      const driverJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearA, driverState);
      const followerJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearB, followerState);
      expect(driverJoint.solver).toBe("impulse");
      expect(followerJoint.solver).toBe("impulse");
      const coupling = mountRapierGearCoupling(harness.rapier,
        { kind: driverState.kind, axis: driverState.axis, body: gearA, joint: driverJoint.joint as RevoluteImpulseJoint },
        { kind: followerState.kind, axis: followerState.axis, body: gearB, joint: followerJoint.joint as RevoluteImpulseJoint },
        { ratio: GEAR.ratio, stiffness: GEAR.stiffness, damping: GEAR.damping },
      );
      const angles: Record<"a" | "b", number[]> = { a: [], b: [] };
      for (let step = 0; step < GEAR.steps; step += 1) {
        coupling.update();
        expect(harness.host.advance(GEAR.fixedStep).steps, `step ${step + 1}`).toBe(1);
        const qa = gearA.rotation(), qb = gearB.rotation();
        angles.a.push(unwrap(angles.a[angles.a.length - 1], 2 * Math.atan2(qa.z, qa.w)));
        angles.b.push(unwrap(angles.b[angles.b.length - 1], 2 * Math.atan2(qb.z, qb.w)));
      }
      harness.host.dispose();
      return angles;
    };

    const first = await run();
    const repeat = await run();
    expect(repeat).toEqual(first);

    const windowStart = GEAR.steadyStart, last = GEAR.steps - 1;
    const deltaA = first.a[last]! - first.a[windowStart]!;
    const deltaB = first.b[last]! - first.b[windowStart]!;
    const ratio = deltaB / deltaA;
    // 绝对口径:窗口内从动增量对 ratio×主动增量的残差(前馈后伺服残余滞后)。
    const residual = Math.abs(deltaB - GEAR.ratio * deltaA);
    console.log(`GEAR[2to1] deltaA=${deltaA.toFixed(3)} deltaB=${deltaB.toFixed(3)} ratio=${ratio.toFixed(4)} (target ${GEAR.ratio})`);
    expect(ratio, `window transmission ratio ${ratio.toFixed(4)}`)
      .toBeGreaterThanOrEqual(GEAR.ratio - Math.abs(GEAR.ratio) * GEAR.ratioRelativeTolerance);
    expect(ratio, `window transmission ratio ${ratio.toFixed(4)}`)
      .toBeLessThanOrEqual(GEAR.ratio + Math.abs(GEAR.ratio) * GEAR.ratioRelativeTolerance);
    expect(residual, `absolute residual ${residual.toFixed(4)} rad`).toBeLessThanOrEqual(GEAR.residualDrift);
  });

  it("gears a prismatic rack pair at the authored 2:1 travel ratio, bit-exactly", async () => {
    const run = async () => {
      const harness = await buildWorld();
      const railA = addBody(harness, v(0, 0.06, 0), v(0.04, 0.01, 0.02), 0.5);
      const railB = addBody(harness, v(0, -0.06, 0), v(0.04, 0.01, 0.02), 0.5);
      const driverState = jointState("j1-rack-a-world", "prismatic", "body-rack-a", v(0, 0.06, 0), v(0, 0, 0), v(1, 0, 0),
        { motor: { targetVelocity: 0.5, strength: 10 } });
      const followerState = jointState("j2-rack-b-world", "prismatic", "body-rack-b", v(0, -0.06, 0), v(0, 0, 0), v(1, 0, 0), {});
      const driverJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, railA, driverState);
      const followerJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, railB, followerState);
      const coupling = mountRapierGearCoupling(harness.rapier,
        { kind: driverState.kind, axis: driverState.axis, body: railA, joint: driverJoint.joint as PrismaticImpulseJoint },
        { kind: followerState.kind, axis: followerState.axis, body: railB, joint: followerJoint.joint as PrismaticImpulseJoint },
        { ratio: GEAR.rackRatio, stiffness: GEAR.stiffness, damping: GEAR.damping },
      );
      const travel: Record<"a" | "b", number[]> = { a: [], b: [] };
      for (let step = 0; step < GEAR.steps; step += 1) {
        coupling.update();
        expect(harness.host.advance(GEAR.fixedStep).steps, `step ${step + 1}`).toBe(1);
        travel.a.push(railA.translation().x);
        travel.b.push(railB.translation().x);
      }
      harness.host.dispose();
      return travel;
    };

    const first = await run();
    const repeat = await run();
    expect(repeat).toEqual(first);

    const windowStart = GEAR.steadyStart, last = GEAR.steps - 1;
    const deltaA = first.a[last]! - first.a[windowStart]!;
    const deltaB = first.b[last]! - first.b[windowStart]!;
    const ratio = deltaB / deltaA;
    console.log(`GEAR[rack2to1] deltaA=${deltaA.toFixed(4)} deltaB=${deltaB.toFixed(4)} ratio=${ratio.toFixed(4)} (target ${GEAR.rackRatio})`);
    expect(ratio, `rack travel ratio ${ratio.toFixed(4)}`)
      .toBeGreaterThanOrEqual(GEAR.rackRatio - GEAR.rackRatio * GEAR.ratioRelativeTolerance);
    expect(ratio, `rack travel ratio ${ratio.toFixed(4)}`)
      .toBeLessThanOrEqual(GEAR.rackRatio + GEAR.rackRatio * GEAR.ratioRelativeTolerance);
  });

  it("records per-step gear angles for the Web↔Native tolerance pairing (solver iterations aligned at 8)", async () => {
    const harness = await buildWorld(8);
    const gearA = addBody(harness, v(0, 0, 0), shaftHalf, 0.6, v(0, 0, 0.045));
    const gearB = addBody(harness, v(0, 0, -0.04), shaftHalf, 0.6, v(0, 0, -0.045));
    const driverState = jointState("j1-gear-a-world", "revolute", "body-gear-a", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
      { motor: { targetVelocity: GEAR.driverVelocity, strength: GEAR.motorStrength } });
    const followerState = jointState("j2-gear-b-world", "revolute", "body-gear-b", v(0, 0, -0.04), v(0, 0, 0), v(0, 0, 1), {});
    const driverJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearA, driverState);
    const followerJoint = mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearB, followerState);
    const coupling = mountRapierGearCoupling(harness.rapier,
      { kind: driverState.kind, axis: driverState.axis, body: gearA, joint: driverJoint.joint as RevoluteImpulseJoint },
      { kind: followerState.kind, axis: followerState.axis, body: gearB, joint: followerJoint.joint as RevoluteImpulseJoint },
      { ratio: GEAR.ratio, stiffness: GEAR.stiffness, damping: GEAR.damping },
    );
    const positions: Array<[number, number, number]> = [];
    for (let step = 0; step < GEAR.steps; step += 1) {
      coupling.update();
      expect(harness.host.advance(GEAR.fixedStep).steps, `step ${step + 1}`).toBe(1);
      positions.push(readBody(gearB).p);
    }
    harness.host.dispose();
    const payload = {
      meta: {
        end: "web", rapier: "0.19.3", scenario: "gear-coupling-2to1",
        driverVelocity: GEAR.driverVelocity, ratio: GEAR.ratio, stiffness: GEAR.stiffness, damping: GEAR.damping,
        gravity: [0, 0, 0], fixedStepSeconds: GEAR.fixedStep, steps: GEAR.steps,
        solverIterations: 8, bodies: ["body-gear-b"],
      },
      positions,
    };
    const directory = resolve(__dirname, "../../../../test-output/t17-motor-gear");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "web-gear-poses.json"), JSON.stringify(payload));
    expect(positions).toHaveLength(GEAR.steps);
  });
});
