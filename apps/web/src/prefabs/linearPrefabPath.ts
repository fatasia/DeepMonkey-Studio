import type { SceneLinearPrefabPathState, Vector3Value } from "@bim-studio/contracts";
import * as THREE from "three";

export interface LinearPrefabSegment {
  index: number;
  start: Vector3Value;
  end: Vector3Value;
  midpoint: Vector3Value;
  lengthM: number;
  yawRadians: number;
}

const MAX_RENDER_SEGMENTS = 512;
const CURVE_STEP_M = 1.5;

/** Deterministic path tessellation shared by author preview and publication compilation. */
export function linearPrefabSegments(path: SceneLinearPrefabPathState): readonly LinearPrefabSegment[] {
  const points = canonicalPoints(path);
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
