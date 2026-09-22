import type { SceneLinearPrefabPathState, Vector3Value } from "@bim-studio/contracts";
import * as THREE from "three";
import { DEFAULT_NAVIGATION_SETTINGS } from "../navigationSettings";

export interface LinearPrefabSegment {
  index: number;
  start: Vector3Value;
  end: Vector3Value;
  midpoint: Vector3Value;
  lengthM: number;
  yawRadians: number;
}

/** 贴地投影参数：groundY 为场景基准面高度（沿用导航/对象放置的地面语义，y=0 平面）；缺省表示无地形数据。 */
export interface LinearPrefabPathProjection {
  readonly groundY?: number;
}

const MAX_RENDER_SEGMENTS = 512;
const CURVE_STEP_M = 1.5;
/** 坡度判定容差（弧度）：吸收"恰好等于阈值"时的浮点毛刺，只有真正超过才拒绝。 */
const SLOPE_EPSILON_RADIANS = 1e-9;
/** 水平距小于该值视为垂直段（无坡度语义上的"水平投影"），按 90° 拒绝。 */
const SLOPE_MIN_RUN_M = 1e-9;

/** 缺省坡度上限与导航 maxSlopeAngle 缺省同源（normalizeNavigationSettings 范围 0..89 度），避免两套口径漂移。 */
export const DEFAULT_LINEAR_PREFAB_MAX_SLOPE_ANGLE_DEGREES = DEFAULT_NAVIGATION_SETTINGS.maxSlopeAngle;

/** Deterministic path tessellation shared by author preview and publication compilation. */
export function linearPrefabSegments(path: SceneLinearPrefabPathState,
  projection?: LinearPrefabPathProjection): readonly LinearPrefabSegment[] {
  const points = projectLinearPrefabPathPoints(canonicalPoints(path), path.snapToGround, projection?.groundY);
  assertLinearPrefabPathSlope(points, path.closed, path.maxSlopeAngleDegrees);
  const sampled = path.interpolation === "catmull-rom" && points.length >= 3
    ? sampleSpline(points, path.closed)
    : path.closed ? [...points, points[0]!] : points;
  const segments: LinearPrefabSegment[] = [];
  for (let index = 1; index < sampled.length; index++) {
    const start = sampled[index - 1]!, end = sampled[index]!;
    const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
    const lengthM = Math.hypot(dx, dy, dz);
    if (lengthM <= 1e-4) continue;
    segments.push(Object.freeze({ index: segments.length, start, end,
      midpoint: Object.freeze({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, z: (start.z + end.z) / 2 }),
      lengthM, yawRadians: Math.atan2(dz, dx) }));
    if (segments.length >= MAX_RENDER_SEGMENTS) break;
  }
  return Object.freeze(segments);
}

/**
 * 确定性贴地投影：仅当路径启用贴地且调用方提供了有限基准面高度时，把全部控制点 y 归到基准面；
 * 其余情况（未启用贴地，或没有地形/基准面数据）原样返回作者 y，不虚构地形高度。
 * 预览与发布同走本函数：作者态 raycast 投影写回保存点后，两端消费的 y 保持同源。
 */
export function projectLinearPrefabPathPoints(points: readonly Vector3Value[], snapToGround: boolean,
  groundY?: number): readonly Vector3Value[] {
  if (!snapToGround || groundY === undefined || !Number.isFinite(groundY)) return points;
  return points.map(point => Object.freeze({ ...point, y: groundY }));
}

/**
 * 分段坡度 fail-closed：相邻控制点高差/水平距换算的坡角超过上限即拒绝整条路径，
 * 作者态给可读错误、发布编译直接失败，不存在静默放宽。校验作用于投影后的控制点
 * （作者可理解的"相邻点"语义）；闭合路径的收尾段同样受约束。
 */
function assertLinearPrefabPathSlope(points: readonly Vector3Value[], closed: boolean, maxSlopeAngleDegrees?: number): void {
  const maxDegrees = maxSlopeAngleDegrees ?? DEFAULT_LINEAR_PREFAB_MAX_SLOPE_ANGLE_DEGREES;
  if (!Number.isFinite(maxDegrees) || maxDegrees < 0 || maxDegrees > 89) {
    throw new RangeError("Linear prefab path slope limit must be within 0..89 degrees.");
  }
  const maxRadians = maxDegrees * Math.PI / 180;
  const pairCount = points.length - (closed ? 0 : 1);
  for (let index = 0; index < pairCount; index++) {
    const start = points[index]!, end = points[(index + 1) % points.length]!;
    const run = Math.hypot(end.x - start.x, end.z - start.z), rise = Math.abs(end.y - start.y);
    if (run <= SLOPE_MIN_RUN_M && rise <= SLOPE_MIN_RUN_M) continue; // 重合点由分段阶段按零长过滤，不参与坡度语义
    const slopeRadians = run > SLOPE_MIN_RUN_M ? Math.atan2(rise, run) : Math.PI / 2;
    if (slopeRadians <= maxRadians + SLOPE_EPSILON_RADIANS) continue;
    const endIndex = (index + 1) % points.length;
    throw new RangeError(`围栏/道路路径第 ${index + 1}→${endIndex + 1} 点坡度 ${(slopeRadians * 180 / Math.PI).toFixed(1)}° `
      + `超过上限 ${maxDegrees}°，请降低相邻点高差或在铺设路径中调高坡度上限`);
  }
}

function canonicalPoints(path: SceneLinearPrefabPathState): readonly Vector3Value[] {
  if (!path || !Array.isArray(path.points) || path.points.length < 2 || path.points.length > 512) {
    throw new RangeError("Linear prefab path requires 2..512 points.");
  }
  if (path.interpolation !== "linear" && path.interpolation !== "catmull-rom") {
    throw new RangeError("Linear prefab path interpolation is invalid.");
  }
  if (!Number.isSafeInteger(path.seed) || path.seed < 0 || path.seed > 0xffff_ffff) {
    throw new RangeError("Linear prefab path seed must be a uint32.");
  }
  const ids = new Set<string>();
  return path.points.map((point) => {
    if (!point.id || ids.has(point.id)) throw new Error("Linear prefab path point IDs must be nonempty and unique.");
    ids.add(point.id);
    const values = [point.position.x, point.position.y, point.position.z];
    if (!values.every(Number.isFinite)) throw new RangeError("Linear prefab path coordinates must be finite.");
    return Object.freeze({ ...point.position });
  });
}

function sampleSpline(points: readonly Vector3Value[], closed: boolean): readonly Vector3Value[] {
  const curve = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(point.x, point.y, point.z)), closed, "centripetal");
  const divisions = Math.min(MAX_RENDER_SEGMENTS, Math.max(points.length - 1, Math.ceil(curve.getLength() / CURVE_STEP_M)));
  return Object.freeze(curve.getPoints(divisions).map(point => Object.freeze({ x: point.x, y: point.y, z: point.z })));
}

export function stablePathGateIndex(path: SceneLinearPrefabPathState, segmentCount: number): number {
  if (!Number.isSafeInteger(segmentCount) || segmentCount < 1) return -1;
  return path.seed % segmentCount;
}
