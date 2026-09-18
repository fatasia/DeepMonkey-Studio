import type { DashboardRect } from "./dashboardCompositionTypes.js";

export interface DashboardFrozenTableV1 {
  readonly id: string;
  readonly pageId: string;
  readonly nodeIds: readonly string[];
  readonly title: string;
  /** One family without a select, otherwise one for each select option in the same order. */
  readonly families: readonly { readonly orders: readonly DashboardTableOrderV1[] }[];
}
export interface DashboardTableOrderV1 {
  readonly column: string | null;
  readonly direction: "asc" | "desc" | null;
  readonly exports: { readonly csv: string; readonly xlsx: string };
  readonly pages: readonly {
    readonly layers: readonly { readonly nodeId: string; readonly deep2d: string; readonly clip: DashboardRect | null;
      /** Placement of the slot content relative to the shared widget frame; keeps text geometry position-independent. */
      readonly origin?: readonly [number, number] }[];
    readonly controls: readonly {
      readonly action: "csv" | "xlsx" | "sort" | "previous" | "next";
      readonly column: string | null;
      readonly rect: DashboardRect;
      readonly enabled: boolean;
    }[];
  }[];
}
