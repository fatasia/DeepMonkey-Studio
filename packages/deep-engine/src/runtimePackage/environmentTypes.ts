import type { RuntimeContentHash } from "./types.js";

export const RUNTIME_IBL_MAX_BYTES = 64 * 1024 * 1024;
export interface RuntimeIblMip { readonly size: number; readonly dataBase64: string }
export interface RuntimePrefilteredIbl {
  readonly schema: "deep-engine.ibl-prefiltered";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly kind: "prefiltered-hdri";
  readonly format: "rgba16float";
  readonly encoding: "base64-le";
  readonly faceOrder: "px-nx-py-ny-pz-nz";
  /** Provenance declaration; resource contentHash separately authenticates the actual payload. */
  readonly source: { readonly contentHash: RuntimeContentHash; readonly license: string };
  readonly specular: { readonly mips: readonly RuntimeIblMip[] };
  readonly diffuse: { readonly mips: readonly RuntimeIblMip[] };
  readonly brdfLut: { readonly width: number; readonly height: number; readonly dataBase64: string };
}
