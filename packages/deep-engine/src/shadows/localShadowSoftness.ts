export const LOCAL_SHADOW_PCSS_TAPS = 12;
export const LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS = 4;

export function resolveLocalShadowSoftness(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Local shadow softness must be in [0, 1].");
  return Math.fround(value);
}

/** CPU mirror of the bounded local PCSS penumbra radius used by WGSL. */
export function localShadowPcssRadius(receiverDepth: number, averageBlockerDepth: number,
  softness: number): number {
  const resolved = resolveLocalShadowSoftness(softness);
  if (!Number.isFinite(receiverDepth) || !Number.isFinite(averageBlockerDepth)
    || receiverDepth < 0 || averageBlockerDepth <= 0 || averageBlockerDepth >= receiverDepth || resolved === 0) return 1;
  return Math.min(LOCAL_SHADOW_PCSS_MAX_RADIUS_TEXELS,
    Math.max(1, (receiverDepth - averageBlockerDepth) / averageBlockerDepth * resolved * 64));
}

/** Slope-aware compare bias for the opt-in PCSS branch; legacy PCF keeps the authored constant bias. */
export function localShadowPcssDepthBias(depthBias: number, nDotL: number): number {
  if (!Number.isFinite(depthBias) || depthBias < 0 || !Number.isFinite(nDotL)) {
    throw new RangeError("Local shadow depth bias inputs must be finite and nonnegative.");
  }
  return depthBias * (1 + 2 * (1 - Math.min(1, Math.max(0, nDotL))));
}

/** Stable per-atlas-tile rotation; independent of frame time and light array ordering. */
export function localShadowPcssRotation(tileOffsetX: number, tileOffsetY: number): number {
  if (![tileOffsetX, tileOffsetY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new RangeError("Local shadow tile offset must be in [0, 1].");
  }
  const phase = ((tileOffsetX * 12.9898 + tileOffsetY * 78.233) % 1 + 1) % 1;
  return phase * Math.PI * 2;
}
