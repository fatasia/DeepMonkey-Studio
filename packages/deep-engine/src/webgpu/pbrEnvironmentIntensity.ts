/** Current Browser support range; not a restriction imposed by the asset format. */
export const MAX_PBR_ENVIRONMENT_INTENSITY = 64;

export function resolvePbrEnvironmentIntensity(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 0 || value > MAX_PBR_ENVIRONMENT_INTENSITY) {
    throw new RangeError(`PBR environmentIntensity must be finite and within 0..${MAX_PBR_ENVIRONMENT_INTENSITY}.`);
  }
  return value;
}

/** CPU reference for IBL radiance before BRDF evaluation and GI blending. */
export function scalePbrEnvironmentRadiance(rgb: readonly [number, number, number],
  intensity?: number): readonly [number, number, number] {
  const scale = resolvePbrEnvironmentIntensity(intensity);
  if (!rgb.every(value => Number.isFinite(value) && value >= 0)) {
    throw new RangeError("PBR environment radiance must be finite non-negative RGB.");
  }
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}
