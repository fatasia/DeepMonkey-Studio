import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { closestPointsBetweenObjects, cachedGeometryBvh } from "./analysis";
import { translationTransform } from "./convexDistance";
import {
  boxShapeFromHalfExtents,
  capsuleProxyShape,
  formatMaintenanceClearanceReport,
  humanProxyBoxShape,
  pathTransformAt,
  runMaintenanceClearanceSweep,
  sceneMeshConvexShape,
  validateMaintenancePath,
  type MaintenanceClearanceReport,
  type MaintenanceClearanceSpec,
} from "./maintenanceSweep";

/**
 * E4 维护净空扫掠聚焦测试:路径驱动运动体(人体代理/工具/拆卸件)复用 N10
 * 采样/球粗筛/GJK/二分机器的解析对拍,与 BVH 复用证明(同一场景 sweep 前后
 * BVH 不重建)。几何均为轴对齐/解析可解配置。
 */

function straightPath(
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  durationSeconds = 1,
  headingRadians = 0,
): Parameters<typeof runMaintenanceClearanceSweep>[0]["path"] {
  return {
    waypoints: [
      { timeSeconds: 0, position: from, headingRadians },
      { timeSeconds: durationSeconds, position: to, headingRadians },
    ],
  };
}

describe("解析对拍 · 人体代理过道", () => {
  it("盒代理 vs 柱:侧向净空恒 0.4 m,红线 0.45 判违规、0.35 判达标", () => {
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [6, 0, 0]),
      movers: [{ bodyId: "human", shape: humanProxyBoxShape({ widthMetres: 0.5, depthMetres: 0.6, heightMetres: 1.7 }) }],
      obstacles: [
        { bodyId: "pillar", shape: boxShapeFromHalfExtents(0.3, 0.3, 1.2), transform: translationTransform([3, 1.0, 1.2]) },
      ],
      sampleCount: 400,
      defaultRequiredClearanceMetres: 0.45,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    expect(report.pairs).toHaveLength(1);
    const pair = report.pairs[0]!;
    // 侧向:y 方向净空 = 柱面 0.7 − 人体面 0.3 = 0.4,在 x 投影重叠窗口内恒定。
    expect(pair.minClearanceMetres).toBeCloseTo(0.4, 6);
    // x 重叠窗口:path.x ∈ [2.45, 3.55] → t ∈ [0.4083, 0.5917]。
    expect(pair.minClearanceAtSeconds).toBeGreaterThan(0.4);
    expect(pair.minClearanceAtSeconds).toBeLessThan(0.6);
    expect(pair.collided).toBe(false);
    expect(pair.violated).toBe(true);
    expect(report.summary.pass).toBe(false);
    expect(report.summary.violatedPairCount).toBe(1);

    const relaxed: MaintenanceClearanceSpec = { ...spec, defaultRequiredClearanceMetres: 0.35 };
    const { report: relaxedReport } = runMaintenanceClearanceSweep(relaxed);
    expect(relaxedReport.pairs[0]!.violated).toBe(false);
    expect(relaxedReport.summary.pass).toBe(true);
  });

  it("航向 45°: footprint 对角半宽使净空收窄到 0.7 − 0.75·√2/2", () => {
    const heading = Math.PI / 4;
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [4, 0, 0], 1, heading),
      movers: [{ bodyId: "human-45", shape: humanProxyBoxShape({ widthMetres: 0.5, depthMetres: 1.0, heightMetres: 1.7 }) }],
      obstacles: [
        { bodyId: "pillar-45", shape: boxShapeFromHalfExtents(0.3, 0.3, 2), transform: translationTransform([2, 1.0, 0]) },
      ],
      sampleCount: 400,
      defaultRequiredClearanceMetres: 0.2,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    const pair = report.pairs[0]!;
    const expected = 0.7 - 0.75 * Math.SQRT1_2;
    expect(pair.minClearanceMetres).toBeGreaterThan(expected - 1e-5);
    expect(pair.minClearanceMetres).toBeLessThan(expected + 1e-5);
    expect(pair.violated).toBe(true);
    expect(pair.collided).toBe(false);
  });});

