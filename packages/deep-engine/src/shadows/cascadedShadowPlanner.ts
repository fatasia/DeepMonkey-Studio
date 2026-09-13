import { lookAt, multiply, orthographic } from "../webgpu/cameraMath.js";
import type {
  CascadedShadowCamera, CascadedShadowOptions, CascadedShadowPlan, CascadedShadowSlice, ShadowVec3,
} from "./types.js";

const MAX_DISTANCE = 1_000_000;
const DEFAULTS = Object.freeze({ cascadeCount: 4, splitLambda: 0.7, shadowMapSize: 2048, depthPadding: 10, blendRatio: 0.1 });

interface Basis { readonly forward: ShadowVec3; readonly right: ShadowVec3; readonly up: ShadowVec3 }

/** Builds stable, texel-snapped directional-light cascades in WebGPU's 0..1 depth convention. */
export function planCascadedShadows(camera: CascadedShadowCamera, lightDirection: ShadowVec3,
  options: CascadedShadowOptions = {}): CascadedShadowPlan {
  const validated = validate(camera, lightDirection, options);
  const basis = cameraBasis(camera);
  const splits = practicalSplits(camera.near, validated.shadowFar, validated.cascadeCount, validated.splitLambda);
  const cascades: CascadedShadowSlice[] = [];
  let sliceNear = camera.near;
  for (let index = 0; index < splits.length; index += 1) {
    const sliceFar = splits[index]!;
    // Fit the next cascade from the previous blend start so both maps cover the cross-fade interval.
    const fitNear = index === 0 ? sliceNear : cascades[index - 1]!.blendStart;
    const corners = frustumCorners(camera.eye, basis, camera.verticalFovRadians, camera.aspect, fitNear, sliceFar);
    const center = average(corners);
    const radius = quantizedRadius(center, corners);
    const texelWorldSize = 2 * radius / validated.shadowMapSize;
    const snapped = snapLightSpaceCenter(center, validated.lightDirection, texelWorldSize);
    const lightDistance = radius + validated.depthPadding;
    const lightEye = sub(snapped, scale(validated.lightDirection, lightDistance));
    const lightUp: ShadowVec3 = Math.abs(validated.lightDirection[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
    const viewProjection = multiply(
      orthographic(radius, 0, 2 * (radius + validated.depthPadding)),
      lookAt(lightEye, snapped, lightUp),
    );
    const blendStart = sliceFar - (sliceFar - sliceNear) * validated.blendRatio;
    cascades.push(Object.freeze({ index, near: sliceNear, far: sliceFar, blendStart, center: snapped,
      radius, texelWorldSize, viewProjection, corners: Object.freeze(corners) }));
    sliceNear = sliceFar;
  }
  return Object.freeze({ lightDirection: validated.lightDirection, shadowMapSize: validated.shadowMapSize,
    cascades: Object.freeze(cascades), splitDepths: new Float32Array(splits) });
}

function validate(camera: CascadedShadowCamera, lightDirection: ShadowVec3, options: CascadedShadowOptions) {
  if (!camera || typeof camera !== "object" || Array.isArray(camera)) throw new TypeError("Shadow camera must be an object.");
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Shadow options must be an object.");
  finiteVec(camera.eye, "camera eye"); finiteVec(camera.target, "camera target"); finiteVec(camera.up ?? [0, 1, 0], "camera up");
  const verticalFovRadians = finite(camera.verticalFovRadians, 1e-4, Math.PI - 1e-4, "vertical field of view");
  const aspect = finite(camera.aspect, 1e-4, 1000, "camera aspect");
  const near = finite(camera.near, 1e-4, MAX_DISTANCE, "camera near");
  const far = finite(camera.far, near + 1e-4, MAX_DISTANCE, "camera far");
  const cascadeCount = integer(options.cascadeCount ?? DEFAULTS.cascadeCount, 1, 8, "cascade count");
  const splitLambda = finite(options.splitLambda ?? DEFAULTS.splitLambda, 0, 1, "split lambda");
  const shadowMapSize = integer(options.shadowMapSize ?? DEFAULTS.shadowMapSize, 64, 16384, "shadow map size");
  const depthPadding = finite(options.depthPadding ?? DEFAULTS.depthPadding, 0, MAX_DISTANCE, "depth padding");
  const blendRatio = finite(options.blendRatio ?? DEFAULTS.blendRatio, 0, 0.5, "cascade blend ratio");
  const shadowFar = options.maxShadowDistance === undefined ? far
    : Math.min(far, finite(options.maxShadowDistance, near + 1e-4, MAX_DISTANCE, "maximum shadow distance"));
  void verticalFovRadians; void aspect;
  return { cascadeCount, splitLambda, shadowMapSize, depthPadding, blendRatio, shadowFar,
    lightDirection: normalize(finiteVec(lightDirection, "light direction")) } as const;
}

function practicalSplits(near: number, far: number, count: number, lambda: number): number[] {
  const result: number[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (index === count) { result.push(far); continue; }
    const ratio = index / count;
    const logarithmic = near * (far / near) ** ratio;
    const uniform = near + (far - near) * ratio;
    result.push(logarithmic * lambda + uniform * (1 - lambda));
  }
  return result;
}

function cameraBasis(camera: CascadedShadowCamera): Basis {
  const forward = normalize(sub(camera.target, camera.eye));
  const right = normalize(cross(forward, normalize(camera.up ?? [0, 1, 0])));
  return { forward, right, up: cross(right, forward) };
}

function frustumCorners(eye: ShadowVec3, basis: Basis, fov: number, aspect: number, near: number, far: number): ShadowVec3[] {
  const tan = Math.tan(fov / 2), result: ShadowVec3[] = [];
  for (const depth of [near, far]) {
    const center = add(eye, scale(basis.forward, depth));
    const halfHeight = tan * depth, halfWidth = halfHeight * aspect;
    for (const y of [-1, 1]) for (const x of [-1, 1]) {
      result.push(add(add(center, scale(basis.right, x * halfWidth)), scale(basis.up, y * halfHeight)));
    }
  }
  return result;
}

function quantizedRadius(center: ShadowVec3, corners: readonly ShadowVec3[]): number {
  const raw = Math.max(...corners.map((corner) => Math.hypot(...sub(corner, center))));
  return Math.max(1 / 16, Math.ceil(raw * 16) / 16);
}

function snapLightSpaceCenter(center: ShadowVec3, direction: ShadowVec3, texel: number): ShadowVec3 {
  const backward = scale(direction, -1);
  const up: ShadowVec3 = Math.abs(backward[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(up, backward)), correctedUp = cross(backward, right);
  const x = Math.round(dot(center, right) / texel) * texel;
  const y = Math.round(dot(center, correctedUp) / texel) * texel;
  const z = dot(center, backward);
  return add(add(scale(right, x), scale(correctedUp, y)), scale(backward, z));
}

function average(values: readonly ShadowVec3[]): ShadowVec3 {
  const total = values.reduce<ShadowVec3>((sum, value) => add(sum, value), [0, 0, 0]);
  return scale(total, 1 / values.length);
}
function finiteVec(value: ShadowVec3, label: string): ShadowVec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => Number.isFinite(component) && Math.abs(component) <= MAX_DISTANCE)) {
    throw new RangeError(`Invalid ${label}.`);
  }
  return [value[0], value[1], value[2]];
}
function finite(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}.`); return value;
}
function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Invalid ${label}.`); return value;
}
function normalize(value: ShadowVec3): ShadowVec3 {
  const length = Math.hypot(...value); if (length < 1e-8) throw new RangeError("Direction is degenerate."); return scale(value, 1 / length);
}
function add(a: ShadowVec3, b: ShadowVec3): ShadowVec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sub(a: ShadowVec3, b: ShadowVec3): ShadowVec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(value: ShadowVec3, factor: number): ShadowVec3 { return [value[0] * factor, value[1] * factor, value[2] * factor]; }
function dot(a: ShadowVec3, b: ShadowVec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: ShadowVec3, b: ShadowVec3): ShadowVec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
