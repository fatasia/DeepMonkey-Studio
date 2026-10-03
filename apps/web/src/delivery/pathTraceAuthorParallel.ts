import { encodeRadianceHdr, partitionPathTraceRows, PathTraceProductSession, scatterPathTraceBandRows,
  validatePathTraceConfig, type PathTraceRowRange } from "@bim-studio/deep-engine";
import { pathTraceAuthorReceipt } from "./pathTraceAuthorSession";
import type { PathTraceAuthorPrepared } from "./pathTraceAuthorPreparation";
import type { PathTraceAuthorWorkerInput, PathTraceAuthorWorkerOutput, PathTraceBandWorker } from "./pathTraceAuthorWorkerTypes";

type Rgba = Uint8ClampedArray<ArrayBuffer>;
export interface PathTraceParallelOptions {
  readonly workers: number;
  readonly stripeRows?: number;
  readonly previewIntervalMs?: number;
  readonly now?: () => number;
  readonly crossOriginIsolated?: boolean;
}
export interface PathTraceParallelFrame { readonly width: number; readonly height: number; readonly data: Rgba;
  readonly samples: number; readonly converged: boolean }
export interface PathTraceParallelProgress { readonly image: { readonly width: number; readonly height: number; readonly data: Rgba };
  readonly samples: number; readonly noise: number; readonly converged: boolean; readonly done: boolean;
  readonly elapsedMs: number; readonly samplesPerSecond: number }
interface Pending { resolve(value: PathTraceAuthorWorkerOutput): void; reject(error: unknown): void }

const abortError = () => new DOMException("物理出图已取消。", "AbortError");

/**
 * Main-thread coordinator over N row-band workers. Samples advance in lock-step (one ordinal per round) so every
 * band always holds the same spp, the convergence gate sees the same state as the single-thread kernel, and the
 * result is independent of scheduling. Cancel terminates every worker at once (mid-sample) and drops all planes.
 */
export class PathTraceParallelRender {
  readonly session: PathTraceProductSession;
  readonly bands: readonly (readonly PathTraceRowRange[])[];
  private readonly workers: PathTraceBandWorker[] = [];
  private readonly pending: (Pending | undefined)[] = [];
  private readonly resolved: ReturnType<typeof validatePathTraceConfig>;
  private readonly width: number;
  private readonly height: number;
  private latchedConverged: boolean | undefined;
  private readonly now: () => number;
  private rgba: Rgba | undefined;
  private rgbaSamples = -1;
  private noiseValue = Infinity;
  private startedAt = 0;
  private elapsed = 0;
  private stopRequested = false;
  private released = false;
  private roundWallMs = 0;
  private computeMs = 0;
  private previewMs = 0;

  constructor(readonly prepared: PathTraceAuthorPrepared, createWorker: () => PathTraceBandWorker,
    private readonly options: PathTraceParallelOptions) {
    this.resolved = validatePathTraceConfig(prepared.config);
    this.width = prepared.config.width; this.height = prepared.config.height;
    this.now = options.now ?? (() => performance.now());
    this.bands = partitionPathTraceRows(this.height, Math.max(1, Math.floor(options.workers)), options.stripeRows ?? 4);
    this.session = new PathTraceProductSession(prepared.config, bytes => ({ bytes, dispose: () => undefined }));
    const started = this.session.begin(prepared.identity);
    if (started.status !== "started") throw new Error("物理出图超出累积内存预算。");
    try {
      this.bands.forEach((_, index) => {
        const worker = createWorker();
        worker.onmessage = event => this.settle(index, event.data);
        worker.onerror = event => this.settle(index, { kind: "failed", message: event.message || "出图线程异常终止。" });
        this.workers.push(worker);
      });
    } catch (error) { this.release(); this.session.dispose(); throw error; }
  }

  get workerCount(): number { return this.bands.length; }
  get noise(): number { return this.noiseValue; }
  get converged(): boolean {
    return this.latchedConverged ?? (this.session.converged && this.noiseValue <= this.resolved.varianceThreshold);
  }

  /** Ends accumulation after the sample in flight; the partial image stays exportable as a preview. */
  requestStop(): void { this.stopRequested = true; }

  async run(signal: AbortSignal, onProgress: (progress: PathTraceParallelProgress) => void): Promise<void> {
    const baseInterval = this.options.previewIntervalMs ?? 250;
    let interval = baseInterval;
    try {
      await Promise.all(this.bands.map((rows, index) => this.call(index,
        { kind: "init", prepared: this.prepared, rows, brightnessFloor: this.resolved.brightnessFloor })));
      this.startedAt = this.now();
      let lastPreview = this.startedAt;
      while (!this.converged && this.session.sampleCount < this.resolved.maxSamples
        && !(this.stopRequested && this.session.sampleCount >= 1)) {
        signal.throwIfAborted();
        const roundStart = this.now(), wantPreview = roundStart - lastPreview >= interval;
        const replies = await Promise.all(this.bands.map((_, index) => this.call(index, { kind: "step", preview: wantPreview })));
        signal.throwIfAborted();
        this.roundWallMs += this.now() - roundStart;
        let frame = 0, noise = 0, previewCost = 0;
        replies.forEach((reply, index) => {
          if (reply.kind !== "stepped") throw new Error("物理出图线程返回了意外消息。");
          frame += reply.brightness; noise = Math.max(noise, reply.noise);
          this.computeMs += reply.computeMs; previewCost = Math.max(previewCost, reply.previewMs);
          if (reply.rgba) this.mergeRgba(index, reply.rgba);
        });
        const outcome = this.session.advanceBatch({ samples: 1, brightnessSum: frame, brightnessSumSq: frame * frame,
          generation: this.session.generation });
        if (outcome.status !== "advanced") throw new Error("物理出图累积被会话拒绝。");
        this.noiseValue = noise; this.elapsed = this.now() - this.startedAt;
        if (wantPreview) {
          this.previewMs += previewCost; interval = Math.max(baseInterval, previewCost * 6);
          this.rgbaSamples = this.session.sampleCount; lastPreview = this.now();
          onProgress(this.progress(false));
        }
      }
      signal.throwIfAborted();
      await this.refresh(false, true);
      onProgress(this.progress(true));
    } catch (error) { this.cancel(); throw error; }
  }

