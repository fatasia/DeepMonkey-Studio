/** CPU contract mirror used by camera-history integration tests and diagnostics. */
export function currentToPreviousUvMotion(currentClip: readonly number[], previousClip: readonly number[], jitterDeltaUv: readonly [number, number] = [0, 0]): readonly [number, number] {
  if (currentClip.length !== 4 || previousClip.length !== 4 || ![...currentClip, ...previousClip].every(Number.isFinite)
    || !jitterDeltaUv.every(Number.isFinite) || Math.abs(currentClip[3]!) < 1e-8 || Math.abs(previousClip[3]!) < 1e-8) throw new Error("Motion clip positions are invalid.");
  const uv = (clip: readonly number[]): readonly [number, number] => [
    clip[0]! / clip[3]! * 0.5 + 0.5, clip[1]! / clip[3]! * -0.5 + 0.5,
  ];
  const current = uv(currentClip), previous = uv(previousClip);
  return Object.freeze([Math.max(-2, Math.min(2, previous[0] - current[0] - jitterDeltaUv[0])),
    Math.max(-2, Math.min(2, previous[1] - current[1] - jitterDeltaUv[1]))]);
}
