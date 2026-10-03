import { ptCross, ptDot, ptNormalize, type PathTraceRgb, type PathTraceVec3 } from "./pathTraceCpuTypes.js";
const smoothstep = (lower: number, upper: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - lower) / (upper - lower)));
  return t * t * (3 - 2 * t);
};
function softbox(direction: PathTraceRgb, center: PathTraceRgb, width: number, height: number): number {
  const normal = ptNormalize(center), right = ptNormalize(ptCross([0, 1, 0], normal)), up = ptCross(normal, right);
  const forward = ptDot(direction, normal), denominator = Math.max(forward, .001);
  const edge = Math.max(Math.abs(ptDot(direction, right) / denominator) / width,
    Math.abs(ptDot(direction, up) / denominator) / height);
  return forward >= 0 ? 1 - smoothstep(.88, 1, edge) : 0;
}
/** Incident radiance from the existing environmentShader studio(), before any GGX prefilter. */
export function pathTraceStudioEnvironment(direction: PathTraceRgb): PathTraceVec3 {
  const d = ptNormalize(direction), sky = smoothstep(-.3, .9, d[1]);
  const key = softbox(d, [-1, 1.5, 1], .7, .35), rim = softbox(d, [1, .65, -1], .20, .8);
  const fill = softbox(d, [.3, 1.8, -.5], .8, .3);
  return [.025 + (.20 - .025) * sky + 5 * key + 2.8 * rim + 1.3 * fill,
    .03 + (.24 - .03) * sky + 4.8 * key + 3.4 * rim + 1.5 * fill,
    .04 + (.30 - .04) * sky + 4.4 * key + 4.2 * rim + 1.8 * fill];
}
