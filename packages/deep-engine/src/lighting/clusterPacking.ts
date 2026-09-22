import type { ClusteredLights, DirectionalLight, LightVector3, PackedClusteredLights, PointLight, SpotLight } from "./types.js";

export const DIRECTIONAL_LIGHT_STRIDE = 32;
export const POINT_LIGHT_STRIDE = 32;
export const SPOT_LIGHT_STRIDE = 64;
export const LOCAL_LIGHT_BOUNDS_STRIDE = 16;
export const MAX_CLUSTERED_DIRECTIONAL_LIGHTS = 16;
export const MAX_CLUSTERED_LOCAL_LIGHTS = 65_535;
export const MAX_CLUSTERED_LIGHT_ABI_VALUE = 10_000_000_000;

function finiteVector(value: LightVector3, name: string, nonnegative = false): void {
  if (value.length !== 3 || !value.every(Number.isFinite) || (nonnegative && value.some(component => component < 0))) {
    throw new Error(`${name} must contain three ${nonnegative ? "finite nonnegative" : "finite"} values.`);
  }
}

function finiteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and nonnegative.`);
}

function direction(value: LightVector3, name: string): LightVector3 {
  finiteVector(value, name);
  const length = Math.hypot(...value);
  if (length < 1e-8) throw new Error(`${name} must be nonzero.`);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function validateLocal(light: PointLight, name: string): void {
  finiteVector(light.positionView, `${name}.positionView`);
  finiteVector(light.color, `${name}.color`, true);
  if (!Number.isFinite(light.range) || light.range < 0) throw new Error(`${name}.range must be finite and nonnegative.`);
  if (!Number.isFinite(light.decay ?? 2) || (light.decay ?? 2) < 0 || (light.decay ?? 2) > 4) throw new Error(`${name}.decay must be inside [0,4].`);
  finiteNonnegative(light.intensity, `${name}.intensity`);
}

function assertFloat32(values: Float32Array, name: string): void {
  if (!values.every(Number.isFinite)) throw new Error(`${name} contains a value that cannot be represented as finite float32.`);
  if (values.some(value => Math.abs(value) > MAX_CLUSTERED_LIGHT_ABI_VALUE)) {
    throw new Error(`${name} exceeds the bounded float32 lighting ABI value ${MAX_CLUSTERED_LIGHT_ABI_VALUE}.`);
  }
}

function packDirectional(lights: readonly DirectionalLight[]): Float32Array {
  const result = new Float32Array(lights.length * DIRECTIONAL_LIGHT_STRIDE / 4);
  lights.forEach((light, index) => {
    finiteVector(light.color, `directional[${index}].color`, true);
    finiteNonnegative(light.intensity, `directional[${index}].intensity`);
    const normalized = direction(light.directionView, `directional[${index}].directionView`);
    result.set([...normalized, light.intensity, ...light.color, 0], index * 8);
  });
  return result;
}

function packPoints(lights: readonly PointLight[]): Float32Array {
  const result = new Float32Array(lights.length * POINT_LIGHT_STRIDE / 4);
  lights.forEach((light, index) => {
    validateLocal(light, `points[${index}]`);
    result.set([...light.positionView, light.range,
      light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, (light.decay ?? 2) - 2], index * 8);
  });
  return result;
}

function packSpots(lights: readonly SpotLight[]): Float32Array {
  const result = new Float32Array(lights.length * SPOT_LIGHT_STRIDE / 4);
  lights.forEach((light, index) => {
    validateLocal(light, `spots[${index}]`);
    const normalized = direction(light.directionView, `spots[${index}].directionView`);
    if (!Number.isFinite(light.outerConeCos) || !Number.isFinite(light.innerConeCos)
      || light.outerConeCos < -1 || light.innerConeCos > 1 || light.outerConeCos > light.innerConeCos) {
      throw new Error(`spots[${index}] cone cosines must satisfy -1 <= outerConeCos < innerConeCos <= 1.`);
    }
    const coneScale = light.innerConeCos === light.outerConeCos ? 0 : 1 / (light.innerConeCos - light.outerConeCos);
    result.set([...light.positionView, light.range, ...normalized, light.outerConeCos,
      light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, coneScale,
      light.decay ?? 2, 0, 0, 0], index * 16);
  });
  return result;
}

/** Fixed shading ABI; scalar intensity is folded into radiance without changing pipeline layout. */
export function packClusteredLights(lights: ClusteredLights): PackedClusteredLights {
  const directionalLights = lights.directional ?? [], points = lights.points ?? [], spots = lights.spots ?? [];
  if (directionalLights.length > MAX_CLUSTERED_DIRECTIONAL_LIGHTS) {
    throw new Error(`Directional light count exceeds ${MAX_CLUSTERED_DIRECTIONAL_LIGHTS}.`);
  }
  if (points.length + spots.length > MAX_CLUSTERED_LOCAL_LIGHTS) {
    throw new Error(`Local light count exceeds ${MAX_CLUSTERED_LOCAL_LIGHTS}.`);
  }
  const directional = packDirectional(directionalLights), packedPoints = packPoints(points), packedSpots = packSpots(spots);
  const localBounds = new Float32Array((points.length + spots.length) * 4);
  points.forEach((light, index) => localBounds.set([...light.positionView, light.range], index * 4));
  spots.forEach((light, index) => localBounds.set([...light.positionView, light.range], (points.length + index) * 4));
  assertFloat32(directional, "directional lights"); assertFloat32(packedPoints, "point lights");
  assertFloat32(packedSpots, "spot lights"); assertFloat32(localBounds, "local light bounds");
  return {
    directional, points: packedPoints, spots: packedSpots, localBounds,
    directionalCount: directionalLights.length, pointCount: points.length, spotCount: spots.length,
  };
}
