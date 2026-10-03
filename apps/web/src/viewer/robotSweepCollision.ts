/**
 * N10 时间扫掠:机器人连杆/工具/工件沿 FK 轨迹的碰撞扫掠。
 * 定位在互锁粗筛(runRobotSyncScenario 信号级调度/TCP 互斥窗口)**之后**:
 * 粗筛给出候选对,本层做几何裁决——固定步长采样 → 每步 FK(复用 T15 ikSkeleton)→
 * 对级球粗筛(保守剪枝)→ GJK 窄相位(convexDistance)→ 状态翻转二分细化碰撞时刻。
 * 输出碰撞时刻、接触点(仅分离/切触态)、最小间距(最近点对距离)与涉及连杆对。
 * 轨迹两种形态:骨架 FK(poseAt 关节值)与路径驱动(framesAt 直给节点变换,
 * E4 维护净空的人体/工具/拆卸件过道语义),共用同一套采样/粗筛/窄相位/二分机器。
 * 算法口径与离散化极限见 docs/specs/n10-narrow-phase-sweep-20261001.md;
 * 路径模式口径见 docs/specs/e4-sweep-20261002.md。
 */

import { skeletonFK, type IKSkeleton } from "./ikSkeleton";
import {
  convexDistance,
  toWorldBody,
  type ConvexDistanceOptions,
  type ConvexDistanceResult,
  type ConvexShape,
  type RigidTransform,
  type WorldConvexBody,
} from "./convexDistance";

/** 连杆/工具:随某关节系运动(URDF 语义:连杆系 = 其子关节系;root link = 节点 0)。 */
export interface SweepAttachedBody {
  bodyId: string;
  attach: "node";
  nodeIndex: number;
  shape: ConvexShape;
  /** 节点系内的局部变换(URDF collision origin);缺省恒等。 */
  localTransform?: RigidTransform;
}

/** 工件:世界系固定不变。 */
export interface SweepStaticBody {
  bodyId: string;
  attach: "static";
  shape: ConvexShape;
  transform: RigidTransform;
}

export type SweepBody = SweepAttachedBody | SweepStaticBody;

export interface SweepPairSpec {
  bodyIdA: string;
  bodyIdB: string;
}

/** 骨架 FK 轨迹(N10 原形态):关节值 → skeletonFK 全量节点位姿。 */
export interface SweepSkeletonTrajectorySpec {
  skeleton: IKSkeleton;
  startTimeSeconds: number;
  endTimeSeconds: number;
  /** 采样数(含两端点),≥2。 */
  sampleCount: number;
  /** 关节轨迹采样:返回全量节点序姿态(长度 = 骨架节点数);由调用方保证确定性与合法性。 */
  poseAt(seconds: number): readonly number[];
}

/**
 * 路径驱动轨迹(E4 维护净空):不经骨架 FK,framesAt 直接给出各"路径节点"的世界变换;
 * 节点索引 = SweepAttachedBody.nodeIndex。人体过道/工具搬运/拆卸件抽取等
 * 路径驱动刚体运动由此进入同一套采样/粗筛/窄相位/二分机器,不另建平行系统。
 * framesAt 由调用方保证确定性与合法性(与骨架 poseAt 同约):数组按 nodeIndex 取用,
 * 长度不足或分量非有限在求值点显式报错。
 */
export interface SweepFramesTrajectorySpec {
  framesAt(seconds: number): readonly RigidTransform[];
  startTimeSeconds: number;
  endTimeSeconds: number;
  /** 采样数(含两端点),≥2。 */
  sampleCount: number;
}

export type SweepTrajectorySpec = SweepSkeletonTrajectorySpec | SweepFramesTrajectorySpec;

/** 路径节点位姿的结构形态(骨架 FK 与路径模式共用;composeNodeTransform/球粗筛消费)。 */
interface SweepNodeFrame {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
}

