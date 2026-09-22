import type { ClusteredLights, PointLight, SpotLight } from "./types.js";

/**
 * Selects the most useful local lights for a bounded per-frame budget.
 *
 * The score is deliberately view-space and deterministic: bright, large-range,
 * nearby lights win, while a stable source-order tie break keeps temporal
 * history and captures reproducible. Directional lights are never budgeted.
 */
export function prioritizeLocalLights(lights: ClusteredLights, maxLocalLights: number): ClusteredLights {
  if (!Number.isSafeInteger(maxLocalLights) || maxLocalLights < 0) {
    throw new RangeError("maxLocalLights must be a non-negative safe integer.");
  }
  const points = lights.points ?? [], spots = lights.spots ?? [], total = points.length + spots.length;
  if (total <= maxLocalLights) return lights;
  const ranked = [
    ...points.map((light, index) => ({ kind: "point" as const, index, light, score: localLightScore(light) })),
    ...spots.map((light, index) => ({ kind: "spot" as const, index, light, score: localLightScore(light) })),
  ].sort((left, right) => right.score - left.score || kindOrder(left.kind) - kindOrder(right.kind) || left.index - right.index);
  const selected = new Set(ranked.slice(0, maxLocalLights).map(value => `${value.kind}:${value.index}`));
  const keep = <T>(values: readonly T[], kind: "point" | "spot"): readonly T[] =>
    values.filter((_, index) => selected.has(`${kind}:${index}`));
  return Object.freeze({
    ...(lights.directional ? { directional: lights.directional } : {}),
    ...(lights.lightProfiles ? { lightProfiles: lights.lightProfiles } : {}),
    points: Object.freeze([...keep(points, "point")]) as readonly PointLight[],
    spots: Object.freeze([...keep(spots, "spot")]) as readonly SpotLight[],
  });
}

function kindOrder(kind: "point" | "spot"): number { return kind === "point" ? 0 : 1; }

function localLightScore(light: PointLight): number {
  const color = light.color;
  const luminance = Math.max(0, 0.2126 * finiteOrZero(color[0]) + 0.7152 * finiteOrZero(color[1]) + 0.0722 * finiteOrZero(color[2]));
  const intensity = Math.max(0, Number.isFinite(light.intensity) ? light.intensity : 0);
  const range = Math.max(0, Number.isFinite(light.range) ? light.range : 0);
  const depth = Math.max(0.25, Math.hypot(finiteOrZero(light.positionView[0]), finiteOrZero(light.positionView[1]), finiteOrZero(light.positionView[2])));
  const cone = "outerConeCos" in light && typeof (light as Partial<SpotLight>).outerConeCos === "number"
    ? Math.max(0.05, (1 + (light as SpotLight).outerConeCos) * 0.5) : 1;
  const coverage = range === 0 ? 1 : range * range / (depth * depth);
  return luminance * intensity * coverage * cone;
}

function finiteOrZero(value: number | undefined): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
