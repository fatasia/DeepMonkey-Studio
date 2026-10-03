import { createPathTraceRenderPacketKernel, PathTraceCpuRender, pathTraceStudioEnvironment,
  encodeRadianceHdr } from "@bim-studio/deep-engine";
import type { PathTraceExportReceipt } from "@bim-studio/deep-engine";
import type { PathTraceAuthorPrepared } from "./pathTraceAuthorPreparation";

/** The single kernel recipe shared by the in-process reference session and every parallel band worker. */
export function createPathTraceAuthorKernel(prepared: PathTraceAuthorPrepared) {
  const environment = prepared.illumination === "white-furnace-reference" ? [1, 1, 1] as const
    : prepared.studioIntensity === 0 ? [0, 0, 0] as const : (direction: readonly [number, number, number]) =>
      pathTraceStudioEnvironment(direction).map(value => value * prepared.studioIntensity) as [number, number, number];
  return createPathTraceRenderPacketKernel({ packet: prepared.packet, camera: prepared.camera,
    width: prepared.config.width, height: prepared.config.height, environment, ...(prepared.lighting ? { lighting: prepared.lighting } : {}) });
}

/** Receipt shared by the reference session and the parallel coordinator so both stay field-identical. */
export function pathTraceAuthorReceipt(prepared: PathTraceAuthorPrepared, state: { readonly preview: boolean;
  readonly converged: boolean; readonly samples: number; readonly noise: number; readonly sessionReceipt: PathTraceExportReceipt | undefined }) {
  return Object.freeze({ illumination: prepared.illumination, preview: state.preview, converged: state.converged,
    eligibleFinal: !state.preview && state.converged, sourceHash: prepared.sourceHash,
    materialHash: prepared.identity.materialHash, camera: prepared.camera,
    samples: state.samples, noise: state.noise, varianceThreshold: prepared.config.varianceThreshold ?? .01,
    linearHdr: true, sessionReceipt: state.sessionReceipt,
    inapplicableRealtimeControls: prepared.inapplicableRealtimeControls });
}

/** Single-process reference owner (N=1 ground truth for tests); production renders through PathTraceParallelRender. */
export class PathTraceAuthorSession {
  readonly render: PathTraceCpuRender;
  constructor(readonly prepared: PathTraceAuthorPrepared) {
    const kernel = createPathTraceAuthorKernel(prepared);
    this.render = new PathTraceCpuRender(prepared.config);
    const result = this.render.begin(prepared.identity, kernel);
    if (result.status !== "started") { this.render.dispose(); throw new Error("物理出图超出累积内存预算。"); }
  }
  async accumulate(signal: AbortSignal, yieldControl: () => Promise<void>, onProgress: () => void): Promise<void> {
    try {
      while (!this.render.converged && this.render.session.sampleCount < this.prepared.config.maxSamples) {
        signal.throwIfAborted();
        await this.render.advanceAsync(1, yieldControl, signal);
        onProgress();
        await yieldControl();
      }
      signal.throwIfAborted();
    } catch (error) { this.cancel(); throw error; }
  }
  export(preview: boolean, currentSourceHash: string) {
    if (currentSourceHash !== this.prepared.sourceHash) { this.cancel(); throw new Error("场景已修改，旧累积不能导出。"); }
    const noise = this.render.maxRelativeStandardError;
    const converged = this.render.converged;
    const output = preview ? { bytes: encodeRadianceHdr(this.render.image()), receipt: undefined } : this.render.exportHdr();
    const bytes = output.bytes;
    const receipt = pathTraceAuthorReceipt(this.prepared, { preview, converged, samples: this.render.session.sampleCount,
      noise, sessionReceipt: output.receipt });
    return { bytes, receipt };
  }
  cancel(): void { this.render.cancel(); }
  dispose(): void { this.render.dispose(); }
}