export interface SweepCollisionOptions {
  /** 碰撞判据:GJK 报碰撞,或距离 ≤ 该切触容差(米)。默认 1e-9。 */
  touchEpsilon?: number;
  /** 二分细化的时间容差(秒)。默认 1e-6。 */
  refinementTimeToleranceSeconds?: number;
  /** 单次二分细化迭代上限。默认 40。 */
  maxRefinementIterations?: number;
  /** 透传 GJK 容差。 */
  gjk?: ConvexDistanceOptions;
}

/** 单对扫掠结果。碰撞(穿透)样本无接触点;切触(separated 但 d≤touchEpsilon)带点。 */
export interface SweepPairResult {
  bodyIdA: string;
  bodyIdB: string;
  /** 扫掠全程最小间距(米;发生碰撞则为 0)。 */
  minDistance: number;
  minDistanceAtSeconds: number;
  minDistancePointA?: readonly [number, number, number];
  minDistancePointB?: readonly [number, number, number];
  /** 首次碰撞(区间入口经二分细化);切触态附接触点,穿透态接触集不唯一、如实缺省。 */
  firstCollision?: {
    timeSeconds: number;
    pointA?: readonly [number, number, number];
    pointB?: readonly [number, number, number];
  };
  collisionIntervals: Array<{ enterSeconds: number; exitSeconds: number }>;
}

export interface SweepCollisionReport {
  bodyCount: number;
  pairCount: number;
  sampleCount: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  pairs: SweepPairResult[];
  meta: {
    /** 窄相位查询总次数(含细化复评)。 */
    gjkQueries: number;
    /** 被球粗筛剪枝的(对×样本)数。 */
    sphereCulledSamples: number;
    /** 二分细化额外评估次数。 */
    refinementEvaluations: number;
  };
}

