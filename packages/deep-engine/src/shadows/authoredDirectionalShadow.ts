import type { CascadedShadowPlan, ShadowVec3 } from "./types.js";
import { packCascadedShadowUniform } from "./cascadedShadowShader.js";

export interface AuthoredDirectionalShadow {
  readonly viewProjection: readonly number[];
  readonly mapSize: number;
  readonly bias: number;
  readonly normalBias: number;
  readonly intensity: number;
  readonly radius: number;
}

export function snapshotAuthoredShadow(source: AuthoredDirectionalShadow): AuthoredDirectionalShadow {
  if (!source || typeof source !== "object") throw new TypeError("Invalid authored directional shadow.");
  const m = source.viewProjection;
  if (!Array.isArray(m) || m.length !== 16 || !m.every(value => Number.isFinite(Math.fround(value)))) throw new RangeError("Authored shadow matrix must be finite Float32 mat4.");
  if (Math.abs(m[3]!) + Math.abs(m[7]!) + Math.abs(m[11]!) + Math.abs(m[15]! - 1) > 1e-5) throw new RangeError("Authored shadow camera must be orthographic.");
  const rows = [0, 1, 2].map(row => [m[row]!, m[row + 4]!, m[row + 8]!] as ShadowVec3);
  const lengths = rows.map(row => Math.hypot(...row));
  if (lengths.some(length => length < 1e-12 || !Number.isFinite(length))) throw new RangeError("Authored shadow matrix must be nondegenerate.");
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    if (Math.abs(rows[a]!.reduce((sum, value, axis) => sum + value * rows[b]![axis]!, 0) / lengths[a]! / lengths[b]!) > 1e-4) throw new RangeError("Authored shadow camera must not shear.");
  }
  if (!Number.isSafeInteger(source.mapSize) || source.mapSize < 64 || source.mapSize > 16384
    || !Number.isFinite(source.bias) || Math.abs(source.bias) > 0.1
    || !Number.isFinite(source.normalBias) || source.normalBias < 0 || source.normalBias > 1000
    || !Number.isFinite(source.intensity) || source.intensity < 0 || source.intensity > 1
    || !Number.isFinite(source.radius) || source.radius < 0 || source.radius > 64) throw new RangeError("Invalid authored shadow sampling parameters.");
  return Object.freeze({ ...source, viewProjection: Object.freeze([...m]) });
}

export function planAuthoredShadow(source: AuthoredDirectionalShadow, direction: ShadowVec3): CascadedShadowPlan {
  const m = source.viewProjection;
  const world = (x: number, y: number, z: number): ShadowVec3 => {
    const clip = [x, y, z];
    return [0, 1, 2].map(axis => [0, 1, 2].reduce((sum, row) => {
      const scale = m[row]! ** 2 + m[row + 4]! ** 2 + m[row + 8]! ** 2;
      return sum + m[axis * 4 + row]! * (clip[row]! - m[12 + row]!) / scale;
    }, 0)) as unknown as ShadowVec3;
  };
  const width = 2 / Math.hypot(m[0]!, m[4]!, m[8]!), height = 2 / Math.hypot(m[1]!, m[5]!, m[9]!);
  const far = 1 / Math.hypot(m[2]!, m[6]!, m[10]!);
  const corners = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [0, 1].map(z => world(x, y, z))));
  return { lightDirection: direction, shadowMapSize: source.mapSize, splitDepths: new Float32Array([0, far]),
    cascades: [{ index: 0, near: 0, far, blendStart: far, center: world(0, 0, 0.5), radius: Math.max(width, height) / 2,
      texelWorldSize: Math.max(width, height) / source.mapSize, viewProjection: new Float32Array(m), corners }] };
}

export function packAuthoredShadow(plan: CascadedShadowPlan, source: AuthoredDirectionalShadow, viewportHeight = 0): Float32Array<ArrayBuffer> {
  const data = packCascadedShadowUniform(plan, 0);
  data[153] = source.bias; data[155] = 2;
  data.set([source.normalBias, source.intensity, source.radius], 148);
  data[151] = viewportHeight;
  return data;
}