describe("解析对拍 · 工具球撞墙", () => {
  it("碰撞区间 [0.3, 0.9] 与解析一致(±1e-4),firstCollision 存在", () => {
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [2, 0, 0]),
      movers: [{ bodyId: "tool-ball", shape: { kind: "sphere", radius: 0.1 } }],
      obstacles: [
        { bodyId: "wall", shape: boxShapeFromHalfExtents(0.5, 2, 2), transform: translationTransform([1.2, 0, 0]) },
      ],
      sampleCount: 2000,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    const pair = report.pairs[0]!;
    expect(pair.collided).toBe(true);
    expect(pair.collisionIntervals).toHaveLength(1);
    const interval = pair.collisionIntervals[0]!;
    // 球面 2t ± 0.1 vs 墙面 [0.7, 1.7]:进入 2t−0.1=0.7 → t=0.3;离开 2t+0.1=1.7 → t=0.9。
    expect(Math.abs(interval.enterSeconds - 0.3)).toBeLessThan(1e-4);
    expect(Math.abs(interval.exitSeconds - 0.9)).toBeLessThan(1e-4);
    expect(pair.firstCollision).toBeDefined();
    expect(Math.abs(pair.firstCollision!.timeSeconds - 0.3)).toBeLessThan(1e-4);
    expect(pair.minClearanceMetres).toBe(0);
  });
});

describe("路径插值", () => {
  it("段内线性位置 + 航向最短弧插值;区间外夹取端点;跨 ±π 取短弧", () => {
    const path = {
      waypoints: [
        { timeSeconds: 0, position: [0, 0, 0] as const, headingRadians: 0 },
        { timeSeconds: 2, position: [2, 0, 2] as const, headingRadians: Math.PI },
      ],
    };
    const mid = pathTransformAt(path, 1);
    expect(mid.translation[0]).toBeCloseTo(1, 12);
    expect(mid.translation[2]).toBeCloseTo(1, 12);
    // 航向中点 = π/2(绕 +Z):四元数 (0, 0, sin(π/4), cos(π/4))。
    expect(mid.rotationQuaternion[2]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(mid.rotationQuaternion[3]).toBeCloseTo(Math.SQRT1_2, 12);
    const clamped = pathTransformAt(path, 5);
    expect(clamped.translation[0]).toBe(2);
    expect(clamped.translation[2]).toBe(2);

    // 3 rad → −3 rad 的最短弧跨 π:中点航向 ≈ π。
    const wrapPath = {
      waypoints: [
        { timeSeconds: 0, position: [0, 0, 0] as const, headingRadians: 3 },
        { timeSeconds: 2, position: [0, 0, 0] as const, headingRadians: -3 },
      ],
    };
    const wrapped = pathTransformAt(wrapPath, 1);
    expect(wrapped.rotationQuaternion[2]).toBeCloseTo(1, 9);
    expect(wrapped.rotationQuaternion[3]).toBeCloseTo(0, 9);
  });

  it("非法路径显式报错", () => {
    expect(() => validateMaintenancePath({ waypoints: [{ timeSeconds: 0, position: [0, 0, 0] }] })).toThrow(/2 个路标/);
    expect(() => validateMaintenancePath({
      waypoints: [
        { timeSeconds: 1, position: [0, 0, 0] },
        { timeSeconds: 1, position: [1, 0, 0] },
      ],
    })).toThrow(/严格递增/);
    expect(() => validateMaintenancePath({
      waypoints: [
        { timeSeconds: 0, position: [0, 0] as unknown as readonly [number, number, number] },
        { timeSeconds: 1, position: [1, 0, 0] },
      ],
    })).toThrow(/三元组/);
    expect(() => validateMaintenancePath({
      waypoints: [
        { timeSeconds: Number.NaN, position: [0, 0, 0] },
        { timeSeconds: 1, position: [1, 0, 0] },
      ],
    })).toThrow(/有限/);
  });
});

describe("拆卸件 · 网格凸近似", () => {
  it("BoxGeometry 顶点集进入 GJK:抽取净空解析 0.15 m;近似缓存复用、参数变更重算", () => {
    const partGeometry = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const partShape = sceneMeshConvexShape(partGeometry);
    // 缓存复用:同几何同参数返回同一实例(跨采样/跨运行不重算)。
    expect(sceneMeshConvexShape(partGeometry)).toBe(partShape);
    // 参数变更显式重算,不污染缓存。
    const coarse = sceneMeshConvexShape(partGeometry, { maxVertices: 8 });
    expect(coarse).not.toBe(partShape);
    expect(coarse.kind === "vertices" && coarse.vertices.length).toBe(24);
    expect(partShape.kind === "vertices" && partShape.vertices.length).toBe(72);

    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0.5], [0, 0, 3]),
      movers: [{ bodyId: "part", shape: partShape }],
      obstacles: [
        { bodyId: "machine", shape: boxShapeFromHalfExtents(1.0, 0.2, 0.3), transform: translationTransform([0, 0.45, 0.5]) },
      ],
      sampleCount: 500,
      defaultRequiredClearanceMetres: 0.1,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    const pair = report.pairs[0]!;
    // 侧向 y:机身面 0.25 − 件半宽 0.1 = 0.15;z 投影重叠窗口 path.z ∈ [0.4, 0.9] 内取得。
    expect(pair.minClearanceMetres).toBeCloseTo(0.15, 6);
    expect(pair.minClearanceAtSeconds).toBeGreaterThanOrEqual(0);
    expect(pair.minClearanceAtSeconds).toBeLessThan(0.16);
    expect(pair.violated).toBe(false);
  });
});

