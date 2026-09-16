import type { WorldClusteredLights, WorldSpotLight } from "../lighting/worldLights.js";
import {
  planSharedShadowAtlas,
  type SharedShadowAtlasPlan,
  type SharedShadowAtlasRequest,
  type SharedShadowAtlasTile,
} from "../shadows/sharedShadowAtlas.js";
import { LOCAL_SPOT_SHADOW_MAX_LIGHTS } from "../shadows/localSpotShadowShader.js";
import { lookAt, multiply, perspective } from "./cameraMath.js";

export const LOCAL_SPOT_SHADOW_ATLAS_OPTIONS = Object.freeze({
  requestedAtlasSize: 1024,
  tilesPerAxis: 2,
  maxShadowedLights: LOCAL_SPOT_SHADOW_MAX_LIGHTS,
  maxShadowViews: LOCAL_SPOT_SHADOW_MAX_LIGHTS,
});

export interface SelectedLocalSpotShadow {
  readonly index: number;
  readonly light: WorldSpotLight;
  readonly tile: SharedShadowAtlasTile;
  readonly matrix: Float32Array<ArrayBuffer>;
  readonly signature: readonly (number | string)[];
}

export interface LocalSpotShadowSelection {
  readonly spots: readonly SelectedLocalSpotShadow[];
  readonly plan: SharedShadowAtlasPlan | undefined;
}

interface SpotCandidate {
  readonly key: string;
  readonly index: number;
  readonly light: WorldSpotLight;
  readonly importance: number;
  readonly matrix: Float32Array<ArrayBuffer>;
}

/** Plans stable importance-ranked spot tiles while reserving no cube-map point views. */
export function selectLocalSpotShadows(lights: WorldClusteredLights,
  resourcePlan: SharedShadowAtlasPlan): LocalSpotShadowSelection {
  const candidates = validCandidates(lights.spots ?? []).sort(compareCandidates);
  const pointRequests = (lights.points ?? []).flatMap((light) => light.shadow ? [{
    key: light.shadow.key, kind: "point" as const,
    importance: importance(light.shadow.importance, light.intensity),
  }] : []);
  const spotRequests: SharedShadowAtlasRequest[] = candidates.map(candidate => ({
    key: candidate.key, kind: "spot", importance: candidate.importance,
  }));
  const requests = [...pointRequests, ...spotRequests].sort(compareRequests);
  let plan: SharedShadowAtlasPlan;
  try {
    plan = planSharedShadowAtlas(requests, {
      maxTextureDimension2D: resourcePlan.atlasSize,
      maxDepthTextureBytes: resourcePlan.estimatedDepthTextureBytes,
    }, LOCAL_SPOT_SHADOW_ATLAS_OPTIONS);
  } catch {
    return Object.freeze({ spots: Object.freeze([]), plan: undefined });
  }
  const byKey = new Map(candidates.map(candidate => [candidate.key, candidate]));
  const selected = plan.allocations.flatMap(allocation => {
    if (allocation.kind !== "spot") return [];
    const candidate = byKey.get(allocation.key), tile = allocation.tiles[0];
    if (!candidate || !tile) return [];
    return [{ index: candidate.index, light: candidate.light, tile, matrix: candidate.matrix,
      signature: Object.freeze([candidate.key, candidate.index, ...candidate.light.positionWorld,
        ...candidate.light.directionWorld, candidate.light.range, candidate.light.outerConeCos,
        tile.slot, ...tile.uvOffset, ...tile.uvScale]) }];
  });
  return Object.freeze({ spots: Object.freeze(selected), plan });
}

function validCandidates(spots: readonly WorldSpotLight[]): SpotCandidate[] {
  return spots.flatMap((light, index) => {
    if (!light.shadow) return [];
    try {
      const direction = normalized(light.directionWorld);
      const up = Math.abs(direction[1]) > 0.99 ? [0, 0, 1] as const : [0, 1, 0] as const;
      const fov = Math.min(Math.PI - 1e-4, 2 * Math.acos(light.outerConeCos));
      const matrix = multiply(perspective(fov, 1,
        Math.min(Math.max(light.range * 0.001, 0.01), light.range * 0.5), light.range),
      lookAt(light.positionWorld, add(light.positionWorld, direction), up));
      return [{ key: light.shadow.key, index, light,
        importance: importance(light.shadow.importance, light.intensity), matrix }];
    } catch { return []; }
  });
}

function compareCandidates(left: SpotCandidate, right: SpotCandidate): number {
  return right.importance - left.importance || compareKeys(left.key, right.key) || left.index - right.index;
}
function compareRequests(left: SharedShadowAtlasRequest, right: SharedShadowAtlasRequest): number {
  return right.importance - left.importance || compareKeys(left.key, right.key)
    || (left.kind === right.kind ? 0 : left.kind === "point" ? -1 : 1);
}
function compareKeys(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function importance(authored: number | undefined, intensity: number): number {
  const value = authored ?? intensity;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
function normalized(value: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length <= 1e-8) throw new Error("Spot shadow direction is degenerate.");
  return [value[0] / length, value[1] / length, value[2] / length];
}
function add(left: readonly [number, number, number], right: readonly [number, number, number]): readonly [number, number, number] {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}
