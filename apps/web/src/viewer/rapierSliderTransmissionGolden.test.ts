import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenePhysicsJointState } from "@bim-studio/contracts";
import type Rapier from "@dimforge/rapier3d-compat";
import type { RigidBody, World } from "@dimforge/rapier3d-compat";
import { PhysicsWorldHost } from "./physicsWorldHost";
import { mountRapierJoint } from "./rapierPhysicsJoint";

/**
 * 滑块导轨与传动比黄金案例(Web 侧)。参数与 Native
 * `packages/deep-engine-native/src/native_physics_mechanism_golden_tests.rs` 的 slider/transmission 案例逐项对齐;
 * 改任何参数必须两侧同步,否则跨端结论不可比。
 *
 * 滑块导轨:prismatic 关节(x 轴,限位 ±0.08 m)+ 速度马达 +0.4 m/s。
 * 合同只有恒速马达,孤立导轨的语义是"冲程-钳制"(与铰链限位黄金先例同构):
 * 断言行程序、方向、导轨直线度(不漂移)与限位钳制;自发往复由曲柄驱动活塞
 * (rapierPistonCrankGolden)覆盖。无限位对照组证明钳制来自限位而非马达力度不足。
 *
 * 传动比:合同无齿轮啮合约束。(a) 用现有合同能表达的最强耦合——两轴间 1:1 revolute
 * 同轴刚性连接,断言角速度比恒为 1;(b) 传动比 2:1 用两个旋转关节的马达目标按
 * 传动比耦合表达(外啮合反向),断言实测角速度比恒定——这是驱动目标耦合而非
 * 几何啮合,如实说明。
 */
const SLIDER = {
  limit: 0.08,
  motorTargetVelocity: 0.4,
  motorStrength: 10,
  friction: 0.6,
  restitution: 0,
  fixedStep: 1 / 60,
  steps: 240,
  /** 到达上钳制的行程窗口:0.08/0.4 = 0.2 s = 12 步,容差 ±4 步。 */
  travelSteps: 12,
  travelToleranceSteps: 4,
  /** 终态钳制区间与全程上界(米)。 */
  finalMin: 0.075,
  finalMax: 0.085,
  overshootTolerance: 0.005,
  /** 导轨直线度:y/z 全程最大漂移(米)与姿态偏角(弧度)。 */
  guideDriftMeters: 1e-3,
  tiltRadians: 0.01,
} as const;

const TRANSMISSION = {
  couplingTargetVelocity: 2,
  // 马达目标 +2/-4:Native Rapier 0.35 的睡眠判据按"最远点速度"与 0.05 m/s 阈值比较,
  // +1 rad/s 的低速轮会被判静止而睡眠(Web 0.19 旧判据不睡);2 rad/s 起留 2 倍裕量。
  ratioDrivenVelocity: 2,
  ratioDrivenPartnerVelocity: -4,
  motorStrength: 10,
  fixedStep: 1 / 60,
  steps: 240,
  /** 稳态窗口起点(步):马达启动瞬态之后。 */
  steadyWindowStart: 120,
  /** 1:1 刚性耦合:全程转角差上限(弧度)与末窗角速度比区间。 */
  rigidAngleTolerance: 0.02,
  rigidRatioBand: 0.01,
  /** 2:1 目标耦合:末窗实测角速度比相对目标的容差(相对)。 */
  targetRatioRelativeTolerance: 0.03,
} as const;

type Vec3 = { x: number; y: number; z: number };
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** 机构/轮对互不碰撞(membership=1, filter=0)。实测:0.02 m 间隙的同轴轮对在默认
 * 碰撞设置下仍产生耦合接触力(两马达被拽成同速),过滤后马达各自精确达标。 */
const NO_CONTACT_GROUPS = 0x0001_0000;

