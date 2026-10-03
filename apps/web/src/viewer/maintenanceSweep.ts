/**
 * E4 维护净空扫掠:人体代理/工具/拆卸件沿路径运动的净空报告(生产入口)。
 * 复用 N10 机器,不重做碰撞数学:GJK 窄相位(convexDistance)+ 固定步长采样/
 * 对级球粗筛/状态翻转二分(robotSweepCollision 路径驱动模式,framesAt)。
 *
 * 三类运动体(路径驱动刚体,共用同一路径节点 0):
 * - 人体代理:站姿盒(humanProxyBoxShape,按外廓尺寸精确,保守性由尺寸选取保证)
 *   或垂直胶囊的保守圆柱超集(capsuleProxyShape);
 * - 工具:任意凸形状(盒/解析球/顶点集,随 localOffset 挂在路径节点上);
 * - 拆卸件:真实网格经确定性等步长顶点凸近似(sceneMeshConvexShape,
 *   WeakMap 按几何缓存——同一场景只近似一次,跨采样/跨运行复用,不重建)。
 *
 * 与 BVH 层的组合(复用而非重建):凹体网格的逐点精确净空复核走 analysis.ts
 * 的 MeshBVH 缓存(cachedGeometryBvh / closestPointsBetweenObjects),在报告的
 * 临界时刻(minClearanceAtSeconds / collisionIntervals 端点)按需调用;本模块
 * 不构建任何 BVH。凸近似是凹体的保守包络:报告的净空只低估不高估。
 *
 * 口径与离散化极限见 docs/specs/e4-sweep-20261002.md。
 */

import * as THREE from "three";
import {
  translationTransform,
  type ConvexShape,
  type RigidTransform,
} from "./convexDistance";
import {
  crossPairs,
  runSweepCollision,
  type SweepAttachedBody,
  type SweepBody,
  type SweepCollisionOptions,
  type SweepCollisionReport,
  type SweepFramesTrajectorySpec,
  type SweepPairResult,
  type SweepStaticBody,
} from "./robotSweepCollision";

// ─────────────────────────── 路径 ───────────────────────────

/** 路径路标:时刻 + 世界系位置 + 航向角(绕 +Z,弧度,缺省 0)。 */
export interface MaintenancePathWaypoint {
  timeSeconds: number;
  position: readonly [number, number, number];
  headingRadians?: number;
}

