import { resolveTemporalAaCpu } from "./temporalAaCpu.js";
import type { TemporalAaOptions } from "./temporalAaTypes.js";

/**
 * Temporal response masks: per-pixel decisions about how much history a pixel may keep.
 *
 * Contract mirrors temporalValidity reason vocabulary and the TAA depth rejection formula
 * (temporalAaCpu.sampleHistory / temporalAaWgsl.sampleHistory): a history tap is rejected
 * when |historicalDepth - depth| > max(depthThreshold, depth * relativeDepthThreshold).
 * Transparent surfaces (weighted OIT path) and GPU particles never write the motion target,
 * so their region carries the opaque background motion and is marked reactive: history
 * feedback is scaled down by coverage instead of being trusted.
 */
export type TemporalMaskReason = "no-history" | "camera-cut" | "motion-unavailable" | "disocclusion" | "reactive-motion";

export interface TemporalResponseMaskInput {
  readonly width: number;
  readonly height: number;
  readonly currentDepth: readonly number[];
  readonly previousDepth: readonly number[];
  /** current-to-previous-uv motion, same encoding as TemporalAaSource.motion. */
  readonly motionUv: readonly number[];
  readonly historyValid: boolean;
  readonly cameraCut: boolean;
  readonly motionAvailable: boolean;
  /** Per-pixel transparent/particle coverage 0..255; omit for fully opaque frames. */
  readonly reactiveAlpha?: Uint8Array;
  readonly depthThreshold: number;
  readonly relativeDepthThreshold: number;
}

export interface TemporalResponseMask {
  /** 0 keeps full history feedback, 255 drops it entirely; values between scale feedback. */
  readonly mask: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly reasons: Readonly<Record<TemporalMaskReason, number>>;
  readonly fullResponsePixels: number;
  readonly partialResponsePixels: number;
}

export function buildTemporalResponseMask(input: TemporalResponseMaskInput): TemporalResponseMask {
  const { width, height } = input;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || input.currentDepth.length !== width * height || input.previousDepth.length !== width * height
    || input.motionUv.length !== width * height * 2) throw new Error("Response mask buffers do not match the frame size.");
  const reasons: Record<TemporalMaskReason, number> = { "no-history": 0, "camera-cut": 0, "motion-unavailable": 0, disocclusion: 0, "reactive-motion": 0 };
  const frameMask = new Uint8Array(width * height);
  if (input.cameraCut) reasons["camera-cut"] = width * height;
  else if (!input.historyValid) reasons["no-history"] = width * height;
  else if (!input.motionAvailable) reasons["motion-unavailable"] = width * height;
  const wholesale = reasons["camera-cut"] + reasons["no-history"] + reasons["motion-unavailable"] > 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (wholesale) { frameMask[pixel] = 255; continue; }
    const depth = input.currentDepth[pixel]!;
    let value = 0;
    if (depth > 0) {
      const px = pixel % width + 0.5 + input.motionUv[pixel * 2]! * width;
      const py = Math.floor(pixel / width) + 0.5 + input.motionUv[pixel * 2 + 1]! * height;
      const inside = px >= 0 && py >= 0 && px < width && py < height;
      const historical = inside ? input.previousDepth[Math.floor(py) * width + Math.floor(px)]! : 0;
      if (historical <= 0 || Math.abs(historical - depth) > Math.max(input.depthThreshold, depth * input.relativeDepthThreshold)) {
        reasons.disocclusion++; value = 255;
      }
    }
    const alpha = input.reactiveAlpha?.[pixel] ?? 0;
    if (alpha > 0) {
      // Reactive coverage reduces trusted feedback proportionally; it never hides disocclusion.
      value = Math.max(value, alpha);
      reasons["reactive-motion"]++;
    }
    frameMask[pixel] = value;
  }
  let fullResponsePixels = 0, partialResponsePixels = 0;
  for (const value of frameMask) { if (value === 255) fullResponsePixels++; else if (value > 0) partialResponsePixels++; }
  return Object.freeze({ mask: frameMask, width, height, reasons: Object.freeze(reasons), fullResponsePixels, partialResponsePixels });
}

/** Effective feedback after the response mask; matches the TAA feedback validation range. */
export function applyResponseFeedback(feedback: number, maskValue: number): number {
  if (!Number.isFinite(feedback) || feedback < 0 || feedback > 0.99 || !Number.isInteger(maskValue)
    || maskValue < 0 || maskValue > 255) throw new Error("Response feedback inputs are invalid.");
  return Math.max(0, Math.min(0.99, feedback * (1 - maskValue / 255)));
}

export interface FrameSlice {
  readonly color: readonly number[];
  readonly depth: readonly number[];
  readonly motion: readonly number[];
  readonly previousColor?: readonly number[];
  readonly previousDepth?: readonly number[];
  readonly historyValid: boolean;
  readonly cameraCut?: boolean;
  readonly currentJitter: readonly [number, number];
  readonly previousJitter: readonly [number, number];
}

export interface HistoryClearFrameReport {
  readonly frame: number;
  readonly cameraCut: boolean;
  /** Mean |output - currentColor| over RGB; 0 exactly when the frame ignored old history. */
  readonly residualToCurrent: number;
}

export interface HistoryClearProof {
  readonly frames: readonly HistoryClearFrameReport[];
  readonly cutFrame: number;
  readonly cutResidual: number;
  /** True when the cut frame output equals the current frame exactly (old history fully dropped). */
  readonly clearedInOneFrame: boolean;
}

/**
 * CPU proof that a camera cut clears old history within a single frame: the cut frame is
 * resolved with historyValid=false (TemporalAaPass marks "camera-cut" the same way), so its
 * output must equal the current frame color with zero residual, no matter what the stale
 * history contained.
 */
export function verifyCameraCutHistoryClear(width: number, height: number, frames: readonly FrameSlice[],
  options: TemporalAaOptions): HistoryClearProof {
  if (frames.length === 0) throw new Error("History clear proof requires at least one frame.");
  const reports: HistoryClearFrameReport[] = [];
  let cutFrame = -1, cutResidual = Number.NaN;
  frames.forEach((frame, frameIndex) => {
    const historyUsed = frame.historyValid && !frame.cameraCut;
    const resolved = resolveTemporalAaCpu({ width, height, color: frame.color, depth: frame.depth, motion: frame.motion,
      ...(historyUsed && frame.previousColor && frame.previousDepth
        ? { previousColor: frame.previousColor, previousDepth: frame.previousDepth } : {}),
      historyValid: historyUsed, currentJitter: frame.currentJitter, previousJitter: frame.previousJitter }, options);
    let residual = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      for (let channel = 0; channel < 3; channel++) residual += Math.abs(resolved[pixel * 4 + channel]! - frame.color[pixel * 4 + channel]!);
    }
    residual /= width * height * 3;
    if (frame.cameraCut) { cutFrame = frameIndex; cutResidual = residual; }
    reports.push({ frame: frameIndex, cameraCut: frame.cameraCut === true, residualToCurrent: residual });
  });
  return Object.freeze({ frames: Object.freeze(reports), cutFrame, cutResidual, clearedInOneFrame: cutFrame >= 0 && cutResidual === 0 });
}