const jointState = (
  id: string,
  kind: "revolute" | "prismatic",
  bodyId: string,
  worldAnchor: Vec3,
  localAnchor: Vec3,
  axis: Vec3,
  options: { connectedBodyId?: string; limits?: { min: number; max: number }; motor?: { targetVelocity: number; strength: number } } = {},
): ScenePhysicsJointState => ({
  id, kind, bodyId,
  ...(options.connectedBodyId ? { connectedBodyId: options.connectedBodyId } : {}),
  worldAnchor, localAnchor, axis,
  limits: options.limits
    ? { enabled: true, min: options.limits.min, max: options.limits.max }
    : { enabled: false, min: -1, max: 1 },
  motor: { enabled: Boolean(options.motor), targetVelocity: options.motor?.targetVelocity ?? 0, strength: options.motor?.strength ?? 0 },
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
      .setFriction(SLIDER.friction).setRestitution(SLIDER.restitution).setCollisionGroups(NO_CONTACT_GROUPS)
      .setTranslation(colliderOffset.x, colliderOffset.y, colliderOffset.z),
    body,
  );
  return body;
}

function advance(harness: Harness, steps: number): void {
  for (let step = 0; step < steps; step += 1) {
    expect(harness.host.advance(SLIDER.fixedStep).steps, `step ${step + 1}`).toBe(1);
  }
}

function readBody(body: RigidBody): { p: [number, number, number]; q: [number, number, number, number] } {
  const t = body.translation(), r = body.rotation();
  return { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
}

async function runSlider(limitsEnabled: boolean, solverIterations?: number) {
  const harness = await buildWorld(solverIterations);
  const slider = addBody(harness, v(0, 0, 0), v(0.03, 0.02, 0.02), 0.5);
  mountRapierJoint(harness.rapier, harness.world, harness.fixed, slider,
    jointState("j1-slider-world", "prismatic", "body-slider", v(0, 0, 0), v(0, 0, 0), v(1, 0, 0), {
      ...(limitsEnabled ? { limits: { min: -SLIDER.limit, max: SLIDER.limit } } : {}),
      motor: { targetVelocity: SLIDER.motorTargetVelocity, strength: SLIDER.motorStrength },
    }));
  const poses: Array<ReturnType<typeof readBody>> = [];
  for (let step = 0; step < SLIDER.steps; step += 1) {
    expect(harness.host.advance(SLIDER.fixedStep).steps, `step ${step + 1}`).toBe(1);
    poses.push(readBody(slider));
  }
  harness.host.dispose();
  return poses;
}

describe("Rapier Web slider-rail golden", () => {
  it("clamps the motor-driven slider at the authored travel and keeps the rail drift-free, bit-exactly", async () => {
    const first = await runSlider(true);
    const repeat = await runSlider(true);
    expect(repeat).toEqual(first);

    const xs = first.map((pose) => pose.p[0]);
    const arrival = xs.findIndex((value) => value > SLIDER.limit - 5e-3);
    console.log(`MECH[slider] arrival step logged below`);
    expect(arrival, `first arrival at step ${arrival}`).toBeGreaterThanOrEqual(0);
    expect(arrival, `first arrival at step ${arrival}`).toBeLessThanOrEqual(SLIDER.travelSteps + SLIDER.travelToleranceSteps);
    const final = xs[xs.length - 1]!;
    expect(final, `final x ${final.toFixed(4)}`).toBeGreaterThanOrEqual(SLIDER.finalMin);
    expect(final, `final x ${final.toFixed(4)}`).toBeLessThanOrEqual(SLIDER.finalMax);
    expect(Math.max(...xs), `peak x ${Math.max(...xs).toFixed(4)}`).toBeLessThanOrEqual(SLIDER.limit + SLIDER.overshootTolerance);

    // 导轨不漂移:全程 y/z 漂移与姿态偏角。
    const drift = Math.max(
      ...first.map((pose) => Math.max(Math.abs(pose.p[1]!), Math.abs(pose.p[2]!))),
    );
    console.log(`MECH[slider] arrival=${arrival} final=${final.toFixed(4)} peakX=${Math.max(...xs).toFixed(4)} lateralDrift=${drift.toExponential(2)}m`);
    expect(drift, `rail lateral drift ${drift.toExponential(2)} m`).toBeLessThan(SLIDER.guideDriftMeters);
    const identity: [number, number, number, number] = [0, 0, 0, 1];
    first.forEach((pose, index) => {
      const dot = Math.abs(pose.q[0] * identity[0] + pose.q[1] * identity[1] + pose.q[2] * identity[2] + pose.q[3] * identity[3]);
      const tilt = 2 * Math.acos(Math.min(1, dot));
      expect(tilt, `slider tilt at step ${index}`).toBeLessThan(SLIDER.tiltRadians);
    });

    const control = await runSlider(false);
    const controlFinal = control[control.length - 1]!.p[0];
    expect(controlFinal, `unlimited control final x ${controlFinal.toFixed(4)}`).toBeGreaterThan(SLIDER.limit + 0.02);
  });

  it("records per-step slider poses for the Web↔Native tolerance pairing (solver iterations aligned at 8)", async () => {
    const poses = await runSlider(true, 8);
    const payload = {
      meta: {
        end: "web", rapier: "0.19.3", scenario: "slider-rail",
        limit: SLIDER.limit, motorTargetVelocity: SLIDER.motorTargetVelocity,
        motorStrength: SLIDER.motorStrength,
        gravity: [0, 0, 0], fixedStepSeconds: SLIDER.fixedStep, steps: SLIDER.steps,
        solverIterations: 8, damping: { linear: 0, angular: 0 },
        bodies: ["body-slider"],
      },
      positions: poses.map((pose) => pose.p),
    };
    const directory = resolve(__dirname, "../../../../test-output/t17-mechanism");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "web-slider-poses.json"), JSON.stringify(payload));
    expect(poses).toHaveLength(SLIDER.steps);
  });
});

