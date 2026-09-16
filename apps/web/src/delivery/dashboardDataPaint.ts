import type { DashboardDataPaint, DashboardFrozenData } from "./dashboardDataRasterTypes";

/** A complete permutation prevents dropped, duplicated, or invented measured content. */
export function dashboardDataPaint(layout: DashboardFrozenData["layout"]): readonly DashboardDataPaint[] {
  const counts = { background: layout.backgrounds.length, text: layout.textBoxes.length };
  if (counts.background > 512 || counts.text > 512) throw new Error("Measured paint budget exceeded");
  const paint = layout.paint ?? [
    ...layout.backgrounds.map((_, index) => ({ kind: "background" as const, index })),
    ...layout.textBoxes.map((_, index) => ({ kind: "text" as const, index })),
  ];
  if (paint.length !== counts.background + counts.text) throw new Error("Incomplete measured paint order");
  const seen = new Set<string>();
  for (const entry of paint) {
    if (!["background", "text"].includes(entry.kind) || !Number.isSafeInteger(entry.index)
      || entry.index < 0 || entry.index >= counts[entry.kind]) throw new Error("Invalid measured paint reference");
    const key = `${entry.kind}.${entry.index}`;
    if (seen.has(key)) throw new Error("Duplicate measured paint reference");
    seen.add(key);
  }
  return paint;
}
