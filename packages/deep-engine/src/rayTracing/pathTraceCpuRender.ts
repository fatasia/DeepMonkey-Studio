import { encodeRadianceHdr } from "../textures/radianceHdrEncode.js";
import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import { PathTraceProductSession } from "./pathTraceSession.js";
import { classifyIdentityInvalidation, validatePathTraceConfig,
  type PathTraceSceneIdentity, type PathTraceSessionConfig } from "./pathTraceSessionTypes.js";
import { sampleBrightness, type PathTraceReferenceKernel } from "./pathTraceReferenceKernel.js";
import { validatePathTraceRgb } from "./pathTraceCpuTypes.js";

/** Real CPU pixel owner over the existing product session. Counts are spp, not pixel count. */
export class PathTraceCpuRender {
  readonly session: PathTraceProductSession;
  private readonly config;
  private mean: Float32Array<ArrayBuffer> | undefined;
  private m2: Float32Array<ArrayBuffer> | undefined;
  private kernel: PathTraceReferenceKernel | undefined;

  constructor(config: PathTraceSessionConfig) {
    this.config = validatePathTraceConfig(config);
    if (this.config.channelsPerSample !== 3 || this.config.bytesPerChannel !== 4) {
      throw new RangeError("CPU path trace requires RGB float32 accumulation.");
    }
    this.session = new PathTraceProductSession(config, bytes => {
      this.mean = new Float32Array(this.config.width * this.config.height * 3);
      this.m2 = new Float32Array(this.mean.length);
      return { bytes, dispose: () => { this.mean = undefined; this.m2 = undefined; } };
    });
  }

  begin(identity: PathTraceSceneIdentity, kernel: PathTraceReferenceKernel, signal?: AbortSignal) {
    if (!kernel || typeof kernel.traceSample !== "function") throw new TypeError("CPU path trace kernel is required.");
    const changed = classifyIdentityInvalidation(this.session.identity, identity);
    if (this.session.phase === "accumulating" || this.session.phase === "reaccumulating") {
      if (changed === "unchanged") {
        if (kernel !== this.kernel) throw new Error("Kernel replacement requires a new scene identity.");
        if (signal?.aborted) this.session.cancel();
        return { status: signal?.aborted ? "cancelled" : "unchanged", generation: this.session.generation };
      }
      this.session.invalidate("material-revision", identity);
      this.mean!.fill(0); this.m2!.fill(0);
    }
    // The old session's invalidated begin does not check abort; cancel before resuming.
    if (signal?.aborted && this.session.phase === "invalidated") {
      this.session.cancel();
      return { status: "cancelled", generation: this.session.generation };
    }
    const outcome = this.session.begin(Object.freeze({ ...identity }), signal === undefined ? {} : { signal });
    if (outcome.status === "started") this.kernel = kernel;
    return outcome;
  }

