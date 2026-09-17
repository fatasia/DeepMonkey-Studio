// 原 trim UV 先映射参数，再求 NURBS；不会把未知参数化当作 identity。
export function mapCurveParameter(map, value, domain) {
  if (!Number.isFinite(value) || !Array.isArray(domain) || domain.length !== 2
    || !domain.every(Number.isFinite) || domain[0] >= domain[1]
    || value < domain[0] || value > domain[1]) throw new Error('parameter-out-of-domain');
  if (map?.kind === 'identity') return value;
  if (map?.kind !== 'arc-angle') throw new Error('unsupported-parameter-map');
  const { breaks, angleRadians, domain: sourceDomain } = map;
  if (!Array.isArray(sourceDomain) || sourceDomain[0] !== domain[0] || sourceDomain[1] !== domain[1]
    || !Number.isFinite(angleRadians) || angleRadians <= 0 || angleRadians > 2 * Math.PI
    || !Array.isArray(breaks) || breaks.length < 2 || breaks.length > 5
    || breaks[0] !== domain[0] || breaks.at(-1) !== domain[1]
    || !breaks.every((x, i) => Number.isFinite(x) && (i === 0 || x > breaks[i - 1]))) {
    throw new Error('invalid-arc-parameter-map');
  }
  if (value === domain[1]) return value;
  const index = breaks.findIndex((end, i) => i > 0 && value < end) - 1;
  const start = breaks[index], end = breaks[index + 1];
  const angle = angleRadians * (end - start) / (domain[1] - domain[0]);
  if (angle > Math.PI / 2 + 1e-12) throw new Error('invalid-arc-span');
  const offset = angle * (value - start) / (end - start);
  const a = Math.sin(offset / 2), b = Math.sin((angle - offset) / 2);
  return start + (end - start) * a / (a + b);
}

export function mapSurfaceParameter(surface, uv) {
  if (!Array.isArray(uv) || uv.length !== 2) throw new Error('invalid-surface-parameter');
  const map = surface.parameterMap;
  const axes = map?.kind === 'identity' ? [map, map] : map?.kind === 'separable' ? map.axes : null;
  if (!Array.isArray(axes) || axes.length !== 2) throw new Error('unsupported-parameter-map');
  return uv.map((value, axis) => mapCurveParameter(axes[axis], value, surface.domain[axis]));
}

// Cox–de Boor 基函数，供独立误差审核和后续受限离散器使用。
function basis(knots, degree, count, value) {
  if (!Number.isFinite(value) || value < knots[degree] || value > knots[count]) throw new Error('nurbs-out-of-domain');
  let weights = Array.from({ length: knots.length - 1 }, (_, i) =>
    (knots[i] <= value && value < knots[i + 1]) || (value === knots[count] && i === count - 1) ? 1 : 0);
  for (let order = 1; order <= degree; order++) {
    weights = weights.slice(0, -1).map((_, i) => {
      const left = knots[i + order] - knots[i], right = knots[i + order + 1] - knots[i + 1];
      return (left ? (value - knots[i]) / left * weights[i] : 0)
        + (right ? (knots[i + order + 1] - value) / right * weights[i + 1] : 0);
    });
  }
  return weights.slice(0, count);
}
function combine(nurbs, weights) {
  const point = Array(nurbs.dimension).fill(0); let denominator = 0;
  for (let i = 0; i < weights.length; i++) {
    const cv = nurbs.controlPoints[i], weight = weights[i];
    for (let axis = 0; axis < point.length; axis++) point[axis] += weight * cv[axis];
    denominator += weight * (nurbs.rational ? cv[nurbs.dimension] : 1);
  }
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-15) throw new Error('singular-nurbs-weight');
  return point.map(value => value / denominator);
}
export function evaluateCurve(curve, value) {
  return combine(curve, basis(curve.knots, curve.degree, curve.controlPoints.length, value));
}
export function evaluateSurface(surface, uv) {
  const axes = uv.map((value, axis) => basis(surface.knots[axis], surface.degree[axis], surface.controlPointCount[axis], value));
  return combine(surface, axes[1].flatMap(v => axes[0].map(u => u * v)));
}
