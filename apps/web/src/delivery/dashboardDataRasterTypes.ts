import type { JsonValue } from "@bim-studio/contracts";
import type { DashboardRasterTextStyle } from "./dashboardRasterTypes";

export type DashboardDataTextRole = { readonly kind: "title" | "value" | "unit" | "footer" | "previous" | "next" | "row-number-header" }
  | { readonly kind: "header" | "sort" | "total"; readonly column: string }
  | { readonly kind: "cell"; readonly row: number; readonly column: string }
  | { readonly kind: "row-number"; readonly row: number };
export interface DashboardDataTextBox {
  readonly role: DashboardDataTextRole;
  /** Measured node-local Web CSS box and clipping rectangle, without fabricated column widths. */
  readonly rect: readonly [number, number, number, number];
  readonly clip: readonly [number, number, number, number] | null;
  readonly style: DashboardRasterTextStyle;
  readonly verticalAlign: "top" | "center" | "bottom";
  readonly wrap: "none" | "word" | "glyph" | "word-or-glyph";
  readonly whiteSpace: "normal" | "nowrap" | "pre" | "pre-wrap";
  readonly fonts: readonly string[];
}
export interface DashboardFrozenData {
  readonly source: { readonly kind: "dataset" | "pipeline" | "binding" | "sample";
    readonly id: string; readonly revision: number; readonly contentSha256: string };
  /** The hash binds this exact finite JSON metric; it does not authorize its publication. */
  readonly metric: { readonly value?: JsonValue; readonly rows?: readonly Record<string, JsonValue>[];
    readonly samples: readonly { readonly time: number; readonly value: number }[] };
  readonly table?: { readonly page: number; readonly sort?: { readonly column: string; readonly direction: "asc" | "desc" };
    readonly scrollLeft: number };
  readonly layout: { readonly textBoxes: readonly DashboardDataTextBox[];
    readonly backgrounds: readonly { readonly rect: readonly [number, number, number, number];
      /** Linear RGB, unchanged alpha (0..1); text styles remain sRGB bytes. */
      readonly color: readonly [number, number, number, number] }[] };
}
