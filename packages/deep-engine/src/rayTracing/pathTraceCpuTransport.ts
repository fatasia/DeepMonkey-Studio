import { createReferenceRng } from "../lighting/probeReferenceScene.js";
import type { TraceQuery } from "./rayTrace.js";
import type { PathTraceReferenceKernel } from "./pathTraceReferenceKernel.js";
import { samplePathTraceCpuBsdf } from "./pathTraceCpuBsdf.js";
import { evaluatePathTraceDirect, preparePathTraceDirectionalLight } from "./pathTraceDirectionalLight.js";
import { ptAdd, ptCross, ptDot, ptNormalize, ptScale, validatePathTraceRgb,
  type PathTraceCpuKernelOptions, type PathTraceCpuMaterial, type PathTraceRgb, type PathTraceVec3 } from "./pathTraceCpuTypes.js";

export interface PathTraceCpuSurface {
  readonly t: number;
  /** Shading normal; legacy reference surfaces use the same normal for geometry. */
  readonly normal: PathTraceRgb;
  readonly geometricNormal?: PathTraceRgb;
  readonly material: PathTraceCpuMaterial;
}
export type PathTraceCpuSurfaceQuery = (query: TraceQuery) => PathTraceCpuSurface | undefined;
export type PathTraceCpuTransportOptions = Omit<PathTraceCpuKernelOptions, "blas" | "materials"> & {
  /** Perspective depth planes; only the primary camera ray is clipped. */
  readonly cameraDepthRange?: readonly [number, number];
};

