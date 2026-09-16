import type { ChartIR } from "../chartIr.js";
import type { DashboardRect, DashboardRuntimeNodeV1 } from "./dashboardCompositionTypes.js";
import type { Deep2dRuntimePackage } from "./types.js";
import type { RuntimeResourcePrewarmAdapter, RuntimeResourcePrewarmCandidate,
  RuntimeResourcePrewarmRunOptions } from "./resourcePrewarmTypes.js";

export interface DashboardCandidateIdentity {
  readonly packageHash: string;
  readonly pageId: string;
  readonly generation: number;
  readonly deviceEpoch: number;
}
export interface DashboardCandidateNode {
  readonly node: DashboardRuntimeNodeV1;
  /** Page intersected with the translated explicit clip; frame is not an implicit clip. */
  readonly effectiveClip: DashboardRect;
  readonly deep2d: Deep2dRuntimePackage | null;
  readonly chart: Readonly<{ ir: ChartIR; dataRevision: number }> | null;
}
export interface DashboardPageCandidate {
  readonly identity: DashboardCandidateIdentity;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly DashboardCandidateNode[];
}
export type DashboardResourceLoader<TLoaded, TPrepared> = Pick<
  RuntimeResourcePrewarmAdapter<TLoaded, TPrepared>, "load" | "prepare" | "release">;

/** Requires a real host implementation. Preparing must never change the visible surface. */
export interface DashboardCandidateHost<TLoaded, TResource, TFrame> {
  currentDeviceEpoch(): number;
  /** Must enforce final combined frame/GPU budgets and clean its own allocations if it rejects. */
  prepare(page: DashboardPageCandidate,
    resources: readonly RuntimeResourcePrewarmCandidate<TLoaded, TResource>[], signal: AbortSignal): Promise<TFrame>;
  /** Synchronous visible switch after all rendering work succeeds. On throw the old surface must remain visible.
   * Must not reenter publish/dispose or expose callbacks between the visible switch and return.
   */
  commitVisible(frame: TFrame): void;
  release(frame: TFrame): void;
}
export interface DashboardCandidateOptions extends RuntimeResourcePrewarmRunOptions {
  readonly deviceEpoch: number;
  readonly pageId?: string;
  /** Required for data/simulation updates; rejects events from any previous publication. */
  readonly expectedSource?: DashboardCandidateIdentity;
  readonly updates?: readonly Readonly<{ nodeId: string; message: unknown }>[];
  readonly elapsedMs?: number;
}
export interface DashboardCandidateResult {
  readonly status: "committed" | "aborted" | "superseded" | "device-changed" | "busy" | "failed" | "requires-host";
  readonly identity?: DashboardCandidateIdentity;
  readonly failure?: string;
  readonly releaseFailures: readonly string[];
}