describe("BVH 复用证明 · 同一场景 sweep 前后 BVH 不重建", () => {
  it("MeshBVH 身份在两次扫掠与静态复核前后不变;凸近似缓存同源", () => {
    const obstacleGeometry = new THREE.BoxGeometry(1, 1, 1);
    const moverGeometry = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    const obstacleMesh = new THREE.Mesh(obstacleGeometry);
    obstacleMesh.position.set(3, 0, 0);
    const moverMesh = new THREE.Mesh(moverGeometry);
    moverMesh.position.set(1.5, 0, 0);

    // 静态复核先建立 BVH(analysis.ts bvhCache,WeakMap 按几何缓存)。
    const staticBefore = closestPointsBetweenObjects(moverMesh, obstacleMesh);
    expect(staticBefore?.distance).toBeCloseTo(0.75, 6);
    const obstacleBvhBefore = cachedGeometryBvh(obstacleGeometry);
    const moverBvhBefore = cachedGeometryBvh(moverGeometry);

    // 扫掠:人体代理穿过网格凸近似(同一几何)→ 碰撞检出;两轮。
    const obstacleShape = sceneMeshConvexShape(obstacleGeometry);
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [6, 0, 0]),
      movers: [{ bodyId: "human-bvh", shape: humanProxyBoxShape({ widthMetres: 0.5, depthMetres: 0.6, heightMetres: 1.7 }) }],
      obstacles: [{ bodyId: "mesh-block", shape: obstacleShape }],
      sampleCount: 1000,
    };
    const firstRun = runMaintenanceClearanceSweep(spec);
    const secondRun = runMaintenanceClearanceSweep(spec);
    expect(firstRun.report.pairs[0]!.collided).toBe(true);
    // 双跑逐位一致(确定性),且扫掠消耗的是缓存近似(同一实例)。
    expect(JSON.stringify(firstRun.report)).toBe(JSON.stringify(secondRun.report));
    expect(sceneMeshConvexShape(obstacleGeometry)).toBe(obstacleShape);

    // BVH 不重建:身份不变 + 结果一致。
    expect(cachedGeometryBvh(obstacleGeometry)).toBe(obstacleBvhBefore);
    expect(cachedGeometryBvh(moverGeometry)).toBe(moverBvhBefore);
    const staticAfter = closestPointsBetweenObjects(moverMesh, obstacleMesh);
    expect(staticAfter?.distance).toBeCloseTo(staticBefore?.distance ?? Number.NaN, 12);
  });
});

