export interface FrameCadenceDecision {
  render: boolean;
  anchorMs: number;
}

/**
 * Keeps a stable average cadence when requestAnimationFrame runs above the
 * requested rate. Carrying the fractional remainder avoids turning a 144 Hz
 * display into an accidental 48 fps cap.
 */
export function nextFrameCadence(
  nowMs: number,
  anchorMs: number | undefined,
  targetFps: number,
): FrameCadenceDecision {
  if (!Number.isFinite(nowMs) || !Number.isFinite(targetFps) || targetFps <= 0) {
    return { render: true, anchorMs: nowMs };
  }
  if (anchorMs === undefined || !Number.isFinite(anchorMs) || nowMs < anchorMs) {
    return { render: true, anchorMs: nowMs };
  }
  const intervalMs = 1_000 / targetFps;
  const elapsedMs = nowMs - anchorMs;
  if (elapsedMs < intervalMs) return { render: false, anchorMs };
  return {
    render: true,
    anchorMs: nowMs - (elapsedMs % intervalMs),
  };
}
