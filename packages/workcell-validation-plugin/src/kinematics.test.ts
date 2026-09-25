// 运动学内核测试:FK/IK/节拍全部用手算值对照,禁止"实现自证实现"。
// 业务约束:auditWorkcell 行为零变化;golden 指纹锁定正逆解+节拍+最小间距全链。
import type { Vector3Value, WorkcellRobotChain } from "@bim-studio/contracts";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { forwardKinematics, solveIk, solveIkAnalytic2R } from "./kinematics.js";
import { planTrajectory } from "./trajectoryPlanner.js";

const ARM_2R: WorkcellRobotChain = {
  base: { x: 0, y: 0, z: 0 },
  links: [
    { id: "j1", name: "J1", length: 1, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 30 },
    { id: "j2", name: "J2", length: 1, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 30 },
  ],
};

const ARM_6R: WorkcellRobotChain = {
  base: { x: 0, y: 0, z: 0 },
  links: [
    { id: "j1", name: "J1", length: 0.4, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
    { id: "j2", name: "J2", length: 0.3, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
    { id: "j3", name: "J3", length: 0.25, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
    { id: "j4", name: "J4", length: 0.2, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
    { id: "j5", name: "J5", length: 0.15, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
    { id: "j6", name: "J6", length: 0.1, minAngleDeg: -180, maxAngleDeg: 180, maxSpeedDegPerSec: 20 },
  ],
};

describe("正运动学 FK", () => {
  it("2R 已知构型与手算值一致", () => {
    expect(forwardKinematics(ARM_2R, [90, 0]).tcp).toBeCloseToVector({ x: 0, y: 2, z: 0 });
    expect(forwardKinematics(ARM_2R, [0, 90]).tcp).toBeCloseToVector({ x: 1, y: 1, z: 0 });
    // x = cos30°+cos75° = 1.1248444;y = sin30°+sin75° = 1.4659258
    expect(forwardKinematics(ARM_2R, [30, 45]).tcp).toBeCloseToVector({ x: 1.1248444, y: 1.4659258, z: 0 });
    expect(forwardKinematics(ARM_2R, [30, 45]).positions).toHaveLength(3);
  });

  it("6R 全零位 TCP 等于基座加各段长度和", () => {
    const chain = { ...ARM_6R, base: { x: 0.5, y: 1, z: 0.2 } };
    const result = forwardKinematics(chain, [0, 0, 0, 0, 0, 0]);
    expect(result.tcp).toBeCloseToVector({ x: 1.9, y: 1, z: 0.2 });
    for (const position of result.positions) {
      expect(position.y).toBeCloseTo(1, 12);
      expect(position.z).toBeCloseTo(0.2, 12);
    }
  });

  it("6R 偶数序号 Y 轴关节把链引出 XY 平面(空间串联约定)", () => {
    // J2 绕局部 Y 转 90° 后,后续连杆全部指向 -Z:tcp z = -(0.3+0.25+0.2+0.15+0.1)
    expect(forwardKinematics(ARM_6R, [0, 90, 0, 0, 0, 0]).tcp).toBeCloseToVector({ x: 0.4, y: 0, z: -1 });
  });
});

describe("逆运动学 IK", () => {
  it("2R 数值解与解析解一致(残差 <1e-4)", () => {
    for (const target of [{ x: 1, y: 1, z: 0 }, { x: 0.5, y: 0.8660254, z: 0 }, { x: -1.2, y: 0.5, z: 0 }]) {
      const analytic = solveIkAnalytic2R(ARM_2R, target);
      expect(analytic.reachable).toBe(true);
      const numeric = solveIk(ARM_2R, target, [0, 0]);
      expect(numeric.ok).toBe(true);
      expect(numeric.residualMeters).toBeLessThan(1e-4);
      const numericTcp = forwardKinematics(ARM_2R, numeric.angles).tcp;
      const analyticTcpValues = analytic.solutions.map((angles) => forwardKinematics(ARM_2R, angles).tcp);
      const gap = Math.min(...analyticTcpValues.map((tcp) => distance(tcp, numericTcp)));
      expect(gap).toBeLessThan(1e-4);
    }
  });

  it("6R 可达点收敛且 FK 复核闭合", () => {
    const target = { x: 0.8, y: 0.3, z: 0.4 };
    const ik = solveIk(ARM_6R, target, [0, 0, 0, 0, 0, 0]);
    expect(ik.ok).toBe(true);
    expect(ik.residualMeters).toBeLessThan(1e-4);
    expect(ik.iterations).toBeLessThanOrEqual(200);
    expect(distance(forwardKinematics(ARM_6R, ik.angles).tcp, target)).toBeLessThan(1e-4);
  });

  it("6R 超臂长点 ok=false 且 residual>0,角度保持在限位内", () => {
    const ik = solveIk(ARM_6R, { x: 3.5, y: 0, z: 0 }, [0, 0, 0, 0, 0, 0]);
    expect(ik.ok).toBe(false);
    expect(ik.residualMeters).toBeGreaterThan(0);
    ARM_6R.links.forEach((link, index) => {
      expect(ik.angles[index]!).toBeGreaterThanOrEqual(link.minAngleDeg - 1e-6);
      expect(ik.angles[index]!).toBeLessThanOrEqual(link.maxAngleDeg + 1e-6);
    });
  });

  it("窄限位链触发限位裁剪:clamped=true、角度贴限位、目标不可达", () => {
    const tight: WorkcellRobotChain = {
      base: { x: 0, y: 0, z: 0 },
      links: ARM_6R.links.map((link) => ({ ...link, minAngleDeg: -2, maxAngleDeg: 2 })),
    };
    const ik = solveIk(tight, { x: 0.7, y: 0.5, z: 0.3 }, [0, 0, 0, 0, 0, 0]);
    expect(ik.clamped).toBe(true);
    expect(ik.ok).toBe(false);
    expect(ik.residualMeters).toBeGreaterThan(1e-4);
    ik.angles.forEach((angle) => {
      expect(angle).toBeGreaterThanOrEqual(-2 - 1e-6);
      expect(angle).toBeLessThanOrEqual(2 + 1e-6);
    });
  });

  it("平面链对 z≠0 目标不可达(约束声明为 XY 平面)", () => {
    expect(solveIk(ARM_2R, { x: 1, y: 1, z: 0.5 }, [0, 0]).ok).toBe(false);
    expect(solveIkAnalytic2R(ARM_2R, { x: 1, y: 1, z: 0.5 }).reachable).toBe(false);
  });

  it("2R 内死区目标不可达", () => {
    const longFirst: WorkcellRobotChain = { ...ARM_2R, links: [{ ...ARM_2R.links[0]!, length: 1.5 }, ARM_2R.links[1]!] };
    const result = solveIk(longFirst, { x: 0.2, y: 0, z: 0 }, [0, 0]);
    expect(result.ok).toBe(false);
    expect(result.residualMeters).toBeGreaterThan(1e-4);
  });
});

describe("轨迹节拍与违规", () => {
  it("段时长 = max(关节位移/速度),手算 90°/30°/s ≈ 3s", () => {
    const plan = planTrajectory(ARM_2R, [v(2, 0, 0), v(0, 2, 0), v(0, 1, 0)], { seedAngles: [0, 0] });
    expect(plan.ok).toBe(true);
    expect(plan.violations).toEqual([]);
    // 手算对照:伸直构型间 J1 位移 ~90°(IK 允许 ≤1e-4 m 切向滑移),90°/30°/s = 3s。
    expect(plan.segmentDurations[0]).toBeCloseTo(3, 1);
    expect(plan.segmentDurations[1]).toBeGreaterThan(0);
    for (let index = 0; index < plan.segmentDurations.length; index += 1) {
      const shift = Math.max(...ARM_2R.links.map((_, joint) => Math.abs(plan.jointPath[index + 1]![joint]! - plan.jointPath[index]![joint]!)));
      expect(plan.segmentDurations[index]).toBeCloseTo(shift / 30, 12);
    }
    expect(plan.totalCycleSeconds).toBeCloseTo(plan.segmentDurations[0]! + plan.segmentDurations[1]!, 12);
    expect(distance(forwardKinematics(ARM_2R, plan.jointPath[1]!).tcp, v(0, 2, 0))).toBeLessThan(1e-4);
  });

  it("未声明速度的关节不参与节拍并如实标注 unlimited", () => {
    const unlimited: WorkcellRobotChain = {
      base: { x: 0, y: 0, z: 0 },
      links: ARM_2R.links.map(({ maxSpeedDegPerSec: _speed, ...link }) => link),
    };
    const plan = planTrajectory(unlimited, [v(2, 0, 0), v(0, 2, 0)]);
    expect(plan.segmentDurations).toEqual([0]);
    expect(plan.totalCycleSeconds).toBe(0);
    expect(plan.unlimitedJointIds).toEqual(["j1", "j2"]);
    expect(plan.ok).toBe(true);
  });

  it("不可达点按索引标注 unreachable,失败段不计入节拍", () => {
    const plan = planTrajectory(ARM_2R, [v(2, 0, 0), v(0, 2, 0), v(0, 1, 0), v(5, 0, 0)], { seedAngles: [0, 0] });
    expect(plan.ok).toBe(false);
    expect(plan.violations).toEqual([expect.objectContaining({ index: 3, kind: "unreachable" })]);
    expect(plan.violations[0]!.residualMeters).toBeGreaterThan(0);
    expect(plan.jointPath[3]).toEqual([]);
    expect(plan.segmentDurations).toHaveLength(2);
  });

  it("空路径点不产出通过结论", () => {
    expect(planTrajectory(ARM_2R, []).ok).toBe(false);
  });

  it("限位内无解但无限位可达的点标注 joint-limit", () => {
    const tight: WorkcellRobotChain = {
      base: { x: 0, y: 0, z: 0 },
      links: ARM_2R.links.map((link) => ({ ...link, minAngleDeg: -2, maxAngleDeg: 2 })),
    };
    const plan = planTrajectory(tight, [v(1, 1, 0)]);
    expect(plan.ok).toBe(false);
    expect(plan.violations).toEqual([expect.objectContaining({ index: 0, kind: "joint-limit" })]);
    expect(plan.violations[0]!.residualMeters).toBeGreaterThan(1e-4);
  });

  it("连杆扫掠进入障碍扩张 AABB 时按索引标注 clearance", () => {
    const plan = planTrajectory(ARM_2R, [v(2, 0, 0), v(0, 2, 0)], {
      clearanceMeters: 0.1,
      obstacles: [{ id: "post", bounds: { min: { x: 0.9, y: 0.9, z: -0.1 }, max: { x: 1.1, y: 1.1, z: 0.1 } } }],
    });
    expect(plan.ok).toBe(false);
    expect(plan.violations).toEqual([expect.objectContaining({ index: 0, kind: "clearance", obstacleId: "post" })]);
    expect(plan.minimumEnvironmentClearanceMeters).toBe(0);
  });

  it("远离障碍时只输出最小间距不产生违规", () => {
    const plan = planTrajectory(ARM_2R, [v(2, 0, 0), v(0, 2, 0)], {
      clearanceMeters: 0.05,
      obstacles: [{ id: "far", bounds: { min: { x: 8, y: 8, z: -1 }, max: { x: 9, y: 9, z: 1 } } }],
    });
    expect(plan.ok).toBe(true);
    expect(plan.minimumEnvironmentClearanceMeters!).toBeGreaterThan(8);
  });
});

describe("golden-kin 全链指纹", () => {
  const waypoints = [v(0.85, 0.12, 0.08), v(0.8, 0.25, 0.1), v(0.6, 0.45, 0.25), v(0.3, 0.6, 0.35), v(-0.1, 0.7, 0.4)];
  const options = {
    clearanceMeters: 0.05,
    obstacles: [{ id: "cell-wall", bounds: { min: { x: 5, y: -1, z: -1 }, max: { x: 6, y: 1, z: 2 } } }],
    seedAngles: [0, 0, 0, 0, 0, 0],
  };

  it("正逆解+节拍+最小间距全链通过手算锚点复核", () => {
    const plan = planTrajectory(ARM_6R, waypoints, options);
    expect(plan.ok).toBe(true);
    expect(plan.violations).toEqual([]);
    expect(plan.jointPath).toHaveLength(5);
    waypoints.forEach((target, index) => {
      expect(distance(forwardKinematics(ARM_6R, plan.jointPath[index]!).tcp, target)).toBeLessThan(1e-4);
    });
    // 每段时长不得低于最慢关节位移/速度(速度 20°/s)
    plan.segmentDurations.forEach((duration, index) => {
      const shift = Math.max(...ARM_6R.links.map((_, joint) => Math.abs(plan.jointPath[index + 1]![joint]! - plan.jointPath[index]![joint]!)));
      expect(duration).toBeGreaterThanOrEqual(shift / 20 - 1e-9);
    });
    expect(plan.totalCycleSeconds).toBeGreaterThan(0);
    expect(plan.minimumSelfClearanceMeters!).toBeGreaterThan(0.01);
  });

  it("同输入两次运行指纹一致并锁定固值,不同输入指纹改变", () => {
    const first = planTrajectory(ARM_6R, waypoints, options);
    const second = planTrajectory(ARM_6R, waypoints, options);
    const chainOf = (plan: ReturnType<typeof planTrajectory>) => fingerprint64Labeled([
      ["jointPath", plan.jointPath],
      ["segmentDurations", plan.segmentDurations],
      ["totalCycleSeconds", plan.totalCycleSeconds],
      ["violations", plan.violations],
      ["minimumEnvironmentClearanceMeters", plan.minimumEnvironmentClearanceMeters],
      ["minimumSelfClearanceMeters", plan.minimumSelfClearanceMeters],
    ]);
    expect(chainOf(first)).toBe(chainOf(second));
    expect(chainOf(first)).toBe(GOLDEN_KIN_FINGERPRINT);
    const altered = planTrajectory(ARM_6R, [waypoints[0]!, v(0.85, 0.2, 0.08), ...waypoints.slice(2)], options);
    expect(chainOf(altered)).not.toBe(GOLDEN_KIN_FINGERPRINT);
  });
});

// golden-kin 固值:jointPath/segmentDurations/totalCycleSeconds/violations/双最小间距
// 的标签化组合指纹;实现数值、起点集或轨迹任一变化都会使其失效,属预期破坏点,需人工复核后更新。
const GOLDEN_KIN_FINGERPRINT = "b367ab792d375f64";

function v(x: number, y: number, z: number): Vector3Value {
  return { x, y, z };
}
function distance(left: Vector3Value, right: Vector3Value): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
expect.extend({
  toBeCloseToVector(received: Vector3Value, expected: Vector3Value) {
    const pass = Math.abs(received.x - expected.x) < 1e-6 && Math.abs(received.y - expected.y) < 1e-6 && Math.abs(received.z - expected.z) < 1e-6;
    return { pass, message: () => `expected ${JSON.stringify(received)} ≈ ${JSON.stringify(expected)}` };
  },
});

interface VectorMatchers<R> {
  toBeCloseToVector(expected: Vector3Value): R;
}
declare module "vitest" {
  interface Assertion<T> extends VectorMatchers<T> { }
  interface AsymmetricMatchersContaining extends VectorMatchers<unknown> { }
}