/** 把 atan2/quat 反解出的主值角接续成单调连续角,越过 ±π 不回卷。 */
function unwrap(previous: number | undefined, raw: number): number {
  if (previous === undefined) return raw;
  let value = raw;
  while (value - previous > Math.PI) value -= 2 * Math.PI;
  while (previous - value > Math.PI) value += 2 * Math.PI;
  return value;
}

const shaftHalf = v(0.05, 0.05, 0.01);

describe("Rapier Web transmission ratio golden", () => {
  it("keeps a 1:1 rigid shaft coupling locked (angle difference and velocity ratio), bit-exactly", async () => {
    const runCoupled = async () => {
      const harness = await buildWorld();
      const shaftA = addBody(harness, v(0, 0, 0), shaftHalf, 0.6, v(0, 0, 0.045));
      const shaftB = addBody(harness, v(0, 0, -0.04), shaftHalf, 0.6, v(0, 0, -0.045));
      mountRapierJoint(harness.rapier, harness.world, harness.fixed, shaftA,
        jointState("j1-shaft-a-world", "revolute", "body-shaft-a", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
          { motor: { targetVelocity: TRANSMISSION.couplingTargetVelocity, strength: TRANSMISSION.motorStrength } }));
      // 1:1 同轴刚性联轴器:revolute 限位 [0,0] 锁死相对转动(普通 revolute 是铰链,允许相对转,首轮实测角差 8 rad)。
      mountRapierJoint(harness.rapier, harness.world, shaftA, shaftB,
        jointState("j2-shaft-b-a", "revolute", "body-shaft-b", v(0, 0, 0), v(0, 0, 0.04), v(0, 0, 1),
          { connectedBodyId: "body-shaft-a", limits: { min: 0, max: 0 } }));
      const angles: Record<"a" | "b", number[]> = { a: [], b: [] };
      for (let step = 0; step < TRANSMISSION.steps; step += 1) {
        expect(harness.host.advance(SLIDER.fixedStep).steps, `step ${step + 1}`).toBe(1);
        const qa = shaftA.rotation(), qb = shaftB.rotation();
        angles.a.push(unwrap(angles.a[angles.a.length - 1], 2 * Math.atan2(qa.z, qa.w)));
        angles.b.push(unwrap(angles.b[angles.b.length - 1], 2 * Math.atan2(qb.z, qb.w)));
      }
      harness.host.dispose();
      return angles;
    };

    const first = await runCoupled();
    const repeat = await runCoupled();
    expect(repeat).toEqual(first);

    let worst = 0;
    first.a.forEach((value, index) => {
      worst = Math.max(worst, Math.abs(value - first.b[index]!));
    });
    console.log(`MECH[coupling1to1] worstAngleDiff=${worst.toFixed(5)}rad`);
    expect(worst, `worst coupling angle difference ${worst.toFixed(5)} rad`).toBeLessThan(TRANSMISSION.rigidAngleTolerance);
    const window = TRANSMISSION.steps - TRANSMISSION.steadyWindowStart;
    const last = TRANSMISSION.steps - 1;
    const dt = window * SLIDER.fixedStep;
    const rateA = (first.a[last]! - first.a[TRANSMISSION.steadyWindowStart]!) / dt;
    const rateB = (first.b[last]! - first.b[TRANSMISSION.steadyWindowStart]!) / dt;
    const ratio = rateB / rateA;
    console.log(`MECH[coupling1to1] steadyRatio=${ratio.toFixed(5)}`);
    expect(ratio, `coupled ratio ${ratio.toFixed(4)}`).toBeGreaterThanOrEqual(1 - TRANSMISSION.rigidRatioBand);
    expect(ratio, `coupled ratio ${ratio.toFixed(4)}`).toBeLessThanOrEqual(1 + TRANSMISSION.rigidRatioBand);
  });

  it("holds a constant 2:1 transmission ratio from ratio-coupled motor targets (no gear constraint in contract)", async () => {
    const runRatio = async () => {
      const harness = await buildWorld();
      const gearA = addBody(harness, v(0, 0, 0), shaftHalf, 0.6, v(0, 0, 0.045));
      const gearB = addBody(harness, v(0, 0, -0.04), shaftHalf, 0.6, v(0, 0, -0.045));
      mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearA,
        jointState("j1-gear-a-world", "revolute", "body-gear-a", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
          { motor: { targetVelocity: TRANSMISSION.ratioDrivenVelocity, strength: TRANSMISSION.motorStrength } }));
      mountRapierJoint(harness.rapier, harness.world, harness.fixed, gearB,
        jointState("j2-gear-b-world", "revolute", "body-gear-b", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
          { motor: { targetVelocity: TRANSMISSION.ratioDrivenPartnerVelocity, strength: TRANSMISSION.motorStrength } }));
      const velocities: Array<[number, number]> = [];
      for (let step = 0; step < TRANSMISSION.steps; step += 1) {
        expect(harness.host.advance(SLIDER.fixedStep).steps, `step ${step + 1}`).toBe(1);
        velocities.push([gearA.angvel().z, gearB.angvel().z]);
      }
      harness.host.dispose();
      return velocities;
    };

    const first = await runRatio();
    const repeat = await runRatio();
    expect(repeat).toEqual(first);

    const window = first.slice(TRANSMISSION.steadyWindowStart);
    const meanA = window.reduce((sum, pair) => sum + pair[0]!, 0) / window.length;
    const meanB = window.reduce((sum, pair) => sum + pair[1]!, 0) / window.length;
    const ratio = meanB / meanA;
    const target = TRANSMISSION.ratioDrivenPartnerVelocity / TRANSMISSION.ratioDrivenVelocity;
    console.log(`MECH[gear2to1] meanA=${meanA.toFixed(4)} meanB=${meanB.toFixed(4)} ratio=${ratio.toFixed(4)} (target ${target})`);
    expect(Math.abs(ratio - target), `measured ratio ${ratio.toFixed(4)} vs target ${target}`)
      .toBeLessThanOrEqual(Math.abs(target) * TRANSMISSION.targetRatioRelativeTolerance);
    // 比恒定:窗口内单步比值的极差受限。
    const sampleRatios = window.slice(0, 40).map((pair) => pair[1]! / pair[0]!);
    const spread = Math.max(...sampleRatios) - Math.min(...sampleRatios);
    expect(spread, `ratio spread ${spread.toFixed(4)}`).toBeLessThan(0.05);
  });
});
