import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScenePhysicsJointState } from "@bim-studio/contracts";
import { PhysicsWorldHost } from "./physicsWorldHost";
import { mountRapierJoint } from "./rapierPhysicsJoint";

/**
 * 活塞-曲柄(曲柄滑块)与组合机构黄金案例(Web 侧)。参数与 Native
 * `packages/deep-engine-native/src/native_physics_golden_tests.rs` 的 mechanism 案例逐项对齐;
 * 改任何参数必须两侧同步,否则跨端配对数据作废。
 *
 * 零重力隔离机构运动学;1/60 s 固定步长;曲柄马达 targetVelocity=+π rad/s(每转 2 s = 120 步)。
 * 解析行程:x(θ)=r·cosθ+√(L²−r²sin²θ),r=0.05、L=0.15 → x∈[0.10,0.20],行程 2r=0.1 m。
 * 断言:行程、活塞导轨直线度、稳态周期(步数计)、往复对称性;组合机构另断言
 * 1:1 轴耦合传动比与端到端解析对照;双端同输入重复运行逐位一致(确定性)。
 */
const PISTON = {
  crankRadius: 0.05,
  rodLength: 0.15,
  motorTargetVelocity: Math.PI,
  motorStrength: 20,
  friction: 0.6,
  restitution: 0,
  fixedStep: 1 / 60,
  steps: 360,
  /** 稳态窗口起点(第 2 转起)。周期/对称性/角速度在窗口内测量。 */
  steadyWindowStart: 120,
  /** 行程容差(米):实测首次裕量后冻结;解析值 0.1。 */
  strokeTolerance: 5e-3,
  /** 活塞导轨直线度:y/z 全程最大漂移(米)。 */
  guideDriftMeters: 2e-3,
  /** 稳态周期步数与容差:理论 2π/ω·60 = 120 步。 */
  periodSteps: 120,
  periodToleranceSteps: 6,
  /** 往复对称:稳态段升程/降程步数差。 */
  strokeAsymmetrySteps: 4,
  /** 曲柄平均角速度容差(相对)。 */
  crankRateRelativeTolerance: 0.02,
} as const;

const COMBO = {
  ...PISTON,
  /** 端到端解析对照最大偏差(米):实测曲柄角代入解析式,与活塞实测 x 比较。 */
  analyticToleranceMeters: 8e-3,
  /** 1:1 轴耦合传动比容差(相对)。 */
  couplingRatioRelativeTolerance: 0.02,
} as const;

type Vec3 = { x: number; y: number; z: number };
type Quat = [number, number, number, number];

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

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** 机构杆件互不碰撞(membership=1, filter=0):相邻杆在关节销处体积重叠,
 * 保留杆间接触会在零重力下把机构内部炸开(首轮实测活塞行程 0.33 m)。 */
const NO_CONTACT_GROUPS = 0x0001_0000;

/** 把 atan2/quat 反解出的主值角接续成单调连续角,越过 ±π 不回卷。 */
function unwrap(previous: number | undefined, raw: number): number {
  if (previous === undefined) return raw;
  let value = raw;
  while (value - previous > Math.PI) value -= 2 * Math.PI;
  while (previous - value > Math.PI) value += 2 * Math.PI;
  return value;
}

/** 绕 z 的连续转角(弧度)。 */
const zAngle = (q: Quat): number => 2 * Math.atan2(q[2], q[3]);

interface Snapshot { p: [number, number, number]; q: Quat }
type Pose = Record<string, Snapshot>;

const CrankSliderJoints = {
  crankWorld: (motor: boolean) => jointState("j1-crank-world", "revolute", "body-crank", v(0, 0, 0), v(-0.025, 0, 0), v(0, 0, 1),
    motor ? { motor: { targetVelocity: PISTON.motorTargetVelocity, strength: PISTON.motorStrength } } : {}),
  crankRod: (crankId: string) => jointState("j2-crank-rod", "revolute", "body-rod", v(0.05, 0, 0), v(-0.075, 0, 0), v(0, 0, 1),
    { connectedBodyId: crankId }),
  rodPiston: jointState("j3-rod-piston", "revolute", "body-piston", v(0.2, 0, 0), v(0, 0, 0), v(0, 0, 1),
    { connectedBodyId: "body-rod" }),
  pistonWorld: jointState("j4-piston-world", "prismatic", "body-piston", v(0.2, 0, 0), v(0, 0, 0), v(1, 0, 0)),
} as const;

