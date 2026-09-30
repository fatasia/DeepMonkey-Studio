import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { RobotAssetDefinition } from "@bim-studio/contracts";
import { buildSkeletonFromRobotDefinition, type IKSkeleton } from "./ikSkeleton";
import {
  crossPairs,
  runSweepCollision,
  type SweepBody,
  type SweepPairSpec,
  type SweepTrajectorySpec,
} from "./robotSweepCollision";
import { translationTransform } from "./convexDistance";

/**
 * N10 时间扫掠聚焦测试:沿真实 FK(T15 ikSkeleton)轨迹的解析用例对拍——
 * 已知碰撞时刻、无碰撞最小间距、擦边不漏检、粗筛有效性、确定性、10k×10 性能。
 * 几何:单关节臂(绕 z),末梢球心在半径 1 的圆上;静态球在同圆某角度。
 * 圆心距 = 2·sin(|Δθ|/2),碰撞条件 2·sin(|Δθ|/2) ≤ r1+r2 → 碰撞时刻有封闭解。
 */

const TIP_RADIUS = 0.2;
const STATIC_RADIUS = 0.2;
const ARM_RADIUS = 1;
const SWEEP_ANGLE = Math.PI / 2;
/** 碰撞半角:圆心距 = 2·sin(|Δθ|/2) ≤ r1+r2 = 0.4 → |Δθ| ≤ 2·asin(0.2)。 */
const CONTACT_HALF_ANGLE = 2 * Math.asin((TIP_RADIUS + STATIC_RADIUS) / (2 * ARM_RADIUS));

function singleJointSkeleton(): IKSkeleton {
  const definition: RobotAssetDefinition = {
    schemaVersion: 1,
    name: "n10-arm",
    entryPath: "n10-arm.urdf",
    rootLink: "base",
    links: [
      { name: "base", visuals: [], collisions: [] },
      { name: "link1", visuals: [], collisions: [] },
    ],
    joints: [
      {
        name: "j1",
        type: "revolute",
        parent: "base",
        child: "link1",
        origin: { xyz: { x: 0, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } },
        axis: { x: 0, y: 0, z: 1 },
        limit: { lower: 0, upper: Math.PI },
      },
    ],
    materials: [],
    resources: [],
  };
  return buildSkeletonFromRobotDefinition(definition);
}

/** θ 从 0 线性到 SWEEP_ANGLE,时长 1 s;pose = [基座 0, θ]。 */
function linearTrajectory(skeleton: IKSkeleton, sampleCount: number): SweepTrajectorySpec {
  return {
    skeleton,
    startTimeSeconds: 0,
    endTimeSeconds: 1,
    sampleCount,
    poseAt: (seconds: number) => [0, (SWEEP_ANGLE / 1) * seconds],
  };
}

function tipBody(): SweepBody {
  return {
    bodyId: "tip-sphere",
    attach: "node",
    nodeIndex: 1,
    shape: { kind: "sphere", radius: TIP_RADIUS },
    localTransform: translationTransform([ARM_RADIUS, 0, 0]),
  };
}

function staticSphereAtAngle(angle: number): SweepBody {
  return {
    bodyId: "static-sphere",
    attach: "static",
    shape: { kind: "sphere", radius: STATIC_RADIUS },
    transform: translationTransform([Math.cos(angle) * ARM_RADIUS, Math.sin(angle) * ARM_RADIUS, 0]),
  };
}

const TIP: SweepPairSpec = { bodyIdA: "tip-sphere", bodyIdB: "static-sphere" };