/** 维护路径:路标序列(≥2,时刻严格递增);段内位置线性插值、航向最短弧插值,区间外夹取端点。 */
export interface MaintenancePathSpec {
  waypoints: readonly MaintenancePathWaypoint[];
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数值,得到 ${value}`);
}

/** 归一到 (−π, π]。 */
function wrapToPi(angle: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = angle % twoPi;
  if (wrapped > Math.PI) return wrapped - twoPi;
  if (wrapped <= -Math.PI) return wrapped + twoPi;
  return wrapped;
}

/** 路径结构校验:路标数、时刻严格递增、分量有限。通过则原样返回(便于复用)。 */
export function validateMaintenancePath(path: MaintenancePathSpec): MaintenancePathSpec {
  if (!path || !Array.isArray(path.waypoints) || path.waypoints.length < 2) {
    throw new Error("维护路径至少需要 2 个路标");
  }
  for (let index = 0; index < path.waypoints.length; index++) {
    const waypoint = path.waypoints[index]!;
    if (!waypoint || !Number.isFinite(waypoint.timeSeconds)) {
      throw new Error(`路径路标 ${index} 的 timeSeconds 必须是有限数值`);
    }
    if (!Array.isArray(waypoint.position) || waypoint.position.length !== 3) {
      throw new Error(`路径路标 ${index} 的 position 必须是 [x,y,z] 三元组`);
    }
    assertFinite(waypoint.position[0]!, `路径路标 ${index} 的 position.x`);
    assertFinite(waypoint.position[1]!, `路径路标 ${index} 的 position.y`);
    assertFinite(waypoint.position[2]!, `路径路标 ${index} 的 position.z`);
    if (waypoint.headingRadians !== undefined) assertFinite(waypoint.headingRadians, `路径路标 ${index} 的 headingRadians`);
    if (index > 0 && !(waypoint.timeSeconds > path.waypoints[index - 1]!.timeSeconds)) {
      throw new Error(`路径路标时刻必须严格递增:路标 ${index - 1}(${path.waypoints[index - 1]!.timeSeconds})≥ 路标 ${index}(${waypoint.timeSeconds})`);
    }
  }
  return path;
}

/** 时刻 → 路径节点变换(位置线性插值 + 航向最短弧插值;区间外夹取端点)。纯函数。 */
export function pathTransformAt(path: MaintenancePathSpec, seconds: number): RigidTransform {
  assertFinite(seconds, "路径时刻 seconds");
  validateMaintenancePath(path);
  const waypoints = path.waypoints;
  const first = waypoints[0]!;
  const last = waypoints[waypoints.length - 1]!;
  if (seconds <= first.timeSeconds) return waypointTransform(first);
  if (seconds >= last.timeSeconds) return waypointTransform(last);
  let segment = 0;
  while (segment < waypoints.length - 2 && waypoints[segment + 1]!.timeSeconds <= seconds) segment++;
  const from = waypoints[segment]!;
  const to = waypoints[segment + 1]!;
  const span = to.timeSeconds - from.timeSeconds;
  const u = span > 0 ? (seconds - from.timeSeconds) / span : 0;
  const headingDelta = wrapToPi(waypointHeading(to) - waypointHeading(from));
  return {
    translation: [
      from.position[0]! + u * (to.position[0]! - from.position[0]!),
      from.position[1]! + u * (to.position[1]! - from.position[1]!),
      from.position[2]! + u * (to.position[2]! - from.position[2]!),
    ],
    rotationQuaternion: yawQuaternion(waypointHeading(from) + u * headingDelta),
  };
}

function waypointTransform(waypoint: MaintenancePathWaypoint): RigidTransform {
  return {
    translation: [waypoint.position[0]!, waypoint.position[1]!, waypoint.position[2]!],
    rotationQuaternion: yawQuaternion(waypointHeading(waypoint)),
  };
}

function waypointHeading(waypoint: MaintenancePathWaypoint): number {
  return waypoint.headingRadians ?? 0;
}

/** 绕 +Z 航向角 → (x,y,z,w) 四元数(半角展开;引擎约定 z 轴向上,与人体代理高度轴一致)。 */
function yawQuaternion(yaw: number): [number, number, number, number] {
  const half = yaw / 2;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

/** 路径 → 扫掠轨迹(framesAt 单节点模式;节点 0 = 路径变换)。时刻窗口取路标端点。 */
export function maintenancePathTrajectory(path: MaintenancePathSpec, sampleCount: number): SweepFramesTrajectorySpec {
  validateMaintenancePath(path);
  if (!Number.isInteger(sampleCount) || sampleCount < 2) throw new Error("sampleCount 必须是 ≥2 的整数");
  const waypoints = path.waypoints;
  return {
    startTimeSeconds: waypoints[0]!.timeSeconds,
    endTimeSeconds: waypoints[waypoints.length - 1]!.timeSeconds,
    sampleCount,
    framesAt: (seconds: number) => [pathTransformAt(path, seconds)],
  };
}

// ─────────────────────────── 运动体形状 ───────────────────────────

/** 轴对齐盒(半边长,体心在原点):8 顶点精确。 */
export function boxShapeFromHalfExtents(halfX: number, halfY: number, halfZ: number): ConvexShape {
  assertFinite(halfX, "盒半边长.x"); assertFinite(halfY, "盒半边长.y"); assertFinite(halfZ, "盒半边长.z");
  if (halfX <= 0 || halfY <= 0 || halfZ <= 0) throw new Error("盒半边长必须为正");
  return {
    kind: "vertices",
    vertices: [
      -halfX, -halfY, -halfZ, halfX, -halfY, -halfZ, -halfX, halfY, -halfZ, halfX, halfY, -halfZ,
      -halfX, -halfY, halfZ, halfX, -halfY, halfZ, -halfX, halfY, halfZ, halfX, halfY, halfZ,
    ],
  };
}

/**
 * 人体站姿盒代理:外廓(宽 x × 厚 y × 高 z),原点在脚底中心,顶点覆盖 [0,h]。
 * 盒是精确凸体(GJK 无近似误差);保守性由外廓尺寸 ≥ 人体实际外廓保证。
 */
export function humanProxyBoxShape(spec: { widthMetres: number; depthMetres: number; heightMetres: number }): ConvexShape {
  assertFinite(spec.widthMetres, "人体代理宽度");
  assertFinite(spec.depthMetres, "人体代理厚度");
  assertFinite(spec.heightMetres, "人体代理高度");
  if (spec.widthMetres <= 0 || spec.depthMetres <= 0 || spec.heightMetres <= 0) throw new Error("人体代理外廓尺寸必须为正");
  const halfX = spec.widthMetres / 2;
  const halfY = spec.depthMetres / 2;
  const halfZ = spec.heightMetres / 2;
  return {
    kind: "vertices",
    vertices: [
      -halfX, -halfY, 0, halfX, -halfY, 0, -halfX, halfY, 0, halfX, halfY, 0,
      -halfX, -halfY, spec.heightMetres, halfX, -halfY, spec.heightMetres,
      -halfX, halfY, spec.heightMetres, halfX, halfY, spec.heightMetres,
    ],
  };
}

/**
 * 垂直胶囊代理(总高含上下半球)的保守顶点集:圆柱包络(半径 r、高 h)严格包含
 * 胶囊(r, h),因此 GJK 净空只低估不高估(安全方向);段数缺省 16,角向弦高误差
 * ≤ r·(1 − cos(π/16)) 内含在"圆柱 ⊇ 胶囊"的包络里,不另引入欠近似。
 */
export function capsuleProxyShape(spec: { radiusMetres: number; heightMetres: number; segments?: number }): ConvexShape {
  assertFinite(spec.radiusMetres, "胶囊代理半径");
  assertFinite(spec.heightMetres, "胶囊代理高度");
  if (spec.radiusMetres <= 0 || spec.heightMetres <= 0) throw new Error("胶囊代理半径/高度必须为正");
  const segments = spec.segments ?? 16;
  if (!Number.isInteger(segments) || segments < 3 || segments > 256) throw new Error("胶囊代理段数必须是 3..256 的整数");
  const vertices: number[] = [];
  for (let k = 0; k < segments; k++) {
    const angle = (k / segments) * 2 * Math.PI;
    vertices.push(Math.cos(angle) * spec.radiusMetres, Math.sin(angle) * spec.radiusMetres, 0);
  }
  for (let k = 0; k < segments; k++) {
    const angle = (k / segments) * 2 * Math.PI;
    vertices.push(Math.cos(angle) * spec.radiusMetres, Math.sin(angle) * spec.radiusMetres, spec.heightMetres);
  }
  return { kind: "vertices", vertices };
}

// ─────────────────────── 拆卸件:网格 → 凸形状(缓存) ───────────────────────

const partShapeCache = new WeakMap<THREE.BufferGeometry, { shape: ConvexShape; maxVertices: number }>();

export interface SceneMeshConvexOptions {
  /** 顶点数上限(确定性等步长抽取);缺省 512。 */
  maxVertices?: number;
}

/**
 * 真实网格 → GJK 凸顶点集(拆卸件/场景障碍进入扫掠的桥)。
 * 确定性等步长抽取(升序索引,无随机源);凹体的顶点凸包 ⊇ 本体 → 保守。
 * WeakMap 按几何缓存:同一场景只近似一次,跨采样/跨运行复用;maxVertices 变更时重算。
 */
export function sceneMeshConvexShape(geometry: THREE.BufferGeometry, options: SceneMeshConvexOptions = {}): ConvexShape {
  if (!geometry || !geometry.attributes?.position) throw new Error("sceneMeshConvexShape 需要带 position 属性的 BufferGeometry");
  const maxVertices = options.maxVertices ?? 512;
  if (!Number.isInteger(maxVertices) || maxVertices < 4 || maxVertices > 1_000_000) {
    throw new Error(`maxVertices 必须是 4..1000000 的整数,得到 ${String(maxVertices)}`);
  }
  const cached = partShapeCache.get(geometry);
  if (cached && cached.maxVertices === maxVertices) return cached.shape;
  const attribute = geometry.attributes.position as THREE.BufferAttribute;
  const count = attribute.count;
  if (!Number.isInteger(count) || count < 3) throw new Error("网格顶点数不足(至少 3 个)");
  const stride = Math.max(1, Math.ceil(count / maxVertices));
  const vertices: number[] = [];
  for (let index = 0; index < count; index += stride) {
    const x = attribute.getX(index);
    const y = attribute.getY(index);
    const z = attribute.getZ(index);
    assertFinite(x, `网格顶点 ${index}.x`); assertFinite(y, `网格顶点 ${index}.y`); assertFinite(z, `网格顶点 ${index}.z`);
    vertices.push(x, y, z);
  }
  const shape: ConvexShape = { kind: "vertices", vertices };
  partShapeCache.set(geometry, { shape, maxVertices });
  return shape;
}

// ─────────────────────────── 净空扫掠入口 ───────────────────────────

/** 运动体:随路径节点 0 运动;localOffset 为节点系内固定偏移(如工具握把→体心)。 */
export interface MaintenanceMoverSpec {
  bodyId: string;
  shape: ConvexShape;
  localOffset?: RigidTransform;
  /** 本体净空红线(米);缺省用场景默认。 */
  requiredClearanceMetres?: number;
}

/** 静态障碍:凸形状 + 世界变换(缺省恒等)。 */
export interface MaintenanceObstacleSpec {
  bodyId: string;
  shape: ConvexShape;
  transform?: RigidTransform;
}

export interface MaintenanceClearanceSpec {
  path: MaintenancePathSpec;
  movers: readonly MaintenanceMoverSpec[];
  obstacles: readonly MaintenanceObstacleSpec[];
  /** 采样数(含两端点),≥2。 */
  sampleCount: number;
  /** 场景默认净空红线(米);缺省 0(只报碰撞)。 */
  defaultRequiredClearanceMetres?: number;
  /** 透传扫掠选项(touchEpsilon/二分容差等)。 */
  sweepOptions?: SweepCollisionOptions;
}

/** 单对净空判定。红线判定容差 1e-9(恰好等于红线视为达标)。 */
export interface MaintenanceClearancePair {
  bodyIdA: string;
  bodyIdB: string;
  /** 扫掠全程最小净空(米;发生碰撞则为 0)。 */
  minClearanceMetres: number;
  minClearanceAtSeconds: number;
  minClearancePointA?: readonly [number, number, number];
  minClearancePointB?: readonly [number, number, number];
  requiredClearanceMetres: number;
  /** 扫掠全程发生过碰撞(含切触)。 */
  collided: boolean;
  /** 最小净空低于红线(非碰撞的净空不足)。 */
  violated: boolean;
  firstCollision?: SweepPairResult["firstCollision"];
  collisionIntervals: SweepPairResult["collisionIntervals"];
}

export interface MaintenanceClearanceReport {
  startTimeSeconds: number;
  endTimeSeconds: number;
  sampleCount: number;
  moverCount: number;
  obstacleCount: number;
  defaultRequiredClearanceMetres: number;
  pairs: MaintenanceClearancePair[];
  summary: {
    /** 全部对中的最小净空;全部碰撞时为 0。 */
    worstClearanceMetres: number;
    worstPair?: { bodyIdA: string; bodyIdB: string };
    collidedPairCount: number;
    violatedPairCount: number;
    /** 无碰撞且无红线违规。 */
    pass: boolean;
  };
  meta: SweepCollisionReport["meta"];
}

const RED_LINE_EPSILON = 1e-9;

/**
 * 运行维护净空扫掠:路径 + 运动体 + 障碍 → 净空报告。
 * 内部全部委托 runSweepCollision 路径模式(采样/球粗筛/GJK/二分复用),本层只做
 * 形状装配与红线判定;同输入双跑 report 逐位一致(计时单列)。
 */
export function runMaintenanceClearanceSweep(
  spec: MaintenanceClearanceSpec,
): { report: MaintenanceClearanceReport; elapsedMs: number } {
  if (!spec) throw new Error("维护净空规格无效");
  validateMaintenancePath(spec.path);
  if (!Array.isArray(spec.movers) || spec.movers.length === 0) throw new Error("运动体集合不能为空");
  if (!Array.isArray(spec.obstacles) || spec.obstacles.length === 0) throw new Error("障碍集合不能为空");
  const defaultRequired = spec.defaultRequiredClearanceMetres ?? 0;
  assertFinite(defaultRequired, "defaultRequiredClearanceMetres");
  if (defaultRequired < 0) throw new Error("defaultRequiredClearanceMetres 必须 ≥ 0");
  for (const mover of spec.movers) {
    if (mover.requiredClearanceMetres !== undefined) {
      assertFinite(mover.requiredClearanceMetres, `运动体 ${mover.bodyId} 的 requiredClearanceMetres`);
      if (mover.requiredClearanceMetres < 0) throw new Error(`运动体 ${mover.bodyId} 的 requiredClearanceMetres 必须 ≥ 0`);
    }
  }

  const trajectory = maintenancePathTrajectory(spec.path, spec.sampleCount);
  // 路径节点 0 = 路径变换;localOffset 映射为 N10 的 localTransform(体在节点系内的固定偏移)。
  const nodeBodies: SweepAttachedBody[] = spec.movers.map(mover => ({
    bodyId: mover.bodyId,
    attach: "node",
    nodeIndex: 0,
    shape: mover.shape,
    ...(mover.localOffset ? { localTransform: mover.localOffset } : {}),
  }));
  const staticBodies: SweepStaticBody[] = spec.obstacles.map(obstacle => ({
    bodyId: obstacle.bodyId,
    attach: "static",
    shape: obstacle.shape,
    transform: obstacle.transform ?? translationTransform([0, 0, 0]),
  }));
  const bodies: SweepBody[] = [...nodeBodies, ...staticBodies];
  const pairs = crossPairs(spec.movers.map(mover => mover.bodyId), spec.obstacles.map(obstacle => obstacle.bodyId));

  const { report: sweepReport, elapsedMs } = runSweepCollision(trajectory, bodies, pairs, spec.sweepOptions);
  const requiredByMover = new Map<string, number>();
  for (const mover of spec.movers) {
    requiredByMover.set(mover.bodyId, mover.requiredClearanceMetres ?? defaultRequired);
  }

  const clearancePairs: MaintenanceClearancePair[] = sweepReport.pairs.map(pair => {
    const required = requiredByMover.get(pair.bodyIdA) ?? defaultRequired;
    const collided = pair.collisionIntervals.length > 0;
    const violated = pair.minDistance < required - RED_LINE_EPSILON;
    const clearancePair: MaintenanceClearancePair = {
      bodyIdA: pair.bodyIdA,
      bodyIdB: pair.bodyIdB,
      minClearanceMetres: pair.minDistance,
      minClearanceAtSeconds: pair.minDistanceAtSeconds,
      requiredClearanceMetres: required,
      collided,
      violated,
      collisionIntervals: pair.collisionIntervals,
    };
    if (pair.firstCollision) clearancePair.firstCollision = pair.firstCollision;
    if (pair.minDistancePointA && pair.minDistancePointB) {
      clearancePair.minClearancePointA = pair.minDistancePointA;
      clearancePair.minClearancePointB = pair.minDistancePointB;
    }
    return clearancePair;
  });

  let worst = Infinity;
  let worstPair: MaintenanceClearanceReport["summary"]["worstPair"];
  for (const pair of clearancePairs) {
    if (pair.minClearanceMetres < worst) {
      worst = pair.minClearanceMetres;
      worstPair = { bodyIdA: pair.bodyIdA, bodyIdB: pair.bodyIdB };
    }
  }
  const collidedPairCount = clearancePairs.filter(pair => pair.collided).length;
  const violatedPairCount = clearancePairs.filter(pair => pair.violated).length;

  const report: MaintenanceClearanceReport = {
    startTimeSeconds: sweepReport.startTimeSeconds,
    endTimeSeconds: sweepReport.endTimeSeconds,
    sampleCount: sweepReport.sampleCount,
    moverCount: spec.movers.length,
    obstacleCount: spec.obstacles.length,
    defaultRequiredClearanceMetres: defaultRequired,
    pairs: clearancePairs,
    summary: {
      worstClearanceMetres: worst === Infinity ? 0 : worst,
      collidedPairCount,
      violatedPairCount,
      pass: collidedPairCount === 0 && violatedPairCount === 0,
    },
    meta: sweepReport.meta,
  };
  if (worstPair) report.summary.worstPair = worstPair;
  return { report, elapsedMs };
}

// ─────────────────────────── 人读输出 ───────────────────────────

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(4)}s`;
}

