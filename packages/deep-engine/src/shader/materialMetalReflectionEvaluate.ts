import type { MaterialEvaluationGeometry, MaterialEvaluationResult, StandardSurfaceInputs, Vec3 } from "./materialEvaluate.js";
import { normalizeExtendedMaterialParameters, type MaterialParameterOverrides } from "./materialParameters.js";
import { assertMetalReflectionLayer } from "./materialMetalReflectionProfile.js";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const clamp = (x: number) => Math.max(0, Math.min(1, x));
function unit(a: Vec3, fallback: Vec3): Vec3 {
  const lengthSquared = dot(a, a);
  return lengthSquared <= 1e-8 ? fallback : a.map(x => x / Math.sqrt(lengthSquared)) as unknown as Vec3;
}

/** Explicit conductor single scattering. Output includes nDotL and radiance.
 * This reference does not implement legacy stock/C8, clearcoat or refraction. */
export function evaluateMetalReflectionDirect(surface: StandardSurfaceInputs,
  raw: MaterialParameterOverrides, geometry: MaterialEvaluationGeometry, radiance: Vec3 = [1, 1, 1]): MaterialEvaluationResult {
  const params = normalizeExtendedMaterialParameters(raw);
  assertMetalReflectionLayer({ responseModel: "microfacet-metal-reflection", coverage: 1, params: raw, surface });
  if (surface.metallic !== 1 || params.clearcoat.factor !== 0 || params.transmission.factor !== 0) {
    throw new RangeError("microfacet-metal-reflection requires a pure metal without clearcoat or transmission.");
  }
  const n = unit(geometry.normal, [0, 0, 1]), v = unit(geometry.view, [0, 0, 1]), l = unit(geometry.light, [0, 0, 1]);
  const nl = clamp(dot(n, l)), nv = clamp(dot(n, v)), zero: Vec3 = [0, 0, 0];
  let rgb: Vec3 = zero;
  if (nl > 0 && nv > 0) {
    const sum: Vec3 = [v[0] + l[0], v[1] + l[1], v[2] + l[2]], h = unit(sum, n);
    const rawT = geometry.tangent ?? [1, 0, 0], projection = dot(rawT, n);
    const projected: Vec3 = [rawT[0] - n[0] * projection, rawT[1] - n[1] * projection, rawT[2] - n[2] * projection];
    const fallback = unit(cross(Math.abs(n[0]) > .9 ? [0, 1, 0] : [1, 0, 0], n), [0, 0, 1]);
    const t = unit(projected, fallback), b = unit(cross(n, t), [0, 1, 0]);
    const angle = Math.fround(raw.anisotropy?.rotation ?? 0);
    const c = Math.cos(angle), s = Math.sin(angle);
    const tr = t.map((x, i) => x * c + b[i]! * s) as unknown as Vec3;
    const br = b.map((x, i) => x * c - t[i]! * s) as unknown as Vec3;
    const rough = Math.max(.045, Math.min(1, surface.roughness)), alpha = rough * rough;
    const ax = Math.max(alpha * (1 + params.anisotropy.strength), .001), ay = Math.max(alpha, .001);
    const nh = clamp(dot(n, h)), vh = clamp(dot(v, h));
    const q = (dot(tr, h) / ax) ** 2 + (dot(br, h) / ay) ** 2 + nh * nh;
    const distribution = 1 / (Math.PI * ax * ay * q * q);
    const projectedRoot = (w: Vec3, nw: number) => Math.sqrt(nw * nw + (ax * dot(tr, w)) ** 2 + (ay * dot(br, w)) ** 2);
    const visibility = .5 / (nl * projectedRoot(v, nv) + nv * projectedRoot(l, nl));
    rgb = surface.baseColor.map((color, i) => (color + (1 - color) * (1 - vh) ** 5)
      * distribution * visibility * nl * radiance[i]!) as unknown as Vec3;
  }
  return { rgb: Object.freeze(rgb), components: Object.freeze({ diffuse: zero, specular: rgb, clearcoat: zero, transmission: zero }) };
}
