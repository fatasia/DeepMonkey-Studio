import type { PathTraceRowRange } from "@bim-studio/deep-engine";
import type { PathTraceAuthorPrepared } from "./pathTraceAuthorPreparation";

/** One request → one reply per worker; the coordinator never has two commands in flight on a band. */
export type PathTraceAuthorWorkerInput =
  | { readonly kind: "init"; readonly prepared: PathTraceAuthorPrepared; readonly rows: readonly PathTraceRowRange[];
    readonly brightnessFloor: number }
  | { readonly kind: "step"; readonly preview: boolean }
  | { readonly kind: "snapshot"; readonly mean: boolean; readonly rgba: boolean }
  | { readonly kind: "dispose" };

type Rgba = Uint8ClampedArray<ArrayBuffer>;
export type PathTraceAuthorWorkerOutput =
  | { readonly kind: "ready" }
  | { readonly kind: "stepped"; readonly brightness: number; readonly noise: number; readonly samples: number;
    /** Worker-side wall time of the sample (incl. noise scan) and of the optional preview conversion. */
    readonly computeMs: number; readonly previewMs: number; readonly rgba?: Rgba }
  | { readonly kind: "snapshot"; readonly mean?: Float32Array<ArrayBuffer>; readonly rgba?: Rgba }
  | { readonly kind: "failed"; readonly message: string };

/** Minimal Worker surface so tests can run the real band host in-process. */
export interface PathTraceBandWorker {
  onmessage: ((event: { readonly data: PathTraceAuthorWorkerOutput }) => void) | null;
  onerror: ((event: { readonly message?: string }) => void) | null;
  postMessage(command: PathTraceAuthorWorkerInput): void;
  terminate(): void;
}