async function runPistonCrank(options: { solverIterations?: number } = {}) {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  if (options.solverIterations !== undefined) {
    world.integrationParameters.numSolverIterations = options.solverIterations;
  }
  const fixed = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const buildBody = (position: Vec3, half: Vec3, mass: number, colliderOffset: Vec3) => {
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCcdEnabled(true));
    world.createCollider(
      rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass).setFriction(PISTON.friction)
        .setRestitution(PISTON.restitution).setCollisionGroups(NO_CONTACT_GROUPS)
        .setTranslation(colliderOffset.x, colliderOffset.y, colliderOffset.z),
      body,
    );
    return body;
  };
  // 几何:曲柄销 r=0.05(锚点原点→销),连杆 L=0.15,活塞初始在 x=r+L=0.2(外死点)。
  // collider 沿 z 错层(±0.03,与 z 轴旋转正交,分离永久成立):相邻杆件在关节销处体积重叠,
  // 保留杆间接触会把机构内部炸开。collider 尺寸/偏移与 Native 端 packet 几何逐项一致。
  const crank = buildBody(v(0.025, 0, 0), v(0.025, 0.01, 0.01), 0.5, v(0, 0, 0.03));
  const rod = buildBody(v(0.125, 0, 0), v(0.075, 0.01, 0.01), 0.2, v(0, 0, -0.03));
  const piston = buildBody(v(0.2, 0, 0), v(0.02, 0.02, 0.02), 0.5, v(0, 0, 0.03));
  mountRapierJoint(rapier, world, fixed, crank, CrankSliderJoints.crankWorld(true));
  mountRapierJoint(rapier, world, crank, rod, CrankSliderJoints.crankRod("body-crank"));
  mountRapierJoint(rapier, world, rod, piston, CrankSliderJoints.rodPiston);
  mountRapierJoint(rapier, world, fixed, piston, CrankSliderJoints.pistonWorld);
  const bodies: Record<string, ReturnType<typeof buildBody>> = { "body-piston": piston, crank, rod };
  const host = new PhysicsWorldHost();
  host.attach({
    setGravity: (gravity) => { world.gravity = { ...gravity }; },
    step: (timestep) => { world.timestep = timestep; world.step(); },
    dispose: () => world.free(),
  });
  host.configure({ enabled: true, playing: true, gravity: { x: 0, y: 0, z: 0 } });
  const snapshot = (): Pose => Object.fromEntries(Object.entries(bodies).map(([id, body]) => {
    const t = body.translation(), r = body.rotation();
    return [id, { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] }];
  }));
  const poses: Pose[] = [];
  for (let step = 0; step < PISTON.steps; step += 1) {
    expect(host.advance(PISTON.fixedStep).steps, `step ${step + 1}`).toBe(1);
    poses.push(snapshot());
  }
  host.dispose();
  return { poses };
}

/** 稳态段活塞 x 的中线穿越事件(工程口径,比逐点局部极大更抗求解抖动):
 * up = 由下而上越过中线,down = 由上而下越过中线。返回 [up 索引, down 索引]。 */
function midlineCrossings(samples: number[], start: number): { up: number[]; down: number[] } {
  const window = samples.slice(start);
  const mid = (Math.max(...window) + Math.min(...window)) / 2;
  const up: number[] = [], down: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    if (window[i - 1]! < mid && window[i]! >= mid) up.push(start + i);
    if (window[i - 1]! >= mid && window[i]! < mid) down.push(start + i);
  }
  return { up, down };
}

