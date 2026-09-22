import type { ChartIrRuntimeValue, ChartSimRuntimeValue, Deep2dRuntimePackage } from "./types.js";

export const DEEP_RUNTIME_PACKAGE_DASHBOARD_VERSION = 5 as const;
export const DASHBOARD_RUNTIME_BUDGETS = Object.freeze({ pages: 32, nodes: 128, charts: 32, atlasBytes: 64 * 1024 * 1024 });
export type DashboardRect = readonly [number, number, number, number];
export interface DashboardFrozenFilterV1 {
  readonly presentation?: { readonly kind: "select-v1"; readonly rowHeight: number; readonly visibleRows: number };
  readonly nodeId: string;
  readonly sourceNodeId: string;
  readonly key: string;
  readonly options: readonly { readonly value: string; readonly updates: readonly {
    readonly nodeId: string;
    readonly datasets: readonly { readonly datasetId: string; readonly rows: readonly (readonly (string | number | boolean | null)[])[] }[];
  }[]; readonly visibility?: readonly { readonly nodeId: string; readonly visible: boolean }[] }[];
}
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
  readonly media?: readonly import("./dashboardVideoTypes.js").DashboardVideoMediaV1[];
  readonly videos?: readonly import("./dashboardVideoTypes.js").DashboardVideoDiagnosticV1[];
  readonly textInputs?: readonly import("./dashboardTextInputTypes.js").DashboardTextInputV1[];
  readonly textInput?: import("./dashboardTextInputTypes.js").DashboardTextInputV1;
  readonly tables?: readonly import("./dashboardTableTypes.js").DashboardFrozenTableV1[];
  readonly schema: "deep-engine.dashboard-runtime";
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly documentId: string;
  readonly documentRevision: number;
  readonly entryPageId: string;
  readonly pages: readonly DashboardRuntimePageV1[];
  readonly filter?: DashboardFrozenFilterV1;
}
export interface BuildDashboardCompositionRuntimePackageInput {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly dashboard: DashboardRuntimeV1;
  readonly deep2d: readonly Deep2dRuntimePackage[];
  readonly charts: readonly ChartIrRuntimeValue[];
  readonly chartSims: readonly ChartSimRuntimeValue[];
}