const MAX_SAMPLE_COUNT = 2_000_000;
const MAX_BODIES = 4096;
const MAX_PAIRS = 100_000;

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数值,得到 ${value}`);
}

/** 体局部包围球(一次预计算):顶点取均值心/最大距,球即本体。供逐步廉价的宽相剪枝。 */
interface LocalBounding {
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
}

function localBoundingOf(shape: ConvexShape): LocalBounding {
  const identity: RigidTransform = { translation: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1] };
  return toWorldBody(shape, identity).bounding;
}

/** 四元数标量乘 qa ∘ qb(x,y,z,w)。 */
function multiplyQuaternion(
  qa: readonly [number, number, number, number],
  qb: readonly [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = qa;
  const [bx, by, bz, bw] = qb;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function rotateVector(
  q: readonly [number, number, number, number],
  v: readonly [number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  // v' = q·v·q⁻¹ 展开式(t = 2·q_vec×v;v' = v + w·t + q_vec×t)。
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

interface PreparedBody {
  spec: SweepBody;
  bounding: LocalBounding;
}

interface PairRun {
  spec: SweepPairSpec;
  /** 1 = 碰撞(含切触),0 = 分离。粗筛剪枝样本恒 0(球不相交必分离)。 */
  states: Uint8Array;
  /** GJK 距离;剪枝样本为 NaN(不参与最小间距,剪枝保守性保证不漏更小值)。 */
  distances: Float64Array;
  pointsA: Float64Array;
  pointsB: Float64Array;
  minDistance: number;
  minAtSample: number;
  gjkQueries: number;
  culled: number;
}

/**
 * 运行时间扫掠。pairs 即互锁粗筛交接的候选对(可经 crossPairs 生成);
 * 计时单列返回,report 不含时间量——同输入双跑 report 逐位一致。
 */
export function runSweepCollision(
  trajectory: SweepTrajectorySpec,
  bodies: SweepBody[],
  pairs: SweepPairSpec[],
  options: SweepCollisionOptions = {},
): { report: SweepCollisionReport; elapsedMs: number } {
  const { startTimeSeconds, endTimeSeconds, sampleCount } = trajectory;
  assertFinite(startTimeSeconds, "startTimeSeconds");
  assertFinite(endTimeSeconds, "endTimeSeconds");
  if (!(endTimeSeconds > startTimeSeconds)) throw new Error("endTimeSeconds 必须大于 startTimeSeconds");
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > MAX_SAMPLE_COUNT) {
    throw new Error(`sampleCount 必须是 2..${MAX_SAMPLE_COUNT} 的整数`);
  }
  if (!Array.isArray(bodies) || bodies.length === 0 || bodies.length > MAX_BODIES) {
    throw new Error(`体集合必须是 1..${MAX_BODIES} 个`);
  }
  if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > MAX_PAIRS) {
    throw new Error(`对列表必须是 1..${MAX_PAIRS} 个`);
  }
  const touchEpsilon = options.touchEpsilon ?? 1e-9;
  const refinementTolerance = options.refinementTimeToleranceSeconds ?? 1e-6;
  const maxRefinement = options.maxRefinementIterations ?? 40;
  assertFinite(touchEpsilon, "touchEpsilon");
  assertFinite(refinementTolerance, "refinementTimeToleranceSeconds");
  if (!(touchEpsilon >= 0) || !(refinementTolerance > 0) || !Number.isInteger(maxRefinement) || maxRefinement < 1) {
    throw new Error("扫掠选项非法:touchEpsilon ≥ 0、refinementTimeToleranceSeconds > 0、maxRefinementIterations 为正整数");
  }
  const skeleton: IKSkeleton | undefined = "skeleton" in trajectory ? trajectory.skeleton : undefined;
  const bodyById = new Map<string, PreparedBody>();
  for (const item of bodies) {
    // 先取标量字段再判别,避免联合收窄到 never(exactOptional/判别联合组合下的 TS 限制)。
    if (!item || typeof item.bodyId !== "string" || !item.bodyId) throw new Error("体缺少有效 bodyId");
    const bodyId = item.bodyId;
    if (bodyById.has(bodyId)) throw new Error(`bodyId 重复:${bodyId}`);
    if (item.attach === "node") {
      if (!Number.isInteger(item.nodeIndex) || item.nodeIndex < 0) {
        throw new Error(`体 ${bodyId} 的 nodeIndex ${String(item.nodeIndex)} 必须是非负整数`);
      }
      if (skeleton && item.nodeIndex >= skeleton.nodes.length) {
        throw new Error(`体 ${bodyId} 的 nodeIndex ${String(item.nodeIndex)} 超出骨架节点范围 0..${skeleton.nodes.length - 1}`);
      }
    } else if (item.attach !== "static") {
      throw new Error(`体 ${bodyId} 的 attach 非法(只支持 node/static)`);
    }
    const body = item as SweepBody;
    bodyById.set(bodyId, { spec: body, bounding: localBoundingOf(body.shape) });
  }
  const pairRuns: PairRun[] = pairs.map(spec => {
    if (!bodyById.has(spec.bodyIdA)) throw new Error(`对引用了未知体:${spec.bodyIdA}`);
    if (!bodyById.has(spec.bodyIdB)) throw new Error(`对引用了未知体:${spec.bodyIdB}`);
    if (spec.bodyIdA === spec.bodyIdB) throw new Error(`对两端是同一体:${spec.bodyIdA}`);
    return {
      spec,
      states: new Uint8Array(sampleCount),
      distances: new Float64Array(sampleCount).fill(Number.NaN),
      pointsA: new Float64Array(sampleCount * 3).fill(Number.NaN),
      pointsB: new Float64Array(sampleCount * 3).fill(Number.NaN),
      minDistance: Infinity,
      minAtSample: -1,
      gjkQueries: 0,
      culled: 0,
    };
  });

  const stepDuration = (endTimeSeconds - startTimeSeconds) / (sampleCount - 1);
  /** 采样时刻:末端点精确取 endTime,避免累加漂移破坏端点语义。 */
  const sampleTime = (index: number): number =>
    index === sampleCount - 1 ? endTimeSeconds : startTimeSeconds + index * stepDuration;

  // ── 时刻评估器:采样与二分细化共用同一条路径,保证状态一致 ──
  // 骨架模式走 T15 FK;路径模式(E4)直接取 framesAt 变换,两者产出同一结构形态。
  const nodeFramesAt = (seconds: number): readonly SweepNodeFrame[] => {
    if ("skeleton" in trajectory) return skeletonFK(trajectory.skeleton, trajectory.poseAt(seconds));
    const frames = trajectory.framesAt(seconds);
    if (!Array.isArray(frames)) throw new Error("framesAt 必须返回变换数组");
    return frames.map(frameToWorldFrame);
  };
  const nodeFrameOf = (frames: readonly SweepNodeFrame[], spec: SweepAttachedBody): SweepNodeFrame => {
    const frame = frames[spec.nodeIndex];
    if (!frame) throw new Error(`体 ${spec.bodyId} 的路径节点 ${spec.nodeIndex} 超出 framesAt 返回范围(长度 ${frames.length})`);
    return frame;
  };
  let refinementEvaluations = 0;
  const evaluateAt = (seconds: number, bodyIdA: string, bodyIdB: string): ConvexDistanceResult => {
    const frames = nodeFramesAt(seconds);
    const evaluate = (bodyId: string): WorldConvexBody => {
      const body = bodyById.get(bodyId)!;
      const spec = body.spec;
      if (spec.attach === "static") return toWorldBody(spec.shape, spec.transform);
      return toWorldBody(spec.shape, composeNodeTransform(nodeFrameOf(frames, spec), spec.localTransform));
    };
    return convexDistance(evaluate(bodyIdA), evaluate(bodyIdB), options.gjk);
  };
  const collidesAt = (seconds: number, bodyIdA: string, bodyIdB: string): boolean => {
    refinementEvaluations += 1;
    const result = evaluateAt(seconds, bodyIdA, bodyIdB);
    return !result.separated || result.distance <= touchEpsilon;
  };

  const startedAt = performance.now();

  // ── 主扫掠:逐采样 → 逐对(球粗筛 → GJK 窄相位)──
  for (let sample = 0; sample < sampleCount; sample++) {
    const seconds = sampleTime(sample);
    const frames = nodeFramesAt(seconds);
    const worldCache = new Map<string, WorldConvexBody>();
    const worldOf = (bodyId: string): WorldConvexBody => {
      const cached = worldCache.get(bodyId);
      if (cached) return cached;
      const body = bodyById.get(bodyId)!;
      const spec = body.spec;
      const world = spec.attach === "static"
        ? toWorldBody(spec.shape, spec.transform)
        : toWorldBody(spec.shape, composeNodeTransform(nodeFrameOf(frames, spec), spec.localTransform));
      worldCache.set(bodyId, world);
      return world;
    };
    const worldCenterOf = (bodyId: string): [number, number, number] => {
      const body = bodyById.get(bodyId)!;
      const bounding = body.bounding;
      const spec = body.spec;
      if (spec.attach === "static") {
        const rotated = rotateVector(spec.transform.rotationQuaternion, [bounding.centerX, bounding.centerY, bounding.centerZ]);
        return [
          spec.transform.translation[0] + rotated[0],
          spec.transform.translation[1] + rotated[1],
          spec.transform.translation[2] + rotated[2],
        ];
      }
      const frame = nodeFrameOf(frames, spec);
      let center: [number, number, number] = [bounding.centerX, bounding.centerY, bounding.centerZ];
      if (spec.localTransform) {
        center = rotateVector(spec.localTransform.rotationQuaternion, center);
        center = [center[0] + spec.localTransform.translation[0], center[1] + spec.localTransform.translation[1], center[2] + spec.localTransform.translation[2]];
      }
      const rotated = rotateVector(
        [frame.quaternion.x, frame.quaternion.y, frame.quaternion.z, frame.quaternion.w],
        center,
      );
      return [frame.position.x + rotated[0], frame.position.y + rotated[1], frame.position.z + rotated[2]];
    };
    for (const run of pairRuns) {
      const [ax, ay, az] = worldCenterOf(run.spec.bodyIdA);
      const [bx, by, bz] = worldCenterOf(run.spec.bodyIdB);
      const radiusSum = bodyById.get(run.spec.bodyIdA)!.bounding.radius + bodyById.get(run.spec.bodyIdB)!.bounding.radius;
      const centerDist = Math.hypot(ax - bx, ay - by, az - bz);
      const lowerBound = centerDist - radiusSum;
      if (centerDist > radiusSum && lowerBound >= run.minDistance) {
        // 球不相交(必分离)且球面下界不可能刷新当前最小 → 免窄相位;保守性:三角不等式。
        run.culled += 1;
        continue;
      }
      const result = convexDistance(worldOf(run.spec.bodyIdA), worldOf(run.spec.bodyIdB), options.gjk);
      run.gjkQueries += 1;
      const colliding = !result.separated || result.distance <= touchEpsilon;
      run.states[sample] = colliding ? 1 : 0;
      run.distances[sample] = result.distance;
      if (result.distance < run.minDistance) {
        run.minDistance = result.distance;
        run.minAtSample = sample;
      }
      if (result.separated) {
        const base = sample * 3;
        run.pointsA[base] = result.pointA[0]; run.pointsA[base + 1] = result.pointA[1]; run.pointsA[base + 2] = result.pointA[2];
        run.pointsB[base] = result.pointB[0]; run.pointsB[base + 1] = result.pointB[1]; run.pointsB[base + 2] = result.pointB[2];
      }
    }
  }

  // ── 状态翻转二分细化:任意顺序的两点(一碰撞一分离)向碰撞侧夹逼 ──
  const bisectTransition = (run: PairRun, collidingSeconds: number, freeSeconds: number): number => {
    let colliding = collidingSeconds;
    let free = freeSeconds;
    for (let iteration = 0; iteration < maxRefinement && Math.abs(colliding - free) > refinementTolerance; iteration++) {
      const mid = colliding + (free - colliding) / 2;
      if (collidesAt(mid, run.spec.bodyIdA, run.spec.bodyIdB)) colliding = mid;
      else free = mid;
    }
    return colliding;
  };

  const finishedAt = performance.now();

  // ── 区间构建与结果装配 ──
  const results: SweepPairResult[] = pairRuns.map(run => {
    const intervals: Array<{ enterSeconds: number; exitSeconds: number }> = [];
    let openEnter: number | undefined;
    let firstCollision: SweepPairResult["firstCollision"];
    for (let sample = 0; sample < sampleCount; sample++) {
      const colliding = run.states[sample] === 1;
      const seconds = sampleTime(sample);
      const previous = sample > 0 ? run.states[sample - 1] === 1 : undefined;
      if (colliding && previous === undefined) {
        openEnter = seconds; // 扫掠起点即碰撞
      } else if (colliding && previous === false) {
        openEnter = bisectTransition(run, seconds, sampleTime(sample - 1));
      } else if (!colliding && previous === true) {
        const enter = openEnter ?? sampleTime(sample - 1);
        intervals.push({ enterSeconds: enter, exitSeconds: bisectTransition(run, sampleTime(sample - 1), seconds) });
        openEnter = undefined;
      }
    }
    if (openEnter !== undefined) {
      intervals.push({ enterSeconds: openEnter, exitSeconds: sampleTime(sampleCount - 1) });
    }
    if (intervals.length > 0) {
      const enter = intervals[0]!.enterSeconds;
      const contact = evaluateAt(enter, run.spec.bodyIdA, run.spec.bodyIdB);
      firstCollision = contact.separated
        ? { timeSeconds: enter, pointA: contact.pointA, pointB: contact.pointB }
        : { timeSeconds: enter }; // 穿透入口:接触集不唯一,不冒充接触点
    }
    const minBase = run.minAtSample * 3;
    const minHasPoints = Number.isFinite(run.pointsA[minBase]!);
    const result: SweepPairResult = {
      bodyIdA: run.spec.bodyIdA,
      bodyIdB: run.spec.bodyIdB,
      minDistance: run.minDistance,
      minDistanceAtSeconds: run.minAtSample >= 0 ? sampleTime(run.minAtSample) : Number.NaN,
      collisionIntervals: intervals,
    };
    // exactOptionalPropertyTypes:可选字段只在有值时写入,不显式写 undefined。
    if (firstCollision) result.firstCollision = firstCollision;
    if (minHasPoints) {
      result.minDistancePointA = [run.pointsA[minBase]!, run.pointsA[minBase + 1]!, run.pointsA[minBase + 2]!];
      result.minDistancePointB = [run.pointsB[minBase]!, run.pointsB[minBase + 1]!, run.pointsB[minBase + 2]!];
    }
    return result;
  });

  const totalGjk = pairRuns.reduce((sum, run) => sum + run.gjkQueries, 0);
  const totalCulled = pairRuns.reduce((sum, run) => sum + run.culled, 0);
  return {
    report: {
      bodyCount: bodies.length,
      pairCount: pairRuns.length,
      sampleCount,
      startTimeSeconds,
      endTimeSeconds,
      pairs: results,
      meta: {
        gjkQueries: totalGjk,
        sphereCulledSamples: totalCulled,
        refinementEvaluations,
      },
    },
    elapsedMs: finishedAt - startedAt,
  };
}

/** 路径模式:RigidTransform → 路径节点位姿结构(分量有限性在此把关,四元数归一由 toWorldBody 负责)。 */
function frameToWorldFrame(transform: RigidTransform): SweepNodeFrame {
  if (!transform || !Array.isArray(transform.translation) || !Array.isArray(transform.rotationQuaternion)) {
    throw new Error("framesAt 返回的变换无效(缺少平移/旋转数组)");
  }
  const [tx, ty, tz] = transform.translation;
  const [qx, qy, qz, qw] = transform.rotationQuaternion;
  assertFinite(tx, "路径变换平移.x"); assertFinite(ty, "路径变换平移.y"); assertFinite(tz, "路径变换平移.z");
  assertFinite(qx, "路径变换旋转.x"); assertFinite(qy, "路径变换旋转.y");
  assertFinite(qz, "路径变换旋转.z"); assertFinite(qw, "路径变换旋转.w");
  return { position: { x: tx, y: ty, z: tz }, quaternion: { x: qx, y: qy, z: qz, w: qw } };
}

function composeNodeTransform(
  frame: { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } },
  local: RigidTransform | undefined,
): RigidTransform {
  const quaternion: [number, number, number, number] = [frame.quaternion.x, frame.quaternion.y, frame.quaternion.z, frame.quaternion.w];
  if (!local) {
    return {
      translation: [frame.position.x, frame.position.y, frame.position.z],
      rotationQuaternion: quaternion,
    };
  }
  const rotated = rotateVector(quaternion, local.translation);
  return {
    translation: [frame.position.x + rotated[0], frame.position.y + rotated[1], frame.position.z + rotated[2]],
    rotationQuaternion: multiplyQuaternion(quaternion, local.rotationQuaternion),
  };
}

/** 连杆组 × 工件组的笛卡尔候选对(互锁粗筛未给出对时的默认宽相交接)。 */
export function crossPairs(groupA: string[], groupB: string[]): SweepPairSpec[] {
  const pairs: SweepPairSpec[] = [];
  for (const a of groupA) {
    for (const b of groupB) {
      if (a !== b) pairs.push({ bodyIdA: a, bodyIdB: b });
    }
  }
  return pairs;
}
