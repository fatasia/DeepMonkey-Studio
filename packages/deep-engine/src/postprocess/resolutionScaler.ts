/**
 * Dynamic internal-resolution heuristic (pure logic; T07 first slice).
 *
 * Frame-time feedback drives an internal render scale with hysteresis, asymmetric
 * step sizes, a hard floor/ceiling and quantized ladder steps. The controller is
 * deterministic so the whole decision table is unit-testable; wiring into the WebGPU
 * surface sizing is a later integration slice (webgpu/ is outside this slice's
 * ownership).
 */
export interface ResolutionScalePolicy {
  readonly targetFrameMs: number;
  /** Half-width of the hold band: |frameMs - target| <= hysteresis keeps the scale. */
  readonly hysteresisMs: number;
  readonly minScale: number;
  readonly maxScale: number;
  readonly downStep: number;
  readonly upStep: number;
  /** Consecutive below-band frames required before one up-step is granted. */
  readonly upHoldFrames: number;
  /** Ladder quantization, e.g. 1/32; scales snap down onto multiples of it. */
  readonly quantize: number;
}

export const DEFAULT_RESOLUTION_SCALE_POLICY: ResolutionScalePolicy = Object.freeze({
  targetFrameMs: 16.67, hysteresisMs: 1.5, minScale: 0.5, maxScale: 1,
  downStep: 0.08, upStep: 0.04, upHoldFrames: 12, quantize: 1 / 32 });

export type ResolutionScaleAction = "hold" | "decrease" | "increase";
export type ResolutionScaleReason = "within-band" | "above-high-band" | "below-low-band"
  | "up-hold-warmup" | "at-floor" | "at-ceiling" | "quantized";

export interface ResolutionScaleDecision {
  readonly frame: number;
  readonly frameMs: number;
  readonly previousScale: number;
  readonly scale: number;
  readonly action: ResolutionScaleAction;
  readonly reason: ResolutionScaleReason;
  readonly belowBandRun: number;
}

const assertPolicy = (policy: ResolutionScalePolicy): void => {
  if (!(policy.targetFrameMs > 0) || !(policy.hysteresisMs >= 0) || !(policy.minScale > 0)
    || !(policy.maxScale > policy.minScale) || !(policy.downStep > 0) || !(policy.upStep > 0)
    || !(policy.upHoldFrames >= 1) || !(policy.quantize > 0)
    || ![policy.targetFrameMs, policy.hysteresisMs, policy.minScale, policy.maxScale, policy.downStep, policy.upStep, policy.quantize]
      .every(Number.isFinite)) throw new Error("Resolution scale policy is invalid.");
};

const quantizeScale = (scale: number, policy: ResolutionScalePolicy): number => {
  const steps = Math.round(scale / policy.quantize);
  return Math.max(policy.minScale, Math.min(policy.maxScale, steps * policy.quantize));
};

export class DynamicResolutionScaler {
  private readonly policy: ResolutionScalePolicy;
  private scaleValue: number;
  private frame = 0;
  private belowBandRun = 0;

  constructor(policy: ResolutionScalePolicy = DEFAULT_RESOLUTION_SCALE_POLICY, initialScale?: number) {
    assertPolicy(policy);
    this.policy = policy;
    this.scaleValue = initialScale === undefined ? policy.maxScale : quantizeScale(this.assertScale(initialScale), policy);
  }

  get scale(): number { return this.scaleValue; }