describe("时间扫掠 · 已知碰撞时刻", () => {
  it("静态球在 π/6:入口/出口时刻与解析解一致(±1e-5),穿透区间唯一", () => {
    const skeleton = singleJointSkeleton();
    const alpha = Math.PI / 6;
    const tEnter = (alpha - CONTACT_HALF_ANGLE) / SWEEP_ANGLE;
    const tExit = (alpha + CONTACT_HALF_ANGLE) / SWEEP_ANGLE;
    const { report } = runSweepCollision(
      linearTrajectory(skeleton, 1000),
      [tipBody(), staticSphereAtAngle(alpha)],
      [TIP],
    );
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0]!;
    expect(pair.collisionIntervals).toHaveLength(1);
    const interval = pair.collisionIntervals[0]!;
    expect(Math.abs(interval.enterSeconds - tEnter)).toBeLessThan(1e-5);
    expect(Math.abs(interval.exitSeconds - tExit)).toBeLessThan(1e-5);
    expect(pair.firstCollision).toBeDefined();
    expect(Math.abs(pair.firstCollision!.timeSeconds - tEnter)).toBeLessThan(1e-5);
    // 接触点契约:细化入口落在切触邻域 → 分离态带最近点对(|gap| = distance);
    // 落在穿透态则如实无点(接触集不唯一),两种形态都合法。
    const contact = pair.firstCollision!;
    if (contact.pointA && contact.pointB) {
      const gap = Math.hypot(contact.pointA[0] - contact.pointB[0], contact.pointA[1] - contact.pointB[1], contact.pointA[2] - contact.pointB[2]);
      expect(gap).toBeLessThan(1e-5);
    } else {
      expect(contact.pointA).toBeUndefined();
      expect(contact.pointB).toBeUndefined();
    }
    // 最小间距 = 0,首次出现在入口后的首个穿透样本。
    expect(pair.minDistance).toBe(0);
    expect(pair.minDistanceAtSeconds).toBeGreaterThanOrEqual(tEnter);
    expect(pair.minDistanceAtSeconds).toBeLessThanOrEqual(tEnter + 1 / 999 + 1e-12);
    // 碰撞与细化都真实发生;碰撞后 min=0,出口后的分离样本被球下界剪枝(min=0 时下界恒 ≥ 0)。
    expect(report.meta.gjkQueries).toBeGreaterThan(0);
    expect(report.meta.sphereCulledSamples).toBeGreaterThan(0);
    expect(report.meta.refinementEvaluations).toBeGreaterThan(0);
  });
});

describe("时间扫掠 · 无碰撞最小间距", () => {
  it("静态球在 −π/6:最小间距 = 2·sin(π/12) − 0.4,出现在 t=0,无碰撞区间", () => {
    const skeleton = singleJointSkeleton();
    const alpha = -Math.PI / 6;
    const expectedMin = 2 * Math.sin(Math.PI / 12) - (TIP_RADIUS + STATIC_RADIUS);
    const { report } = runSweepCollision(
      linearTrajectory(skeleton, 1000),
      [tipBody(), staticSphereAtAngle(alpha)],
      [TIP],
    );
    const pair = report.pairs[0]!;
    expect(pair.firstCollision).toBeUndefined();
    expect(pair.collisionIntervals).toHaveLength(0);
    expect(Math.abs(pair.minDistance - expectedMin)).toBeLessThan(1e-6);
    expect(pair.minDistanceAtSeconds).toBe(0);
    expect(pair.minDistancePointA).toBeDefined();
    // 最近点对在连心线上:|pointA − pointB| = minDistance。
    if (pair.minDistancePointA && pair.minDistancePointB) {
      const gap = Math.hypot(
        pair.minDistancePointA[0] - pair.minDistancePointB[0],
        pair.minDistancePointA[1] - pair.minDistancePointB[1],
        pair.minDistancePointA[2] - pair.minDistancePointB[2],
      );
      expect(gap).toBeCloseTo(pair.minDistance, 9);
    }
  });
});

