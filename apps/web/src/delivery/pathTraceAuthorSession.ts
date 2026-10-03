import { createPathTraceRenderPacketKernel, PathTraceCpuRender, pathTraceStudioEnvironment,
  encodeRadianceHdr } from "@bim-studio/deep-engine";
import type { PathTraceAuthorPrepared } from "./pathTraceAuthorPreparation";

/** Thin owner usable by a dedicated worker and by CPU consumer tests. */
export class PathTraceAuthorSession {
  readonly render: PathTraceCpuRender;
  constructor(readonly prepared: PathTraceAuthorPrepared) {
    const environment = prepared.illumination === "white-furnace-reference" ? [1, 1, 1] as const
      : prepared.studioIntensity === 0 ? [0, 0, 0] as const : (direction: readonly [number, number, number]) =>
        pathTraceStudioEnvironment(direction).map(value => value * prepared.studioIntensity) as [number, number, number];
    const kernel = createPathTraceRenderPacketKernel({ packet: prepared.packet, camera: prepared.camera,
      width: prepared.config.width, height: prepared.config.height, environment, ...(prepared.lighting ? { lighting: prepared.lighting } : {}) });
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
    const receipt = Object.freeze({ illumination: this.prepared.illumination, preview, converged,
      eligibleFinal: !preview && converged, sourceHash: this.prepared.sourceHash,
      materialHash: this.prepared.identity.materialHash, camera: this.prepared.camera,
      samples: this.render.session.sampleCount, noise, varianceThreshold: this.prepared.config.varianceThreshold ?? .01,
      linearHdr: true, sessionReceipt: output.receipt,
      inapplicableRealtimeControls: this.prepared.inapplicableRealtimeControls });
    return { bytes, receipt };
  }
  cancel(): void { this.render.cancel(); }
  dispose(): void { this.render.dispose(); }
}