  /** Tone-mapped sRGB frame that matches the current spp; refreshed from the live bands when stale. */
  async frame(): Promise<PathTraceParallelFrame> {
    if (this.rgbaSamples !== this.session.sampleCount && !this.released) await this.refresh(false, true);
    if (!this.rgba || this.rgbaSamples !== this.session.sampleCount) throw new Error("物理出图没有可导出的图像。");
    return { width: this.width, height: this.height, data: new Uint8ClampedArray(this.rgba), samples: this.session.sampleCount,
      converged: this.converged };
  }

  /** Same byte stream and receipt fields as PathTraceAuthorSession.export; final export releases workers and lease. */
  async exportHdr(preview: boolean, currentSourceHash: string) {
    if (currentSourceHash !== this.prepared.sourceHash) { this.cancel(); throw new Error("场景已修改，旧累积不能导出。"); }
    const converged = this.converged;
    if (!preview && !converged) throw new Error("CPU path trace HDR export requires per-pixel convergence.");
    const mean = await this.refresh(true, true);
    if (!preview) this.latchedConverged = converged;
    const bytes = encodeRadianceHdr({ width: this.width, height: this.height, data: mean! });
    const sessionReceipt = preview ? undefined : this.session.export();
    const receipt = this.describe(preview, sessionReceipt);
    if (!preview) this.release();
    return { bytes, receipt };
  }

  /** Receipt for any export of the current accumulation; `preview` is true unless the noise gate has passed. */
  describe(preview: boolean, sessionReceipt: ReturnType<PathTraceProductSession["export"]> | undefined = undefined) {
    return Object.freeze({ ...pathTraceAuthorReceipt(this.prepared, { preview, converged: this.converged, samples: this.session.sampleCount,
      noise: this.noiseValue, sessionReceipt }),
      parallel: Object.freeze({ workers: this.workerCount, stripeRows: this.options.stripeRows ?? 4,
        bandRows: this.bands.map(ranges => ranges.reduce((sum, range) => sum + range.end - range.start, 0)),
        seed: this.prepared.config.sampleSeed ?? 0, transport: "structured-clone" as const,
        crossOriginIsolated: this.options.crossOriginIsolated ?? false,
        sampleComputeMs: Math.round(this.computeMs), roundWallMs: Math.round(this.roundWallMs), previewMs: Math.round(this.previewMs),
        efficiency: this.roundWallMs > 0 ? this.computeMs / (this.workerCount * this.roundWallMs) : 0,
        elapsedMs: Math.round(this.elapsed), samplesPerSecond: this.elapsed > 0 ? this.session.sampleCount * 1000 / this.elapsed : 0 }) });
  }

  /** Terminates all workers immediately and releases every plane. Idempotent. */
  cancel(): void {
    this.release();
    if (this.session.disposed) return;
    this.session.cancel(); this.session.dispose();
  }
  dispose(): void { this.cancel(); }

  private progress(done: boolean): PathTraceParallelProgress {
    const samples = this.session.sampleCount;
    return { image: { width: this.width, height: this.height, data: new Uint8ClampedArray(this.rgba!) }, samples,
      noise: this.noiseValue, converged: this.converged, done, elapsedMs: this.elapsed,
      samplesPerSecond: this.elapsed > 0 ? samples * 1000 / this.elapsed : 0 };
  }

  private mergeRgba(index: number, rgba: Rgba): void {
    this.rgba ??= new Uint8ClampedArray(this.width * this.height * 4);
    scatterPathTraceBandRows(this.bands[index]!, rgba, this.width, 4, this.rgba);
  }

  /** Pulls the current rgba (and optionally the float mean) from every band. */
  private async refresh(mean: boolean, rgba: boolean): Promise<Float32Array<ArrayBuffer> | undefined> {
    if (this.released) {
      if (mean) throw new Error("物理出图线程已释放，无法再读取线性像素。");
      return undefined;
    }
    const replies = await Promise.all(this.bands.map((_, index) => this.call(index, { kind: "snapshot", mean, rgba })));
    const plane = mean ? new Float32Array(this.width * this.height * 3) : undefined;
    replies.forEach((reply, index) => {
      if (reply.kind !== "snapshot") throw new Error("物理出图线程返回了意外消息。");
      if (reply.rgba) this.mergeRgba(index, reply.rgba);
      if (plane && reply.mean) scatterPathTraceBandRows(this.bands[index]!, reply.mean, this.width, 3, plane);
    });
    if (rgba) this.rgbaSamples = this.session.sampleCount;
    return plane;
  }

  private call(index: number, command: PathTraceAuthorWorkerInput): Promise<PathTraceAuthorWorkerOutput> {
    return new Promise((resolve, reject) => {
      if (this.released) { reject(abortError()); return; }
      this.pending[index] = { resolve, reject };
      this.workers[index]!.postMessage(command);
    });
  }

  private settle(index: number, output: PathTraceAuthorWorkerOutput): void {
    const pending = this.pending[index]; this.pending[index] = undefined;
    if (output.kind === "failed") pending?.reject(new Error(output.message)); else pending?.resolve(output);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    for (const worker of this.workers) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
    this.workers.length = 0;
    this.pending.forEach(pending => pending?.reject(abortError())); this.pending.length = 0;
  }
}
