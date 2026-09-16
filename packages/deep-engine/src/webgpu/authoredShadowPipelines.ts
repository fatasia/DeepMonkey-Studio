import type { Pipelines } from "./pipelines.js";

const sets = new WeakMap<Pipelines, Pipelines>();
/** Selects unbiased rasterization without changing the default CSM or local shadow variants. */
export function authoredShadowPipelines(pipelines: Pipelines): Pipelines {
  const cached = sets.get(pipelines);
  if (cached) return cached;
  const shadowPipelines = new Map([...pipelines.shadowPipelines]
    .filter(([key]) => key.startsWith("author/")).map(([key, value]) => [key.slice(7), value]));
  const shadow = shadowPipelines.get("solid/ccw");
  if (!shadow || shadowPipelines.size !== 9) throw new Error("Authored shadow raster variants require a one-cascade renderer.");
  const value = { ...pipelines, shadow, shadowPipelines };
  sets.set(pipelines, value);
  return value;
}