function assertCrankSliderKinematics(poses: Pose[], crankKey = "crank"): void {
  const pistonX = poses.map((pose) => pose["body-piston"]!.p[0]);
  const pistonY = poses.map((pose) => Math.abs(pose["body-piston"]!.p[1]));
  const pistonZ = poses.map((pose) => Math.abs(pose["body-piston"]!.p[2]));
  const stroke = Math.max(...pistonX) - Math.min(...pistonX);
  console.log(`MECH[piston] stroke=${stroke.toFixed(4)}m yDrift=${Math.max(...pistonY).toExponential(2)} zDrift=${Math.max(...pistonZ).toExponential(2)}`);
  expect(stroke, `piston stroke ${stroke.toFixed(4)} m (analytic 0.1)`).toBeGreaterThanOrEqual(0.1 - PISTON.strokeTolerance);
  expect(stroke, `piston stroke ${stroke.toFixed(4)} m (analytic 0.1)`).toBeLessThanOrEqual(0.1 + PISTON.strokeTolerance);
  expect(Math.max(...pistonY), `piston y drift ${Math.max(...pistonY)}`).toBeLessThan(PISTON.guideDriftMeters);
  expect(Math.max(...pistonZ), `piston z drift ${Math.max(...pistonZ)}`).toBeLessThan(PISTON.guideDriftMeters);

  // 稳态周期(步数计):中线穿越事件。
  const { up, down } = midlineCrossings(pistonX, PISTON.steadyWindowStart);
  expect(up.length, `steady-window up-crossings ${up.length}`).toBeGreaterThanOrEqual(2);
  const period = up[up.length - 1]! - up[up.length - 2]!;
  expect(Math.abs(period - PISTON.periodSteps), `period ${period} steps`)
    .toBeLessThanOrEqual(PISTON.periodToleranceSteps);

  // 往复对称性(解析口径):曲柄滑块活塞过中线的时间上/下行天然不等——死点附近 x(θ) 平坦。
  // 解析预测:中线 L 处 cosθ = r/(2L),半程(上行穿越→下行穿越)角 = 2·acos(r/(2L))。
  const phi = Math.acos(PISTON.crankRadius / (2 * PISTON.rodLength));
  const expectedRise = PISTON.periodSteps * phi / Math.PI;
  const expectedFall = PISTON.periodSteps - expectedRise;
  const lastUp = up[up.length - 1]!, previousUp = up[up.length - 2]!;
  const downsBetween = down.filter((index) => index > previousUp && index < lastUp);
  expect(downsBetween.length, "one down-crossing per period").toBe(1);
  const rise = downsBetween[0]! - previousUp;
  const fall = lastUp - downsBetween[0]!;
  console.log(`MECH[piston] period=${period}steps rise=${rise} fall=${fall} (analytic ${expectedRise.toFixed(1)}/${expectedFall.toFixed(1)})`);
  expect(Math.abs(rise - expectedRise), `rise ${rise} vs analytic ${expectedRise.toFixed(1)} steps`)
    .toBeLessThanOrEqual(PISTON.strokeAsymmetrySteps);
  expect(Math.abs(fall - expectedFall), `fall ${fall} vs analytic ${expectedFall.toFixed(1)} steps`)
    .toBeLessThanOrEqual(PISTON.strokeAsymmetrySteps);

  // 周期重复性:相邻稳态周期逐点一致(±3 mm,实测首裕量 2.2 mm)——机构驱动的真正"对称"。
  const periodStart = previousUp;
  const pistonPoses = poses.map((pose) => pose["body-piston"]!.p[0]);
  for (let i = periodStart; i < periodStart + period - 1 && i + period < pistonPoses.length; i += 1) {
    const repeat = Math.abs(pistonPoses[i + period]! - pistonPoses[i]!);
    expect(repeat, `periodic repeat at step ${i}`).toBeLessThan(3e-3);
  }

  const crankAngles: number[] = [];
  poses.forEach((pose) => crankAngles.push(unwrap(crankAngles[crankAngles.length - 1], zAngle(pose[crankKey]!.q))));
  const window = PISTON.periodSteps;
  const elapsed = crankAngles[crankAngles.length - 1]! - crankAngles[crankAngles.length - 1 - window]!;
  const rate = elapsed / (window * PISTON.fixedStep);
  const relative = Math.abs(rate - PISTON.motorTargetVelocity) / PISTON.motorTargetVelocity;
  console.log(`MECH[piston] crankRate=${rate.toFixed(4)}rad/s (target ${PISTON.motorTargetVelocity.toFixed(4)}, rel ${relative.toExponential(2)})`);
  expect(relative, `crank rate ${rate.toFixed(4)} rad/s vs motor ${PISTON.motorTargetVelocity.toFixed(4)}`)
    .toBeLessThanOrEqual(PISTON.crankRateRelativeTolerance);
}