describe("与 Rapier castShape 交叉验证(沿 N10 先例)", () => {
  it("球 vs 盒:最小净空 0.2 m 与 Rapier 形状投射 toi 一致(<1e-6)", async () => {
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [2, 0, 1]),
      movers: [{ bodyId: "probe-ball", shape: { kind: "sphere", radius: 0.1 } }],
      obstacles: [
        { bodyId: "rapier-box", shape: boxShapeFromHalfExtents(0.3, 0.3, 0.3), transform: translationTransform([1, 0.6, 0.5]) },
      ],
      sampleCount: 2000,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    const pair = report.pairs[0]!;
    // t∈[0.35,0.65] 段球心 x/z 均投影进盒内,唯一分离轴 y:净空 = 0.3 − 0.1 = 0.2。
    expect(pair.minClearanceMetres).toBeCloseTo(0.2, 6);
    expect(pair.collided).toBe(false);

    // Rapier 侧:球心放在 minClearanceAtSeconds 时刻位形,沿"球心→盒面最近点"方向 castShape;
    // |v| = 1 时 toi 即球面到盒面的净空。
    const pose = pathTransformAt(spec.path, pair.minClearanceAtSeconds);
    const boxMin = [1 - 0.3, 0.6 - 0.3, 0.5 - 0.3];
    const boxMax = [1 + 0.3, 0.6 + 0.3, 0.5 + 0.3];
    const center = pose.translation;
    const closest = center.map((value, axis) => Math.min(boxMax[axis]!, Math.max(boxMin[axis]!, value)));
    const direction = closest.map((value, axis) => value - center[axis]!);
    const length = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
    expect(length).toBeGreaterThan(0);

    const rapier = (await import("@dimforge/rapier3d-compat")).default;
    await rapier.init();
    const world = new rapier.World({ x: 0, y: 0, z: 0 });
    const body = world.createRigidBody(rapier.RigidBodyDesc.fixed().setTranslation(1, 0.6, 0.5));
    world.createCollider(rapier.ColliderDesc.cuboid(0.3, 0.3, 0.3), body);
    world.step();
    const hit = world.castShape(
      { x: center[0]!, y: center[1]!, z: center[2]! },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: direction[0]! / length, y: direction[1]! / length, z: direction[2]! / length },
      new rapier.Ball(0.1),
      0,
      10,
      true,
    );
    expect(hit).not.toBeNull();
    if (hit) {
      expect(Math.abs(hit.time_of_impact - pair.minClearanceMetres)).toBeLessThan(1e-6);
    }
    world.free();
  });
});

describe("校验与确定性", () => {
  const baseSpec: MaintenanceClearanceSpec = {
    path: straightPath([0, 0, 0], [2, 0, 0]),
    movers: [{ bodyId: "m", shape: { kind: "sphere", radius: 0.1 } }],
    obstacles: [{ bodyId: "o", shape: boxShapeFromHalfExtents(0.5, 0.5, 0.5), transform: translationTransform([2, 0, 0]) }],
    sampleCount: 100,
  };

  it("非法输入显式报错", () => {
    expect(() => runMaintenanceClearanceSweep({ ...baseSpec, movers: [] })).toThrow(/运动体集合不能为空/);
    expect(() => runMaintenanceClearanceSweep({ ...baseSpec, obstacles: [] })).toThrow(/障碍集合不能为空/);
    expect(() => runMaintenanceClearanceSweep({ ...baseSpec, defaultRequiredClearanceMetres: -1 })).toThrow(/≥ 0/);
    expect(() => runMaintenanceClearanceSweep({
      ...baseSpec,
      movers: [{ bodyId: "m", shape: { kind: "sphere", radius: 0.1 }, requiredClearanceMetres: -0.5 }],
    })).toThrow(/≥ 0/);
    expect(() => runMaintenanceClearanceSweep({ ...baseSpec, sampleCount: 1 })).toThrow(/sampleCount/);
    expect(() => runMaintenanceClearanceSweep({
      ...baseSpec,
      movers: [{ bodyId: "m", shape: { kind: "sphere", radius: 0.1 }, localOffset: { translation: [Number.NaN, 0, 0], rotationQuaternion: [0, 0, 0, 1] } }],
    })).toThrow(/有限/);
  });

  it("同场景双跑报告逐位一致(不含计时)", () => {
    const first = runMaintenanceClearanceSweep({ ...baseSpec, defaultRequiredClearanceMetres: 0.3 }).report;
    const second = runMaintenanceClearanceSweep({ ...baseSpec, defaultRequiredClearanceMetres: 0.3 }).report;
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("胶囊代理(圆柱保守包络)与人读报告输出", () => {
    const spec: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [3, 0, 0]),
      movers: [{ bodyId: "human-capsule", shape: capsuleProxyShape({ radiusMetres: 0.25, heightMetres: 1.7 }) }],
      obstacles: [
        { bodyId: "rail", shape: boxShapeFromHalfExtents(0.2, 0.2, 1.5), transform: translationTransform([1.5, 0.7, 0.75]) },
      ],
      sampleCount: 300,
      defaultRequiredClearanceMetres: 0.2,
    };
    const { report } = runMaintenanceClearanceSweep(spec);
    // 圆柱半径 0.25 vs 栏杆面 0.5:净空 = 0.25(圆柱 ⊇ 胶囊,保守)。
    expect(report.pairs[0]!.minClearanceMetres).toBeCloseTo(0.25, 6);
    expect(report.summary.pass).toBe(true);
    const text = formatMaintenanceClearanceReport(report);
    expect(text).toContain("维护净空扫掠报告");
    expect(text).toContain("[达标]");
    expect(text).toContain("结论:通过");
  });
});