  /** Bounded synchronous work; caller schedules tiles/batches to yield to the event loop. */
  advance(samples: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(samples) || samples < 1) throw new RangeError("CPU path trace batch must be positive.");
    if (this.session.phase !== "accumulating" && this.session.phase !== "reaccumulating") {
      throw new Error(`CPU path trace cannot advance in ${this.session.phase}.`);
    }
    const start = this.session.sampleCount, generation = this.session.generation;
    if (start + samples > this.config.maxSamples) {
      const outcome = this.session.advanceBatch({ samples, brightnessSum: 0, brightnessSumSq: 0, generation }, signal === undefined ? {} : { signal });
      return Object.freeze({ ...outcome, converged: this.converged });
    }
    let brightnessSum = 0, brightnessSumSq = 0;
    const abort = () => signal?.aborted || generation !== this.session.generation;
    try {
      for (let ordinal = start; ordinal < start + samples; ordinal++) {
        let fullFrameBrightness = 0;
        for (let y = 0; y < this.config.height; y++) for (let x = 0; x < this.config.width; x++) {
          if (abort()) return this.cancelBatch(signal);
          const rgb = this.kernel!.traceSample(x, y, ordinal, this.config.sampleSeed ?? 0);
          if (abort()) return this.cancelBatch(signal);
          validatePathTraceRgb(rgb, "sample");
          fullFrameBrightness += sampleBrightness(rgb) / (this.config.width * this.config.height);
          const offset = (y * this.config.width + x) * 3;
          for (let channel = 0; channel < 3; channel++) {
            const index = offset + channel, delta = rgb[channel]! - this.mean![index]!;
            this.mean![index]! += delta / (ordinal + 1);
            this.m2![index]! += delta * (rgb[channel]! - this.mean![index]!);
            if (!Number.isFinite(this.mean![index]) || !Number.isFinite(this.m2![index])) {
              throw new RangeError("CPU path trace accumulation exceeds float32 range.");
            }
          }
        }
        brightnessSum += fullFrameBrightness;
        brightnessSumSq += fullFrameBrightness * fullFrameBrightness;
      }
      const outcome = this.session.advanceBatch({ samples, brightnessSum, brightnessSumSq, generation }, signal === undefined ? {} : { signal });
      return Object.freeze({ ...outcome, converged: this.converged });
    } catch (error) {
      this.session.cancel();
      throw error;
    }
  }

  /** Injected scheduler permits real event-loop cancellation without importing platform timers. */
  async advanceAsync(samples: number, yieldControl: () => Promise<void>, signal?: AbortSignal) {
    if (!Number.isSafeInteger(samples) || samples < 1 || typeof yieldControl !== "function") {
      throw new RangeError("CPU path trace async batch requires a sample count and scheduler.");
    }
    if (this.session.sampleCount + samples > this.config.maxSamples) return this.advance(samples, signal);
    const generation = this.session.generation;
    let outcome;
    for (let ordinal = 0; ordinal < samples; ordinal++) {
      if (ordinal > 0) await yieldControl();
      if (generation !== this.session.generation) throw new Error("CPU path trace async generation changed; stale work cannot publish.");
      outcome = this.advance(1, signal);
      if (outcome.status !== "advanced") return outcome;
    }
    return outcome!;
  }

  /** Copies prevent consumers retaining a mutable or later invalidated accumulation plane. */
  image(): RadianceHdrImage {
    if (!this.mean || this.session.sampleCount < 1) throw new Error("CPU path trace has no publishable image.");
    return { width: this.config.width, height: this.config.height, data: this.mean.slice() };
  }

  /** Every channel/pixel must satisfy the noise gate; a stable frame average alone is insufficient. */
  get maxRelativeStandardError(): number {
    const n = this.session.sampleCount;
    if (!this.mean || !this.m2 || n < 2) return Infinity;
    let maximum = 0;
    for (let i = 0; i < this.mean.length; i++) {
      const error = Math.sqrt(Math.max(0, this.m2[i]!) / (n - 1) / n)
        / Math.max(this.mean[i]!, this.config.brightnessFloor);
      maximum = Math.max(maximum, error);
    }
    return maximum;
  }

  get converged(): boolean {
    return this.session.converged && this.maxRelativeStandardError <= this.config.varianceThreshold;
  }

  exportHdr() {
    if (!this.converged) throw new Error("CPU path trace HDR export requires per-pixel convergence.");
    const bytes = encodeRadianceHdr(this.image());
    const receipt = this.session.export();
    return Object.freeze({ bytes, receipt });
  }

  cancel(): boolean { return this.session.cancel(); }
  dispose(): void { this.session.dispose(); this.kernel = undefined; }

  private cancelBatch(signal?: AbortSignal) {
    if (signal?.aborted) return this.session.advanceBatch({ samples: 1, brightnessSum: 0, brightnessSumSq: 0 }, { signal });
    throw new Error("CPU path trace batch generation changed; stale pixels cannot publish.");
  }
}
