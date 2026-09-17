import type { BuildDeepRuntimePackageInput, DeepRuntimePackageV2, RuntimeContentHash, RuntimeResourceIndexEntry } from "./types.js";

export type XEvent = { readonly type: "pointer"; readonly data: { readonly x: number; readonly y: number } }
  | { readonly type: "key"; readonly data: { readonly code: "enter" | "escape" | "arrow-left" | "arrow-right" } };
export type XCall = { readonly op: "sequence"; readonly args: readonly XCall[] }
  | { readonly op: "read-clock" | "draw-random" }
  | { readonly op: "read-resource-byte"; readonly args: { readonly resource_id: string; readonly offset: number } }
  | { readonly op: "read-event"; readonly args: { readonly index: number } }
  | { readonly op: "emit-number"; readonly args: number };
export interface XRequest {
  readonly schemaVersion: 1;
  readonly expectedEpoch: number;
  readonly startedAtMs: number;
  readonly randomSeed: number;
  readonly resources: readonly { readonly id: string; readonly bytes: readonly number[] }[];
  readonly events: readonly XEvent[];
  readonly calls: readonly XCall[];
}
export interface XDynamicContent {
  readonly schemaVersion: 1;
  readonly lane: "experimental-x";
  readonly request: XRequest;
  readonly contentHash: RuntimeContentHash;
}
export interface XResourcePayload {
  readonly schema: "deep-engine.experimental-x-resource";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly content: XDynamicContent;
}
export type XResourceIndex = Omit<RuntimeResourceIndexEntry, "kind"> & { readonly kind: "experimental-x" };
/** 不加入普通player的DeepRuntimePackage union，调用方必须使用显式X加载器。 */
export interface ExperimentalXRuntimePackage extends Omit<DeepRuntimePackageV2, "schemaVersion" | "entrypoints" | "resources"> {
  readonly schemaVersion: 6;
  readonly entrypoints: Omit<DeepRuntimePackageV2["entrypoints"], "chart" | "chartSim"> & { readonly experimentalX: string };
  readonly resources: readonly (RuntimeResourceIndexEntry | XResourceIndex)[];
}
export interface BuildExperimentalXRuntimeInput extends Omit<BuildDeepRuntimePackageInput, "camera" | "chart" | "chartSim"> {
  readonly experimentalX: { readonly id: string; readonly revision: number; readonly request: XRequest };
}