describe("Node 场景 · 过道检修与拆卸件抽取(证据落盘)", () => {
  it("人形代理过道(双柱+内伸机柜)与拆卸件上架抽取:净空报告可读输出", { timeout: 60_000 }, () => {
    // 场景一:人形代理(0.6 宽 × 0.8 厚 × 1.75 高)沿 10 m 过道 8 s,
    // 左右立柱 + 内伸机柜;默认红线 0.5 m。
    const corridor: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0], [10, 0, 0], 8),
      movers: [{ bodyId: "human-proxy", shape: humanProxyBoxShape({ widthMetres: 0.6, depthMetres: 0.8, heightMetres: 1.75 }) }],
      obstacles: [
        { bodyId: "pillar-left", shape: boxShapeFromHalfExtents(0.2, 0.2, 1.5), transform: translationTransform([4, -1.2, 1.5]) },
        { bodyId: "pillar-right", shape: boxShapeFromHalfExtents(0.2, 0.2, 1.5), transform: translationTransform([6, 1.2, 1.5]) },
        { bodyId: "machine-intrusion", shape: boxShapeFromHalfExtents(0.5, 0.7, 0.6), transform: translationTransform([5, 0.55, 0.6]) },
      ],
      sampleCount: 1600,
      defaultRequiredClearanceMetres: 0.5,
    };
    const corridorResult = runMaintenanceClearanceSweep(corridor);
    const byBody = (report: MaintenanceClearanceReport, bodyIdB: string) =>
      report.pairs.find(pair => pair.bodyIdB === bodyIdB)!;
    // 立柱:净空 = 1.0 − 0.4 = 0.6 ≥ 0.5 → 达标;机柜侵入过道 → 碰撞。
    expect(byBody(corridorResult.report, "pillar-left").minClearanceMetres).toBeCloseTo(0.6, 6);
    expect(byBody(corridorResult.report, "pillar-right").minClearanceMetres).toBeCloseTo(0.6, 6);
    expect(byBody(corridorResult.report, "machine-intrusion").collided).toBe(true);
    expect(corridorResult.report.summary.pass).toBe(false);

    // 场景二:0.3³ 拆卸件从机柜沿竖直路径上架抽取,途经侧置货架;红线 0.2 m。
    const partGeometry = new THREE.BoxGeometry(0.3, 0.3, 0.3);
    const extraction: MaintenanceClearanceSpec = {
      path: straightPath([0, 0, 0.6], [0, 0, 2.6], 3),
      movers: [{ bodyId: "disassembly-part", shape: sceneMeshConvexShape(partGeometry) }],
      obstacles: [
        { bodyId: "shelf", shape: boxShapeFromHalfExtents(0.1, 1.0, 0.2), transform: translationTransform([0.5, 0, 1.4]) },
      ],
      sampleCount: 900,
      defaultRequiredClearanceMetres: 0.2,
    };
    const extractionResult = runMaintenanceClearanceSweep(extraction);
    // 货架面 x=0.4 − 件半宽 0.15 = 0.25 ≥ 0.2 → 达标。
    expect(extractionResult.report.pairs[0]!.minClearanceMetres).toBeCloseTo(0.25, 6);
    expect(extractionResult.report.summary.pass).toBe(true);

    // 证据落盘:机器可读 JSON + 人读文本。
    const evidenceDir = resolve(process.cwd(), "../../test-output/e4-sweep-20261002");
    mkdirSync(evidenceDir, { recursive: true });
    const corridorText = `【场景一 · 人形代理过道】\n${formatMaintenanceClearanceReport(corridorResult.report)}`;
    const extractionText = `【场景二 · 拆卸件上架抽取】\n${formatMaintenanceClearanceReport(extractionResult.report)}`;
    const text = `${corridorText}\n\n${extractionText}\n`;
    writeFileSync(resolve(evidenceDir, "scenario-report.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      corridor: corridorResult.report,
      extraction: extractionResult.report,
    }, null, 2));
    writeFileSync(resolve(evidenceDir, "scenario-report.txt"), text);
    expect(text).toContain("[碰撞]");
    expect(text).toContain("结论:未通过");
    expect(text).toContain("结论:通过");
  });
});