describe("时间扫掠 · 擦边不漏检", () => {
  it("切触恰在 t=0 样本:必须报碰撞,时刻为扫掠起点", () => {
    const skeleton = singleJointSkeleton();
    // 静态球放 θ = 2·asin(0.2) 处:t=0(θ=0)时圆心距恰 = 0.4 = r1+r2 → 切触。
    const alpha = CONTACT_HALF_ANGLE;
    const { report } = runSweepCollision(
      linearTrajectory(skeleton, 1000),
      [tipBody(), staticSphereAtAngle(alpha)],
      [TIP],
    );
    const pair = report.pairs[0]!;
    expect(pair.firstCollision).toBeDefined();
    expect(pair.firstCollision!.timeSeconds).toBe(0);
    expect(pair.minDistance).toBeLessThanOrEqual(1e-9);
    expect(pair.collisionIntervals.length).toBeGreaterThanOrEqual(1);
    expect(pair.collisionIntervals[0]!.enterSeconds).toBe(0);
  });

  it("极小净空(1e-4 m)轨迹:不漏报为碰撞,且最小间距与解析一致", () => {
    const skeleton = singleJointSkeleton();
    // 静态角 = 切触角再向扫掠弧外扩 δ(t=0 端点净空恰 δ,此后 θ 远离静态球):圆心距 = 0.4 + δ。
    const clearance = 1e-4;
    const halfAngle = 2 * Math.asin((TIP_RADIUS + STATIC_RADIUS + clearance) / (2 * ARM_RADIUS));
    const { report } = runSweepCollision(
      linearTrajectory(skeleton, 1000),
      [tipBody(), staticSphereAtAngle(-halfAngle)],
      [TIP],
    );
    const pair = report.pairs[0]!;
    expect(pair.firstCollision).toBeUndefined();
    expect(Math.abs(pair.minDistance - clearance)).toBeLessThan(1e-6);
  });
});

describe("时间扫掠 · 工具/工件与粗筛", () => {
  it("两关节臂 + 法兰工具 + 远处工件:粗筛剪枝生效,最近点对解析一致", () => {
    const definition: RobotAssetDefinition = {
      schemaVersion: 1,
      name: "n10-arm2",
      entryPath: "n10-arm2.urdf",
      rootLink: "base",
      links: [
        { name: "base", visuals: [], collisions: [] },
        { name: "link1", visuals: [], collisions: [] },
        { name: "link2", visuals: [], collisions: [] },
      ],
      joints: [
        {
          name: "j1", type: "revolute", parent: "base", child: "link1",
          origin: { xyz: { x: 0, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } },
          axis: { x: 0, y: 0, z: 1 }, limit: { lower: -1, upper: 1 },
        },
        {
          name: "j2", type: "revolute", parent: "link1", child: "link2",
          origin: { xyz: { x: 1, y: 0, z: 0 }, rpy: { x: 0, y: 0, z: 0 } },
          axis: { x: 0, y: 0, z: 1 }, limit: { lower: -1, upper: 1 },
        },
      ],
      materials: [],
      resources: [],
    };
    const skeleton = buildSkeletonFromRobotDefinition(definition);
    const bodies: SweepBody[] = [
      { bodyId: "link1-tip", attach: "node", nodeIndex: 1, shape: { kind: "sphere", radius: 0.2 }, localTransform: translationTransform([1, 0, 0]) },
      { bodyId: "tool", attach: "node", nodeIndex: 2, shape: { kind: "sphere", radius: 0.1 }, localTransform: translationTransform([0.5, 0, 0]) },
      {
        bodyId: "workpiece", attach: "static", shape: { kind: "vertices", vertices: [
          -0.05, -0.05, -0.05, 0.05, -0.05, -0.05, -0.05, 0.05, -0.05, 0.05, 0.05, -0.05,
          -0.05, -0.05, 0.05, 0.05, -0.05, 0.05, -0.05, 0.05, 0.05, 0.05, 0.05, 0.05,
        ] },
        transform: translationTransform([5, 0, 0]),
      },
    ];
    const pairs = crossPairs(["link1-tip", "tool"], ["workpiece"]);
    expect(pairs).toHaveLength(2);
    const trajectory: SweepTrajectorySpec = {
      skeleton,
      startTimeSeconds: 0,
      endTimeSeconds: 1,
      sampleCount: 500,
      poseAt: (seconds: number) => [0, 0.3 * seconds, 0.2 * seconds],
    };
    const { report } = runSweepCollision(trajectory, bodies, pairs);
    expect(report.pairs).toHaveLength(2);
    expect(report.meta.sphereCulledSamples).toBeGreaterThan(0);
    // t=0 时 link1-tip 球心 (1,0,0),工件面 x=4.95:距离 = 4.95 − 1.2 = 3.75。
    const linkPair = report.pairs.find(pair => pair.bodyIdA === "link1-tip")!;
    expect(linkPair.minDistance).toBeCloseTo(3.75, 6);
    expect(linkPair.minDistanceAtSeconds).toBe(0);
    expect(linkPair.minDistancePointA![0]).toBeCloseTo(1.2, 6);
    expect(linkPair.minDistancePointB![0]).toBeCloseTo(4.95, 6);
    // 工具球心 (1.5,0,0):距离 = 4.95 − 1.6 = 3.35。
    const toolPair = report.pairs.find(pair => pair.bodyIdA === "tool")!;
    expect(toolPair.minDistance).toBeCloseTo(3.35, 6);
  });
});

