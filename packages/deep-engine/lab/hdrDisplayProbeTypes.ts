/** I-C21 真机探针共享类型(hdrDisplayGpuProbe / hdrDisplayProbeSession / runner)。 */

export interface HdrDetectionResult {
  readonly webgpuAvailable: boolean;
  readonly displayDynamicRange: "standard" | "high" | "unknown";
  readonly canvasFormatRgba16float: boolean;
  readonly canvasToneMappingExtended: boolean;
  readonly preferredCanvasFormat: string;
  readonly probeErrors: readonly string[];
  readonly policy: { readonly mode: string; readonly strategy: string; readonly failClosed: boolean;
    readonly reason: string };
  readonly canvasConfiguration: unknown;
}

export interface StrategyLegResult {
  readonly strategy: HdrDisplayStrategy | "sdr" | "furnace";
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
  readonly quantification?: unknown;
}

import type { HdrDisplayStrategy } from "../src/webgpu/hdrDisplayOutput.js";