describe("Rapier Web piston-crank golden", () => {
  it("drives the piston through the analytic stroke with a stable period and repeats bit-exactly", async () => {
    const first = await runPistonCrank();
    const repeat = await runPistonCrank();
    expect(repeat.poses).toEqual(first.poses);
    assertCrankSliderKinematics(first.poses);
  });

  it("records per-step piston poses for the Web↔Native tolerance pairing (solver iterations aligned at 8)", async () => {
    const run = await runPistonCrank({ solverIterations: 8 });
    const payload = {
      meta: {
        end: "web", rapier: "0.19.3", scenario: "piston-crank",
        crankRadius: PISTON.crankRadius, rodLength: PISTON.rodLength,
        motorTargetVelocity: PISTON.motorTargetVelocity, motorStrength: PISTON.motorStrength,
        gravity: [0, 0, 0], fixedStepSeconds: PISTON.fixedStep, steps: PISTON.steps,
        solverIterations: 8, damping: { linear: 0, angular: 0 },
        bodies: ["body-piston"],
      },
      positions: run.poses.map((pose) => pose["body-piston"]!.p),
    };
    const directory = resolve(__dirname, "../../../../test-output/t17-mechanism");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "web-piston-poses.json"), JSON.stringify(payload));
    expect(run.poses).toHaveLength(PISTON.steps);
  });
});

/**
 * 组合机构(轴耦合 + 曲柄滑块):马达轴(drive)经 1:1 revolute 同轴耦合带动曲柄臂,
 * 再经连杆驱动 prismatic 滑块活塞。端到端断言:ω_arm/ω_drive≈1、行程=2r、
 * 活塞周期=马达周期、实测曲柄角代入解析式与活塞 x 逐点对照。
 */
async function runCombined(options: { solverIterations?: number } = {}) {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  if (options.solverIterations !== undefined) {
    world.integrationParameters.numSolverIterations = options.solverIterations;
  }
  const fixed = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const buildBody = (position: Vec3, half: Vec3, mass: number, colliderOffset: Vec3) => {
    const body = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setCcdEnabled(true));
    world.createCollider(
      rapier.ColliderDesc.cuboid(half.x, half.y, half.z).setMass(mass).setFriction(PISTON.friction)
        .setRestitution(PISTON.restitution).setCollisionGroups(NO_CONTACT_GROUPS)
        .setTranslation(colliderOffset.x, colliderOffset.y, colliderOffset.z),
      body,
    );
    return body;
  };
  const drive = buildBody(v(0, 0, 0), v(0.05, 0.05, 0.01), 0.6, v(0, 0, 0.05));
  const arm = buildBody(v(0.025, 0, 0), v(0.025, 0.01, 0.01), 0.5, v(0, 0, -0.05));
  const rod = buildBody(v(0.125, 0, 0), v(0.075, 0.01, 0.01), 0.2, v(0, 0, 0.015));
  const piston = buildBody(v(0.2, 0, 0), v(0.02, 0.02, 0.02), 0.5, v(0, 0, -0.05));
  mountRapierJoint(rapier, world, fixed, drive,
    jointState("j1-drive-world", "revolute", "body-drive", v(0, 0, 0), v(0, 0, 0), v(0, 0, 1),
      { motor: { targetVelocity: PISTON.motorTargetVelocity, strength: PISTON.motorStrength } }));
  // 1:1 同轴刚性联轴器:revolute 限位 [0,0] 锁死相对转动(普通 revolute 允许相对转,首轮实测角差 8 rad)。
  mountRapierJoint(rapier, world, drive, arm,
    jointState("j2-arm-drive", "revolute", "body-crank-arm", v(0, 0, 0), v(-0.025, 0, 0), v(0, 0, 1),
      { connectedBodyId: "body-drive", limits: { min: 0, max: 0 } }));
  mountRapierJoint(rapier, world, arm, rod,
    jointState("j3-arm-rod", "revolute", "body-rod", v(0.05, 0, 0), v(-0.075, 0, 0), v(0, 0, 1),
      { connectedBodyId: "body-crank-arm" }));
  mountRapierJoint(rapier, world, rod, piston, CrankSliderJoints.rodPiston);
  mountRapierJoint(rapier, world, fixed, piston, CrankSliderJoints.pistonWorld);
  const bodies: Record<string, ReturnType<typeof buildBody>> = {
    "body-piston": piston, "body-drive": drive, "body-crank-arm": arm, rod,
  };
  const host = new PhysicsWorldHost();
  host.attach({
    setGravity: (gravity) => { world.gravity = { ...gravity }; },
    step: (timestep) => { world.timestep = timestep; world.step(); },
    dispose: () => world.free(),
  });
  host.configure({ enabled: true, playing: true, gravity: { x: 0, y: 0, z: 0 } });
  const snapshot = (): Pose => Object.fromEntries(Object.entries(bodies).map(([id, body]) => {
    const t = body.translation(), r = body.rotation();
    return [id, { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] }];
  }));
  const poses: Pose[] = [];
  for (let step = 0; step < PISTON.steps; step += 1) {
    expect(host.advance(PISTON.fixedStep).steps, `step ${step + 1}`).toBe(1);
    poses.push(snapshot());
  }
  host.dispose();
  return { poses };
}

