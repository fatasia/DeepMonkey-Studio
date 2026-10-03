import { pathTraceOpaquePbrWeight, PATH_TRACE_PBR_GGX_PROBABILITY } from "./pathTraceOpaquePbr.js";
import { ggxSpecularTimesCosine } from "../lighting/ltc.js";
import { ptAdd, ptCross, ptDot, ptNormalize, ptScale,
  type PathTraceCpuMaterial, type PathTraceRgb, type PathTraceVec3 } from "./pathTraceCpuTypes.js";

/** Cosine Lambert / GGX NDF importance sampling. Rejected below-surface GGX samples are zero. */
export function samplePathTraceCpuBsdf(material: PathTraceCpuMaterial, normal: PathTraceRgb,
  view: PathTraceRgb, rng: () => number): { direction: PathTraceVec3; weight: PathTraceVec3 } | undefined {
  if (material.model === "production-opaque-pbr") {
    const branch: PathTraceCpuMaterial = { model: rng() < PATH_TRACE_PBR_GGX_PROBABILITY ? "ggx-conductor" : "lambert",
      reflectance: [1, 1, 1], roughness: Math.min(1, Math.max(.045, material.roughness!)) };
    const sampled = samplePathTraceCpuBsdf(branch, normal, view, rng);
    return sampled === undefined ? undefined : { direction: sampled.direction,
      weight: pathTraceOpaquePbrWeight(material, normal, view, sampled.direction) };
  }
  const tangent = ptNormalize(ptCross(Math.abs(normal[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0], normal));
  const bitangent = ptCross(normal, tangent);
  const world = (local: PathTraceRgb): PathTraceVec3 => ptAdd(ptAdd(ptScale(tangent, local[0]),
    ptScale(bitangent, local[1])), ptScale(normal, local[2]));
  const local = (v: PathTraceRgb): PathTraceVec3 => [ptDot(v, tangent), ptDot(v, bitangent), ptDot(v, normal)];
  const u = rng(), phi = 2 * Math.PI * rng();
  if (material.model === "lambert") {
    const radius = Math.sqrt(u);
    return { direction: world([radius * Math.cos(phi), radius * Math.sin(phi), Math.sqrt(1 - u)]),
      weight: [...material.reflectance] };
  }
  const alpha = material.roughness! ** 2, alpha2 = alpha * alpha;
  const cosTheta = Math.sqrt((1 - u) / (1 + (alpha2 - 1) * u));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const half = world([sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta]);
  const viewHalf = ptDot(view, half);
  if (viewHalf <= 0) return undefined;
  const direction = ptAdd(ptScale(half, 2 * viewHalf), ptScale(view, -1));
  if (ptDot(normal, direction) <= 0) return undefined;
  const denominator = cosTheta * cosTheta * (alpha2 - 1) + 1;
  const distribution = alpha2 / (Math.PI * denominator * denominator);
  const pdf = distribution * cosTheta / (4 * viewHalf);
  const baseWeight = ggxSpecularTimesCosine(local(direction), local(view), alpha) / pdf;
  const grazing = (1 - Math.min(1, viewHalf)) ** 5;
  const weight = material.reflectance.map(f0 => (f0 + (1 - f0) * grazing) * baseWeight) as PathTraceVec3;
  return { direction, weight };
}
