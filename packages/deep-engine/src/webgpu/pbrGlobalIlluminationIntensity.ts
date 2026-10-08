/** Probe irradiance gain; omission preserves the existing SDK output. */
export function resolvePbrGlobalIlluminationIntensity(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value < 0 || value > 16) {
    throw new RangeError("globalIlluminationIntensity must be finite and within 0..16.");
  }
  return value;
}

/** Use the existing reserved constant.w lane; RGB authored fill remains unchanged. */
export function packPbrGlobalIlluminationIntensity(coefficients: Float32Array<ArrayBuffer>, value?: number): void {
  if (coefficients.length !== 16) throw new RangeError("Expected the 64-byte diffuse irradiance ABI.");
  coefficients[3] = resolvePbrGlobalIlluminationIntensity(value) - 1;
}

export const PBR_PROBE_IRRADIANCE_GAIN_WGSL = "gi.rgb * max(1.0 + deepDiffuse.constant.w, 0.0)";
