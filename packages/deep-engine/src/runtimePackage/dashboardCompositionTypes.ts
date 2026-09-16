import type { ChartIrRuntimeValue, ChartSimRuntimeValue, Deep2dRuntimePackage } from "./types.js";

export const DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION = 5 as const;
export const DASHBOARD_RUNTIME_BUDGETS = Object.freeze({ pages: 32, nodes: 128, charts: 32, atlasBytes: 64 * 1024 * 1024 });
export type DashboardRect = readonly [number, number, number, number];
export interface DashboardRuntimeNodeV1 {
  readonly id: string;
  readonly revision: number;
  readonly frame: DashboardRect;
  readonly clip: DashboardRect | null;
  readonly zOrder: number;
  readonly visible: boolean;
  readonly hitId: string | null;
  readonly deep2d: string | null;
  readonly chart: string | null;
  readonly chartSim: string | null;
}
export interface DashboardRuntimePageV1 {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly DashboardRuntimeNodeV1[];
}
export interface DashboardRuntimeV1 {
  readonly schema: "deep-engine.dashboard-runtime";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly entryPageId: string;
  readonly pages: readonly DashboardRuntimePageV1[];
}
export interface BuildDashboardCompositionRuntimePackageInput {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly dashboard: DashboardRuntimeV1;
  readonly deep2d: readonly Deep2dRuntimePackage[];
  readonly charts: readonly ChartIrRuntimeValue[];
  readonly chartSims: readonly ChartSimRuntimeValue[];
}
