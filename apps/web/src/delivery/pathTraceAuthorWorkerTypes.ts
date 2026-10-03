import type { PathTraceAuthorPrepared } from "./pathTraceAuthorPreparation";
import type { PathTraceAuthorSession } from "./pathTraceAuthorSession";
export type PathTraceAuthorWorkerInput = { readonly kind: "start"; readonly prepared: PathTraceAuthorPrepared }
  | { readonly kind: "export"; readonly preview: boolean; readonly sourceHash: string } | { readonly kind: "cancel" };
export type PathTraceAuthorWorkerOutput = { readonly kind: "progress"; readonly samples: number; readonly noise: number;
  readonly converged: boolean; readonly done: boolean; readonly image: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray<ArrayBuffer> } }
  | { readonly kind: "exported"; readonly output: ReturnType<PathTraceAuthorSession["export"]> }
  | { readonly kind: "failed"; readonly message: string };