/** One transport implementation shared by the BLAS reference and RenderPacket/TLAS adapter. */
export function createPathTraceCpuTransport(options: PathTraceCpuTransportOptions,
  traceSurface: PathTraceCpuSurfaceQuery): PathTraceReferenceKernel {
  const { width, height } = options;
  const integer = (value: number, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid path trace ${name}.`);
    return value;
  };
  integer(width, "width", 1); integer(height, "height", 1);
  const maxBounces = integer(options.maxBounces ?? 8, "maxBounces", 0, 64);
  const rouletteStart = integer(options.rouletteStart ?? 3, "rouletteStart", 0, 64);
  const epsilon = options.rayEpsilon ?? 1e-5;
  if (!Number.isFinite(epsilon) || epsilon <= 0) throw new RangeError("Invalid path trace rayEpsilon.");
  const camera = options.camera;
  for (const vector of [camera.origin, camera.target, camera.up]) {
    if (!Array.isArray(vector) || vector.length !== 3 || vector.some(v => !Number.isFinite(v))) throw new RangeError("Invalid path trace camera.");
  }
  if (!Number.isFinite(camera.verticalFovDegrees) || camera.verticalFovDegrees <= 0
    || camera.verticalFovDegrees > 179) throw new RangeError("Invalid path trace field of view.");
  const origin: PathTraceVec3 = [...camera.origin];
  const forward = ptNormalize(ptAdd(camera.target, ptScale(origin, -1)));
  const right = ptNormalize(ptCross(forward, camera.up)), up = ptCross(right, forward);
  const halfHeight = Math.tan(camera.verticalFovDegrees * Math.PI / 360);
  const environment = typeof options.environment === "function" ? options.environment : [...options.environment] as PathTraceVec3;
  const lighting = preparePathTraceDirectionalLight(options.lighting);
  if (typeof environment !== "function") validatePathTraceRgb(environment, "environment");
  const depth = options.cameraDepthRange === undefined ? undefined : [...options.cameraDepthRange];
  if (depth && (depth.length !== 2 || !depth.every(Number.isFinite) || depth[0]! <= 0 || depth[1]! <= depth[0]!)) {
    throw new RangeError("Invalid path trace camera depth range.");
  }
  return Object.freeze({ traceSample(x: number, y: number, sampleOrdinal: number, seed: number): PathTraceRgb {
    integer(x, "x", 0, width - 1); integer(y, "y", 0, height - 1);
    integer(sampleOrdinal, "sampleOrdinal", 0); integer(seed, "seed", 0, 0xffffffff);
    let mixed = seed ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)
      ^ Math.imul(sampleOrdinal >>> 0, 0xc2b2ae35) ^ Math.imul(Math.floor(sampleOrdinal / 0x100000000), 0x27d4eb2f);
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
    const rng = createReferenceRng((mixed ^ (mixed >>> 15)) >>> 0);
    const sx = ((x + rng()) / width * 2 - 1) * halfHeight * width / height;
    const sy = (1 - (y + rng()) / height * 2) * halfHeight;
    let direction = ptNormalize(ptAdd(ptAdd(forward, ptScale(right, sx)), ptScale(up, sy)));
    const cosine = ptDot(direction, forward);
    let point: PathTraceVec3 = depth ? ptAdd(origin, ptScale(direction, depth[0]! / cosine)) : [...origin];
    let throughput: PathTraceVec3 = [1, 1, 1];
    const radiance: PathTraceVec3 = [0, 0, 0];
    for (let bounce = 0; bounce <= maxBounces; bounce++) {
      const hit = traceSurface({ ox: point[0], oy: point[1], oz: point[2],
        dx: direction[0], dy: direction[1], dz: direction[2],
        tMax: bounce === 0 && depth ? (depth[1]! - depth[0]!) / cosine : Number.MAX_VALUE });
      if (hit === undefined) {
        const rgb = typeof environment === "function" ? environment(direction) : environment;
        validatePathTraceRgb(rgb, "environment sample");
        for (let c = 0; c < 3; c++) radiance[c]! += throughput[c]! * rgb[c]!;
        break;
      }
      const emission = hit.material.emission ?? [0, 0, 0];
      for (let c = 0; c < 3; c++) radiance[c]! += throughput[c]! * emission[c]!;
      if (bounce === maxBounces) break;
      const geometric = hit.geometricNormal ?? hit.normal;
      const back = ptDot(geometric, direction) > 0;
      const geometricNormal = back ? ptScale(geometric, -1) : geometric;
      const normal = back ? ptScale(hit.normal, -1) : hit.normal;
      // Radiance transport uses shading cosine, with geometric reflection support.
      if (ptDot(normal, direction) >= 0 || ptDot(geometricNormal, direction) >= 0) break;
      const surfacePoint = ptAdd(ptAdd(point, ptScale(direction, hit.t)), ptScale(geometricNormal, epsilon));
      if (lighting && Math.max(...lighting.radiance) > 0 && ptDot(geometricNormal, lighting.direction) > 0
        && ptDot(normal, lighting.direction) > 0) {
        const l = lighting.direction;
        const blocked = lighting.shadows && traceSurface({ ox: surfacePoint[0], oy: surfacePoint[1], oz: surfacePoint[2],
          dx: l[0], dy: l[1], dz: l[2], tMax: Number.MAX_VALUE }) !== undefined;
        if (!blocked) {
          const direct = evaluatePathTraceDirect(hit.material, normal, ptScale(direction, -1), l);
          for (let c = 0; c < 3; c++) radiance[c]! += throughput[c]! * direct[c]! * lighting.radiance[c]!;
        }
      }
      const sampled = samplePathTraceCpuBsdf(hit.material, normal, ptScale(direction, -1), rng);
      // Rejected shading samples retain their zero probability mass; never resample.
      if (sampled === undefined || ptDot(geometricNormal, sampled.direction) <= 0) break;
      for (let c = 0; c < 3; c++) throughput[c]! *= sampled.weight[c]!;
      if (Math.max(...throughput) === 0) break;
      if (bounce >= rouletteStart) {
        const survival = Math.min(0.95, Math.max(0.05, ...throughput));
        if (rng() >= survival) break;
        throughput = ptScale(throughput, 1 / survival);
      }
      point = surfacePoint;
      direction = sampled.direction;
    }
    validatePathTraceRgb(radiance, "integrated radiance");
    return radiance;
  } });
}
