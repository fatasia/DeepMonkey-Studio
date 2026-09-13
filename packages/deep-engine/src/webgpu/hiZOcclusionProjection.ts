export function hiZOcclusionMip(rectWidthPixels: number, rectHeightPixels: number, mipLevelCount: number): number {
  if (![rectWidthPixels, rectHeightPixels].every(value => Number.isFinite(value) && value > 0)
    || !Number.isInteger(mipLevelCount) || mipLevelCount < 1) throw new Error("Invalid Hi-Z occlusion mip request.");
  return Math.min(Math.ceil(Math.log2(Math.max(rectWidthPixels, rectHeightPixels))), mipLevelCount - 1);
}

/** CPU reference for the four conservative samples used by the WGSL culler. */
export function hiZOcclusionVisible(objectNearDepth: number, farthestDepthSamples: readonly number[], reversedZ: boolean,
  depthBias = 0.0005): boolean {
  if (!Number.isFinite(objectNearDepth) || farthestDepthSamples.length < 1 || !farthestDepthSamples.every(Number.isFinite)
    || objectNearDepth <= 0 || objectNearDepth >= 1 || farthestDepthSamples.some(depth => depth < 0 || depth > 1)
    || !Number.isFinite(depthBias) || depthBias < 0) return true;
  return reversedZ
    ? farthestDepthSamples.some(depth => objectNearDepth >= depth - depthBias)
    : farthestDepthSamples.some(depth => objectNearDepth <= depth + depthBias);
}

export interface HiZOcclusionProjection {
  readonly testable: boolean;
  readonly reason?: "camera-inside" | "clip-boundary" | "screen-outside";
  /** True only when all valid projected corners lie beyond the same clip edge. */
  readonly culled?: boolean;
  readonly uvRect?: readonly [number, number, number, number];
  readonly objectNearDepth?: number;
  readonly mip?: number;
}

/** CPU reference for conservative screen projection and fail-open cases used by the WGSL path. */
export function projectHiZOcclusionAabb(center: readonly [number, number, number], radius: number,
  viewProjection: ArrayLike<number>, cameraPosition: readonly [number, number, number], viewport: readonly [number, number],
  mipLevelCount: number, reversedZ: boolean, nearClipEpsilon = 1e-5): HiZOcclusionProjection {
  if (![...center, radius, ...cameraPosition, ...viewport, nearClipEpsilon].every(Number.isFinite)
    || radius < 0 || viewProjection.length !== 16 || viewport.some(value => value <= 0)
    || !Number.isInteger(mipLevelCount) || mipLevelCount < 1 || nearClipEpsilon <= 0) {
    return Object.freeze({ testable: false, reason: "clip-boundary" });
  }
  const min = center.map(value => value - radius), max = center.map(value => value + radius);
  if (cameraPosition.every((value, axis) => value >= min[axis]! && value <= max[axis]!)) {
    return Object.freeze({ testable: false, reason: "camera-inside" });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let objectNearDepth = reversedZ ? 0 : 1;
  for (let corner = 0; corner < 8; corner++) {
    const x = corner & 1 ? max[0]! : min[0]!, y = corner & 2 ? max[1]! : min[1]!, z = corner & 4 ? max[2]! : min[2]!;
    const clip = [
      viewProjection[0]! * x + viewProjection[4]! * y + viewProjection[8]! * z + viewProjection[12]!,
      viewProjection[1]! * x + viewProjection[5]! * y + viewProjection[9]! * z + viewProjection[13]!,
      viewProjection[2]! * x + viewProjection[6]! * y + viewProjection[10]! * z + viewProjection[14]!,
      viewProjection[3]! * x + viewProjection[7]! * y + viewProjection[11]! * z + viewProjection[15]!,
    ];
    if (!clip.every(Number.isFinite) || clip[3]! <= nearClipEpsilon) return Object.freeze({ testable: false, reason: "clip-boundary" });
    const ndcX = clip[0]! / clip[3]!, ndcY = clip[1]! / clip[3]!, ndcZ = clip[2]! / clip[3]!;
    if (![ndcX, ndcY, ndcZ].every(Number.isFinite) || ndcZ <= 0 || ndcZ >= 1) {
      return Object.freeze({ testable: false, reason: "clip-boundary" });
    }
    minX = Math.min(minX, ndcX); minY = Math.min(minY, ndcY); maxX = Math.max(maxX, ndcX); maxY = Math.max(maxY, ndcY);
    objectNearDepth = reversedZ ? Math.max(objectNearDepth, ndcZ) : Math.min(objectNearDepth, ndcZ);
  }
  if (maxX <= -1 || minX >= 1 || maxY <= -1 || minY >= 1) {
    return Object.freeze({ testable: false, reason: "screen-outside", culled: true });
  }
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  const uvRect = [clamp01(minX * 0.5 + 0.5), clamp01(0.5 - maxY * 0.5),
    clamp01(maxX * 0.5 + 0.5), clamp01(0.5 - minY * 0.5)] as const;
  const mip = hiZOcclusionMip(Math.max(1, (uvRect[2] - uvRect[0]) * viewport[0]),
    Math.max(1, (uvRect[3] - uvRect[1]) * viewport[1]), mipLevelCount);
  return Object.freeze({ testable: true, uvRect, objectNearDepth, mip });
}
