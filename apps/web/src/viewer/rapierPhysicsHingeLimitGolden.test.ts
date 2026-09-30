import { describe, expect, it } from "vitest";
import type { ScenePhysicsJointState } from "@bim-studio/contracts";
import { mountRapierRevoluteJoint } from "./rapierPhysicsJoint";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 铰链限位黄金案例(Web 侧)。参数与 Native
 * `packages/deep-engine-native/src/native_physics_golden_tests.rs` 的 hinge 案例逐项对齐;
 * 改任何参数必须两侧同步,否则跨端结论不可比。
 *
 * 零重力隔离马达行为:0.5 m 细臂(半长 0.25)经 revolute joint(z 轴,锚点原点)挂固定世界,
 * 限位 ±0.5 rad,速度马达 targetVelocity=+2 rad/s、strength=10 驱动越过限位。
 * 断言:角度被钳在限位附近(且整程不超过限位+容差),同输入重复运行逐位一致;
 * 无限位对照组同马达明显越过 0.5 rad,证明钳制来自限位而非马达不够力。
 */
const HINGE = {
  armHalf: { x: 0.25, y: 0.02, z: 0.02 },
  mass: 1,
  friction: 0.6,
  limitMin: -0.5,
  limitMax: 0.5,
  motorTargetVelocity: 2,
  motorStrength: 10,
  fixedStep: 1 / 60,
  steps: 120,
  /** 限位附近的最终角度区间与整程上界(弧度)。容差来自首次实测裕量。 */
  finalAngleMin: 0.45,
  finalAngleMax: 0.55,
  overshootTolerance: 0.05,
} as const;

const jointState = (limitsEnabled: boolean): ScenePhysicsJointState => ({
  id: "joint-arm",
  kind: "revolute",
  bodyId: "body-arm",
  worldAnchor: { x: 0, y: 0, z: 0 },
  localAnchor: { x: -0.25, y: 0, z: 0 },
  axis: { x: 0, y: 0, z: 1 },
  limits: { enabled: limitsEnabled, min: HINGE.limitMin, max: HINGE.limitMax },
  motor: { enabled: true, targetVelocity: HINGE.motorTargetVelocity, strength: HINGE.motorStrength },
});

/** 把 atan2/quat 反解出的主值角接续成单调连续角,越过 ±π 不回卷。 */
function unwrap(previous: number | undefined, raw: number): number {
  if (previous === undefined) return raw;
  let value = raw;
  while (value - previous > Math.PI) value -= 2 * Math.PI;
  while (previous - value > Math.PI) value += 2 * Math.PI;
  return value;
}

async function runHinge(limitsEnabled: boolean) {
  const rapier = (await import("@dimforge/rapier3d-compat")).default;
  await rapier.init();
  const world = new rapier.World({ x: 0, y: 0, z: 0 });
  const fixed = world.createRigidBody(rapier.RigidBodyDesc.fixed());
  const arm = world.createRigidBody(rapier.RigidBodyDesc.dynamic().setTranslation(0.25, 0, 0));
  world.createCollider(
    rapier.ColliderDesc.cuboid(HINGE.armHalf.x, HINGE.armHalf.y, HINGE.armHalf.z)
      .setMass(HINGE.mass).setFriction(HINGE.friction),
    arm,
  );
  const joint = mountRapierRevoluteJoint(rapier, world, fixed, arm, jointState(limitsEnabled));
  const rawAngle = (): number => {
    const r = arm.rotation();
    return 2 * Math.atan2(r.z, r.w);
  };
  const angles: number[] = [];
  for (let step = 0; step < HINGE.steps; step += 1) {
    world.timestep = HINGE.fixedStep;
    world.step();
    angles.push(unwrap(angles[angles.length - 1], rawAngle()));
  }
  // 限位标志必须在 world.free() 之前读取,句柄释放后再访问会命中 null pointer。
  const jointLimitsEnabled = joint.limitsEnabled();
  world.free();
  return { angles, limitsEnabled: jointLimitsEnabled };
}

describe("Rapier Web hinge limit golden", () => {
  it("exports the existing actual hinge golden for an independent oracle", async () => {
    const limited = await runHinge(true), repeat = await runHinge(true), control = await runHinge(false);
    expect(repeat.angles).toEqual(limited.angles);
    const output = resolve(__dirname, "../../../../test-output/c5-bullet"); mkdirSync(output, { recursive: true });
    writeFileSync(resolve(output, "web-hinge.json"), JSON.stringify({ meta: HINGE,
      limited: limited.angles, repeat: repeat.angles, control: control.angles }));
  });
  it("clamps a motor-driven arm at the authored limits and repeats bit-exactly", async () => {
    const first = await runHinge(true);
    const repeat = await runHinge(true);
    expect(repeat.angles).toEqual(first.angles);
    expect(first.limitsEnabled).toBe(true);

    const final = first.angles[first.angles.length - 1];
    expect(final, `final angle ${final}`).toBeGreaterThanOrEqual(HINGE.finalAngleMin);
    expect(final, `final angle ${final}`).toBeLessThanOrEqual(HINGE.finalAngleMax);
    const peak = Math.max(...first.angles);
    expect(peak, `peak angle ${peak}`).toBeLessThanOrEqual(HINGE.limitMax + HINGE.overshootTolerance);
  });

  it("lets the same motor drive far past the limit when limits are disabled", async () => {
    const control = await runHinge(false);
    expect(control.limitsEnabled).toBe(false);
    const final = control.angles[control.angles.length - 1];
    expect(final, `unlimited control final angle ${final}`).toBeGreaterThan(1.0);
  });
});