function formatMetres(metres: number): string {
  return `${metres.toFixed(3)} m`;
}

/** 净空报告 → 人读文本(过道/检修评审与日志用;与报告对象同源,无额外判定)。 */
export function formatMaintenanceClearanceReport(report: MaintenanceClearanceReport): string {
  const lines: string[] = [];
  lines.push(`维护净空扫掠报告 [${formatSeconds(report.startTimeSeconds)} → ${formatSeconds(report.endTimeSeconds)}, ${report.sampleCount} 样本,${report.moverCount} 运动体 × ${report.obstacleCount} 障碍]`);
  lines.push(`默认红线 ${formatMetres(report.defaultRequiredClearanceMetres)};最差净空 ${formatMetres(report.summary.worstClearanceMetres)}` +
    (report.summary.worstPair ? `(${report.summary.worstPair.bodyIdA} ↔ ${report.summary.worstPair.bodyIdB})` : ""));
  for (const pair of report.pairs) {
    const status = pair.collided ? "碰撞" : pair.violated ? "违规" : "达标";
    lines.push(
      `  [${status}] ${pair.bodyIdA} ↔ ${pair.bodyIdB}:最小净空 ${formatMetres(pair.minClearanceMetres)} @ ${formatSeconds(pair.minClearanceAtSeconds)}` +
      `(红线 ${formatMetres(pair.requiredClearanceMetres)})`,
    );
    for (const interval of pair.collisionIntervals) {
      lines.push(`    碰撞区间 [${formatSeconds(interval.enterSeconds)}, ${formatSeconds(interval.exitSeconds)}]`);
    }
  }
  lines.push(`结论:${report.summary.pass ? "通过" : "未通过"}(碰撞 ${report.summary.collidedPairCount} 对 / 红线违规 ${report.summary.violatedPairCount} 对)`);
  return lines.join("\n");
}