describe("时间扫掠 · 校验与确定性", () => {
  const skeleton = singleJointSkeleton();

  it("非法输入显式报错", () => {
    const trajectory = linearTrajectory(skeleton, 100);
    const bodies = [tipBody(), staticSphereAtAngle(0.3)];
    expect(() => runSweepCollision({ ...trajectory, sampleCount: 1 }, bodies, [TIP])).toThrow();
    expect(() => runSweepCollision({ ...trajectory, endTimeSeconds: 0 }, bodies, [TIP])).toThrow();
    expect(() => runSweepCollision(trajectory, [tipBody(), tipBody(), staticSphereAtAngle(0.3)], [TIP])).toThrow(/重复/);
    expect(() => runSweepCollision(trajectory, bodies, [{ bodyIdA: "tip-sphere", bodyIdB: "ghost" }])).toThrow(/未知体/);
    expect(() => runSweepCollision(trajectory, bodies, [{ bodyIdA: "tip-sphere", bodyIdB: "tip-sphere" }])).toThrow(/同一体/);
    expect(() => runSweepCollision(trajectory, [
      { bodyId: "bad-node", attach: "node", nodeIndex: 99, shape: { kind: "sphere", radius: 0.1 } },
      staticSphereAtAngle(0.3),
    ], [{ bodyIdA: "bad-node", bodyIdB: "static-sphere" }])).toThrow(/nodeIndex/);
    expect(() => runSweepCollision(trajectory, bodies, [TIP], { touchEpsilon: -1 })).toThrow();
  });

  it("同场景双跑报告逐位一致(不含计时)", () => {
    const trajectory = linearTrajectory(skeleton, 300);
    const bodies = [tipBody(), staticSphereAtAngle(Math.PI / 6)];
    const first = runSweepCollision(trajectory, bodies, [TIP]).report;
    const second = runSweepCollision(trajectory, bodies, [TIP]).report;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("姿态长度不匹配透传骨架校验错误", () => {
    const trajectory: SweepTrajectorySpec = {
      skeleton,
      startTimeSeconds: 0,
      endTimeSeconds: 1,
      sampleCount: 10,
      poseAt: () => [0],
    };
    expect(() => runSweepCollision(trajectory, [tipBody(), staticSphereAtAngle(0.3)], [TIP])).toThrow(/姿态数组长度/);
  });
});

describe("时间扫掠 · 性能(CPU 计时)", () => {
  it("10k 步 × 10 连杆对:最坏配置(包围球恒重叠,粗筛不触发)与粗筛生效对照", { timeout: 240_000 }, () => {
    const skeleton = singleJointSkeleton();
    // 最坏配置:10 根连杆细棒(半长 0.02/0.02/0.3)沿半径 2 圆周分布,
    // 10 根静态棒在半径 2.08 —— 逐对最近间隙 ≈ 0.02..0.06 m 且包围球恒重叠
    // (棒包围球半径 ≈ 0.3007,心距 0.08 ± 0.02)→ 每步每对必进 GJK 分离态查询。
    const ringBodies: SweepBody[] = [];
    const pairs: SweepPairSpec[] = [];
    for (let k = 0; k < 10; k++) {
      const angle = (k / 10) * Math.PI * 2;
      ringBodies.push({
        bodyId: `link-${k}`,
        attach: "node",
        nodeIndex: 1,
        shape: { kind: "vertices", vertices: boxVertices(0.02, 0.02, 0.3) },
        localTransform: translationTransform([Math.cos(angle) * 2, Math.sin(angle) * 2, 0]),
      });
      ringBodies.push({
        bodyId: `fixture-${k}`,
        attach: "static",
        shape: { kind: "vertices", vertices: boxVertices(0.02, 0.02, 0.3) },
        transform: translationTransform([Math.cos(angle) * 2.08, Math.sin(angle) * 2.08, 0]),
      });
      pairs.push({ bodyIdA: `link-${k}`, bodyIdB: `fixture-${k}` });
    }
    const worstTrajectory: SweepTrajectorySpec = {
      skeleton,
      startTimeSeconds: 0,
      endTimeSeconds: 1,
      sampleCount: 10_000,
      poseAt: (seconds: number) => [0, 0.01 * Math.sin(2 * Math.PI * seconds)],
    };
    const worst = runSweepCollision(worstTrajectory, ringBodies, pairs);
    // 粗筛恒不触发:窄相位查询 = 步数 × 对数。
    expect(worst.report.meta.gjkQueries).toBe(10_000 * 10);
    expect(worst.report.pairs.every(pair => pair.firstCollision === undefined)).toBe(true);
    expect(worst.report.pairs.every(pair => pair.minDistance > 0 && pair.minDistance < 0.1)).toBe(true);

    // 粗筛生效对照:同一骨架 10k 步,10 个连杆球沿 +x 排开(r = 1..3.7),
    // 工件球在 (5,0,0),θ = 0.3·t 单调上行。球-球的包围球下界精确(= 真实距离),
    // 距离随 θ 严格增 → 首样本取得最小间距后其余样本全部被剪枝。
    const cullBodies: SweepBody[] = [];
    const cullPairs: SweepPairSpec[] = [];
    for (let k = 0; k < 10; k++) {
      cullBodies.push({
        bodyId: `arm-${k}`,
        attach: "node",
        nodeIndex: 1,
        shape: { kind: "sphere", radius: 0.1 },
        localTransform: translationTransform([1 + k * 0.3, 0, 0]),
      });
      cullPairs.push({ bodyIdA: `arm-${k}`, bodyIdB: "workpiece-ball" });
    }
    cullBodies.push({
      bodyId: "workpiece-ball",
      attach: "static",
      shape: { kind: "sphere", radius: 0.05 },
      transform: translationTransform([5, 0, 0]),
    });
    const cullTrajectory: SweepTrajectorySpec = {
      skeleton,
      startTimeSeconds: 0,
      endTimeSeconds: 1,
      sampleCount: 10_000,
      poseAt: (seconds: number) => [0, 0.3 * seconds],
    };
    const culled = runSweepCollision(cullTrajectory, cullBodies, cullPairs);

    const evidenceDir = resolve(process.cwd(), "../../test-output/n10-sweep");
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(resolve(evidenceDir, "perf.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      worstCase: {
        description: "10k 步 × 10 对,连杆细棒 vs 静态细棒,包围球恒重叠(粗筛不触发),分离态 GJK",
        sampleCount: 10_000,
        pairCount: 10,
        gjkQueries: worst.report.meta.gjkQueries,
        elapsedMs: worst.elapsedMs,
        perQueryUs: (worst.elapsedMs * 1000) / worst.report.meta.gjkQueries,
        minDistance: worst.report.pairs.map(pair => pair.minDistance),
      },
      sphereCulled: {
        description: "同一骨架 10k 步 × 10 对,距离单调增(首样本后全部被球下界剪枝)",
        sampleCount: 10_000,
        pairCount: 10,
        gjkQueries: culled.report.meta.gjkQueries,
        sphereCulledSamples: culled.report.meta.sphereCulledSamples,
        elapsedMs: culled.elapsedMs,
      },
      environment: { platform: process.platform, node: process.version },
    }, null, 2));
    // 合理上界守门(实测值以 perf.json 为准;10 万次 GJK 分离查询应远低于 60 s)。
    expect(worst.elapsedMs).toBeLessThan(60_000);
    // 剪枝对照:球-球下界精确,每对仅首样本跑 GJK,其余 9999 样本全剪枝。
    expect(culled.report.meta.gjkQueries).toBe(10);
    expect(culled.report.meta.sphereCulledSamples).toBe(10 * 9_999);
    expect(culled.report.pairs.every(pair => pair.minDistance > 0)).toBe(true);
    expect(culled.elapsedMs).toBeLessThan(worst.elapsedMs);
  });
});

function boxVertices(hx: number, hy: number, hz: number): number[] {
  return [
    -hx, -hy, -hz, hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz,
    -hx, -hy, hz, hx, -hy, hz, -hx, hy, hz, hx, hy, hz,
  ];
}