describe("Rapier Web combined mechanism golden", () => {
  it("couples a 1:1 shaft into the crank-slider and tracks the analytic piston curve end-to-end", async () => {
    const first = await runCombined();
    const repeat = await runCombined();
    expect(repeat.poses).toEqual(first.poses);
    assertCrankSliderKinematics(first.poses, "body-crank-arm");

    // 1:1 轴耦合:末窗平均角速度比。
    const angleOf = (poses: Pose[], id: string): number[] => {
      const angles: number[] = [];
      poses.forEach((pose) => angles.push(unwrap(angles[angles.length - 1], zAngle(pose[id]!.q))));
      return angles;
    };
    const driveAngles = angleOf(first.poses, "body-drive");
    const armAngles = angleOf(first.poses, "body-crank-arm");
    const window = PISTON.periodSteps;
    const last = PISTON.steps - 1;
    const driveRate = (driveAngles[last]! - driveAngles[last - window]!) / (window * PISTON.fixedStep);
    const armRate = (armAngles[last]! - armAngles[last - window]!) / (window * PISTON.fixedStep);
    const ratio = armRate / driveRate;
    console.log(`MECH[combo] armRate=${armRate.toFixed(4)} driveRate=${driveRate.toFixed(4)} ratio=${ratio.toFixed(4)}`);
    expect(ratio, `arm/drive ratio ${ratio.toFixed(4)}`).toBeGreaterThanOrEqual(1 - COMBO.couplingRatioRelativeTolerance);
    expect(ratio, `arm/drive ratio ${ratio.toFixed(4)}`).toBeLessThanOrEqual(1 + COMBO.couplingRatioRelativeTolerance);

    // 端到端解析对照:实测曲柄角代入 x(θ),与活塞实测 x 逐点比较(稳态窗口)。
    let worst = 0;
    for (let i = PISTON.steadyWindowStart; i < PISTON.steps; i += 1) {
      const theta = armAngles[i]!;
      const analytic = PISTON.crankRadius * Math.cos(theta)
        + Math.sqrt(PISTON.rodLength ** 2 - (PISTON.crankRadius * Math.sin(theta)) ** 2);
      worst = Math.max(worst, Math.abs(first.poses[i]!["body-piston"]!.p[0] - analytic));
    }
    console.log(`MECH[combo] worstAnalyticDeviation=${worst.toFixed(5)}m periodRepeat=<see piston>` );
    expect(worst, `worst analytic deviation ${worst.toFixed(5)} m`).toBeLessThan(COMBO.analyticToleranceMeters);
  });

  it("records per-step piston poses for the combined mechanism pairing (solver iterations aligned at 8)", async () => {
    const run = await runCombined({ solverIterations: 8 });
    const payload = {
      meta: {
        end: "web", rapier: "0.19.3", scenario: "combined-shaft-crank-slider",
        crankRadius: PISTON.crankRadius, rodLength: PISTON.rodLength,
        motorTargetVelocity: PISTON.motorTargetVelocity, motorStrength: PISTON.motorStrength,
        gravity: [0, 0, 0], fixedStepSeconds: PISTON.fixedStep, steps: PISTON.steps,
        solverIterations: 8, damping: { linear: 0, angular: 0 },
        bodies: ["body-piston", "body-drive", "body-crank-arm"],
      },
      positions: run.poses.map((pose) => ({
        "body-piston": pose["body-piston"]!.p, "body-drive": pose["body-drive"]!.p,
        "body-crank-arm": pose["body-crank-arm"]!.p,
      })),
    };
    const directory = resolve(__dirname, "../../../../test-output/t17-mechanism");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "web-combined-poses.json"), JSON.stringify(payload));
    expect(run.poses).toHaveLength(PISTON.steps);
  });
});
