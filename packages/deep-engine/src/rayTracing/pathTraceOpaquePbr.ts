import { dielectricF0 } from "../materialDielectric.js";
import { sampleDirectDfg185 } from "../webgpu/directDfgLut185.js";
import { ptAdd, ptDot, ptNormalize, ptScale,
  type PathTraceCpuMaterial, type PathTraceRgb, type PathTraceVec3 } from "./pathTraceCpuTypes.js";

const clamp = (value: number, lower = 0, upper = 1): number => Math.min(upper, Math.max(lower, value));
/** Fixed mixture keeps support for C8's broad multiple-scatter component even at metallic=1. */
export const PATH_TRACE_PBR_GGX_PROBABILITY = 0.5;

/** Production stock direct BSDF times cosine, including C8 multiple scattering.
 * The BRDF's numeric floor does not truncate the actual NDF sampling density. */
export function evaluatePathTraceOpaquePbr(material: PathTraceCpuMaterial, normal: PathTraceRgb,
  view: PathTraceRgb, direction: PathTraceRgb) {
  const nl = clamp(ptDot(normal, direction));
  if (nl <= 0) return { cosineRgb: [0, 0, 0] as PathTraceVec3, pdf: 0,
    single: [0, 0, 0] as PathTraceVec3, multiple: [0, 0, 0] as PathTraceVec3 };
  const nv = clamp(ptDot(normal, view), 1e-4), half = ptNormalize(ptAdd(view, direction));
  const nh = clamp(ptDot(normal, half)), vh = clamp(ptDot(view, half));
  const rough = clamp(material.roughness!, .045), a2 = rough ** 4;
  const denominator = nh * nh * (a2 - 1) + 1;
  const distribution = a2 / Math.max(Math.PI * denominator * denominator, 1e-6);
  const gv = nl * Math.sqrt(a2 + (1 - a2) * nv * nv);
  const gl = nv * Math.sqrt(a2 + (1 - a2) * nl * nl);
  const visibility = .5 / Math.max(gv + gl, 1e-6);
  const metal = material.metallic ?? 0, dielectric = dielectricF0(material.ior);
  const factor = 2 ** ((-5.55473 * vh - 6.98316) * vh);
  const viewDfg = sampleDirectDfg185(rough, clamp(ptDot(normal, view), .001));
  const lightDfg = sampleDirectDfg185(rough, nl);
  const lostView = 1 - (viewDfg[0] + viewDfg[1]), lostLight = 1 - (lightDfg[0] + lightDfg[1]);
  const single: PathTraceVec3 = [0, 0, 0], multiple: PathTraceVec3 = [0, 0, 0];
  const cosineRgb = material.reflectance.map((base, channel) => {
    const f0 = dielectric * (1 - metal) + base * metal;
    const f = f0 * (1 - factor) + factor;
    single[channel] = f * visibility * distribution * nl;
    const averageFresnel = f0 + (1 - f0) * .047619;
    multiple[channel] = (f0 * viewDfg[0] + viewDfg[1]) * (f0 * lightDfg[0] + lightDfg[1]) * averageFresnel
      / (1 - lostView * lostLight * averageFresnel + .000001) * (lostView * lostLight) * nl;
    return (1 - metal) * base / Math.PI * nl + single[channel]! + multiple[channel]!;
  }) as PathTraceVec3;
  const ndfDensity = a2 / (Math.PI * denominator * denominator);
  const ggxPdf = vh > 0 ? ndfDensity * nh / (4 * vh) : 0;
  const p = PATH_TRACE_PBR_GGX_PROBABILITY;
  return { cosineRgb, single, multiple, pdf: p * ggxPdf + (1 - p) * nl / Math.PI };
}

/** The legacy sampler supplies cosine/GGX directions; every branch uses the full joint PDF. */
export function pathTraceOpaquePbrWeight(material: PathTraceCpuMaterial, normal: PathTraceRgb,
  view: PathTraceRgb, direction: PathTraceRgb): PathTraceVec3 {
  const result = evaluatePathTraceOpaquePbr(material, normal, view, direction);
  return ptScale(result.cosineRgb, 1 / result.pdf);
}
