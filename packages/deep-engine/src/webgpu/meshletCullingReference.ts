/** CPU reference for the conservative four-sample depth comparison in the meshlet WGSL. */
export function meshletHiZVisible(objectNearDepth: number, farthestDepthSamples: readonly number[], reversedZ: boolean,
  depthBias = 0.0005): boolean {
  if (!Number.isFinite(objectNearDepth) || farthestDepthSamples.length < 1
    || !farthestDepthSamples.every(depth => Number.isFinite(depth) && depth >= 0 && depth <= 1)
    || typeof reversedZ !== "boolean" || !Number.isFinite(depthBias) || depthBias < 0 || depthBias > 1) return true;
  return reversedZ
    ? farthestDepthSamples.some(depth => objectNearDepth >= depth - depthBias)
    : farthestDepthSamples.some(depth => objectNearDepth <= depth + depthBias);
}

/** False means Hi-Z must be skipped and the meshlet kept visible. */
export function meshletHiZClipTestable(clipCorners: readonly (ArrayLike<number>)[], cameraInside: boolean,
  nearClipEpsilon = 1e-5): boolean {
  if (cameraInside || clipCorners.length !== 8 || !Number.isFinite(nearClipEpsilon) || nearClipEpsilon <= 0) return false;
  for (const corner of clipCorners) {
    if (!corner || corner.length !== 4) return false;
    const values = Array.from(corner);
    if (!values.every(Number.isFinite) || values[3]! <= nearClipEpsilon) return false;
    const depth = values[2]! / values[3]!;
    if (!Number.isFinite(depth) || depth <= 0 || depth >= 1) return false;
  }
  return true;
}
