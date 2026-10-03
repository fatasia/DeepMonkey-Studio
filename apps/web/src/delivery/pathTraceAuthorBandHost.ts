import { PathTraceCpuBand, pathTraceBandRowCount } from "@bim-studio/deep-engine";
import { createPathTraceAuthorKernel } from "./pathTraceAuthorSession";
import { pathTraceAuthorPreview } from "./pathTraceAuthorPreview";
import type { PathTraceAuthorWorkerInput, PathTraceAuthorWorkerOutput } from "./pathTraceAuthorWorkerTypes";

/** Worker-side owner of one row band: builds its own kernel from the copied packet, never shares planes. */
export class PathTraceAuthorBandHost {
  private band: PathTraceCpuBand | undefined;
  private width = 0;
  private rows = 0;

  handle(command: PathTraceAuthorWorkerInput): PathTraceAuthorWorkerOutput | undefined {
    try {
      if (command.kind === "dispose") { this.band?.dispose(); this.band = undefined; return undefined; }
      if (command.kind === "init") {
        this.band?.dispose();
        const { prepared } = command;
        this.width = prepared.config.width; this.rows = pathTraceBandRowCount(command.rows);
        this.band = new PathTraceCpuBand(createPathTraceAuthorKernel(prepared), { width: this.width,
          height: prepared.config.height, ranges: command.rows, brightnessFloor: command.brightnessFloor,
          ...(prepared.config.sampleSeed === undefined ? {} : { sampleSeed: prepared.config.sampleSeed }) });
        return { kind: "ready" };
      }
      const band = this.band;
      if (!band) throw new Error("物理出图分块尚未初始化。");
      if (command.kind === "step") {
        const started = performance.now(), brightness = band.advanceSample(), noise = band.maxRelativeStandardError;
        const sampled = performance.now(), rgba = command.preview ? this.rgba(band) : undefined;
        return { kind: "stepped", brightness, noise, samples: band.sampleCount, computeMs: sampled - started,
          previewMs: performance.now() - sampled, ...(rgba ? { rgba } : {}) };
      }
      return { kind: "snapshot", ...(command.mean ? { mean: band.meanRows() } : {}), ...(command.rgba ? { rgba: this.rgba(band) } : {}) };
    } catch (error) { return { kind: "failed", message: error instanceof Error ? error.message : String(error) }; }
  }

  private rgba(band: PathTraceCpuBand) {
    return pathTraceAuthorPreview({ width: this.width, height: this.rows, data: band.meanRows() }).data;
  }
}

export function pathTraceAuthorTransferables(output: PathTraceAuthorWorkerOutput): Transferable[] {
  if (output.kind === "stepped") return output.rgba ? [output.rgba.buffer] : [];
  if (output.kind === "snapshot") return [...(output.mean ? [output.mean.buffer] : []), ...(output.rgba ? [output.rgba.buffer] : [])];
  return [];
}