  /** Feed one frame time and receive the (possibly unchanged) scale decision. */
  observe(frameMs: number): ResolutionScaleDecision {
    const policy = this.policy;
    if (!Number.isFinite(frameMs) || frameMs <= 0) throw new Error("Frame time must be finite and positive.");
    const frame = this.frame++, previousScale = this.scaleValue;
    const highBand = policy.targetFrameMs + policy.hysteresisMs;
    const lowBand = policy.targetFrameMs - policy.hysteresisMs;
    let scale = previousScale, action: ResolutionScaleAction = "hold", reason: ResolutionScaleReason = "within-band";
    if (frameMs > highBand) {
      this.belowBandRun = 0;
      const candidate = quantizeScale(previousScale - policy.downStep, policy);
      if (candidate < previousScale) { scale = candidate; action = "decrease"; reason = candidate === policy.minScale ? "at-floor" : "above-high-band"; }
      else reason = "at-floor";
    } else if (frameMs < lowBand) {
      this.belowBandRun += 1;
      if (previousScale >= policy.maxScale) { this.belowBandRun = 0; reason = "at-ceiling"; }
      else if (this.belowBandRun >= policy.upHoldFrames) {
        const candidate = quantizeScale(previousScale + policy.upStep, policy);
        this.belowBandRun = 0;
        if (candidate > previousScale) { scale = candidate; action = "increase"; reason = "below-low-band"; }
        else reason = "at-ceiling";
      } else reason = "up-hold-warmup";
    } else this.belowBandRun = 0;
    this.scaleValue = scale;
    return Object.freeze({ frame, frameMs, previousScale, scale, action, reason, belowBandRun: this.belowBandRun });
  }

  reset(): void { this.frame = 0; this.belowBandRun = 0; this.scaleValue = quantizeScale(this.scaleValue, this.policy); }

  private assertScale(scale: number): number {
    if (!Number.isFinite(scale) || scale < this.policy.minScale || scale > this.policy.maxScale) throw new Error("Initial resolution scale is outside the policy range.");
    return scale;
  }
}

export interface InternalResolutionQualitySlot {
  /** False until the GPU sequence harness fills measured numbers; never report invented values. */
  readonly measured: boolean;
  readonly note: string;
  /** Present only when measured=true (see MeasuredResolutionQuality). */
  readonly ssim?: number;
  readonly edgeRetention?: number;
  readonly gpuCostRatio?: number;
}

export interface InternalResolutionReport {
  readonly scale: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  /** scale^2: fraction of output pixels actually rasterized. */
  readonly pixelRatio: number;
  /** 1 - pixelRatio: upper-bound raster/fill work saved versus full resolution. */
  readonly pixelSavingRatio: number;
  readonly quality: InternalResolutionQualitySlot;
}

export interface MeasuredResolutionQuality {
  /** Full-frame SSIM of the upsampled internal render against the native-resolution render. */
  readonly ssim: number;
  /** Thin-structure edge-pixel retention ratio (upsampled edges / native edges, 0-1). */
  readonly edgeRetention: number;
  /** Measured GPU frame cost at this scale versus scale 1.0 (wall clock ratio, 0-1). */
  readonly gpuCostRatio: number;
  readonly note: string;
}

/**
 * Dual quality/cost report for an internal-resolution mode (acceptance forbids
 * reporting GPU savings without the quality slot). Without measured data the report
 * stays honest with measured=false; the GPU sequence harness passes `quality` to
 * replace the placeholder with real numbers.
 */
export function internalResolutionReport(scale: number, outputWidth: number, outputHeight: number,
  quality?: MeasuredResolutionQuality): InternalResolutionReport {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1 || !Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight)
    || outputWidth < 1 || outputHeight < 1) throw new Error("Internal resolution report inputs are invalid.");
  const internalWidth = Math.max(1, Math.round(outputWidth * scale));
  const internalHeight = Math.max(1, Math.round(outputHeight * scale));
  const pixelRatio = (internalWidth * internalHeight) / (outputWidth * outputHeight);
  const qualitySlot = quality === undefined
    ? Object.freeze({ measured: false,
      note: "Quality metrics (edge retention on fences/thin tubes/blades/characters) require the GPU sequence harness; not measured in this slice." })
    : Object.freeze({ measured: true, ...quality });
  return Object.freeze({ scale, outputWidth, outputHeight, internalWidth, internalHeight,
    pixelRatio, pixelSavingRatio: 1 - pixelRatio, quality: qualitySlot });
}
