import type { LightVector3 } from "./types.js";
import type { WorldClusteredLights, WorldDirectionalLight } from "./worldLights.js";

export interface PbrPrimaryDirectionalLight {
  /** Direction travelled by the light, used to build the shadow cameras. */
  readonly rayDirectionWorld: LightVector3;
  /** Opposite of rayDirectionWorld, used by the surface BRDF. */
  readonly surfaceToLightWorld: LightVector3;
  readonly color: LightVector3;
  readonly intensity: number;
}

export interface PbrSceneLighting {
  readonly primary: PbrPrimaryDirectionalLight;
  readonly clustered: WorldClusteredLights;
}

const DEFAULT_PRIMARY_SOURCE: WorldDirectionalLight = Object.freeze({
  directionWorld: [-1.6, -2.8, -1.2] as const, color: [2.5, 2.4, 2.25] as const, intensity: 1,
});

const DEFAULT_CLUSTERED_LIGHTS: WorldClusteredLights = Object.freeze({
  directional: Object.freeze([Object.freeze({
    directionWorld: [0.8, -0.4, 0.6] as const, color: [0.2, 0.25, 0.35] as const, intensity: 1,
  })]),
});

export const DEFAULT_PBR_PRIMARY_DIRECTIONAL_LIGHT = primaryFrom(DEFAULT_PRIMARY_SOURCE);

/** Reserves the first authored directional light as the shadow-casting sun. */
export function resolvePbrSceneLighting(lights?: WorldClusteredLights): PbrSceneLighting {
  const authoredDirectional = lights?.directional ?? [];
  const primary = authoredDirectional[0] ? primaryFrom(authoredDirectional[0]) : DEFAULT_PBR_PRIMARY_DIRECTIONAL_LIGHT;
  const clustered = lights ? Object.freeze({
    ...(authoredDirectional.length > 1 ? { directional: Object.freeze(authoredDirectional.slice(1)) } : {}),
    ...(lights.points ? { points: lights.points } : {}),
    ...(lights.spots ? { spots: lights.spots } : {}),
  }) : DEFAULT_CLUSTERED_LIGHTS;
  return Object.freeze({ primary, clustered });
}

function primaryFrom(source: WorldDirectionalLight): PbrPrimaryDirectionalLight {
  const rayDirectionWorld = normalized(source.directionWorld, "primary directional light direction");
  const color = finiteNonNegativeVector(source.color, "primary directional light color");
  if (!Number.isFinite(source.intensity) || source.intensity < 0) {
    throw new RangeError("Primary directional light intensity must be finite and non-negative.");
  }
  return Object.freeze({
    rayDirectionWorld,
    surfaceToLightWorld: Object.freeze(rayDirectionWorld.map(value => value === 0 ? 0 : -value)) as unknown as LightVector3,
    color,
    intensity: source.intensity,
  });
}

function normalized(value: LightVector3, label: string): LightVector3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
    throw new TypeError(`${label} must be a finite vec3.`);
  }
  const length = Math.hypot(...value);
  if (length <= 1e-8) throw new RangeError(`${label} must be non-zero.`);
  return Object.freeze(value.map(component => component / length)) as unknown as LightVector3;
}

function finiteNonNegativeVector(value: LightVector3, label: string): LightVector3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(component => Number.isFinite(component) && component >= 0)) {
    throw new RangeError(`${label} must be a finite non-negative vec3.`);
  }
  return Object.freeze([...value]) as unknown as LightVector3;
}
