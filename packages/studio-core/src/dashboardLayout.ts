import type { WidgetFrame } from "@bim-studio/contracts";

export type DashboardAlignment = "left" | "horizontal-center" | "right" | "top" | "vertical-center" | "bottom";
export type DashboardDistribution = "horizontal" | "vertical";
export interface DashboardFrameEntry { readonly nodeId: string; readonly frame: WidgetFrame; }

export function alignDashboardFrames(entries: readonly DashboardFrameEntry[], alignment: DashboardAlignment): DashboardFrameEntry[] {
  if (entries.length < 2) return entries.map(cloneEntry);
  const left = Math.min(...entries.map((entry) => entry.frame.x));
  const right = Math.max(...entries.map((entry) => entry.frame.x + entry.frame.width));
  const top = Math.min(...entries.map((entry) => entry.frame.y));
  const bottom = Math.max(...entries.map((entry) => entry.frame.y + entry.frame.height));
  return entries.map((entry) => {
    const frame = { ...entry.frame };
    if (alignment === "left") frame.x = left;
    if (alignment === "horizontal-center") frame.x = Math.round((left + right - frame.width) / 2);
    if (alignment === "right") frame.x = right - frame.width;
    if (alignment === "top") frame.y = top;
    if (alignment === "vertical-center") frame.y = Math.round((top + bottom - frame.height) / 2);
    if (alignment === "bottom") frame.y = bottom - frame.height;
    return { nodeId: entry.nodeId, frame };
  });
}

export function distributeDashboardFrames(entries: readonly DashboardFrameEntry[], distribution: DashboardDistribution): DashboardFrameEntry[] {
  if (entries.length < 3) return entries.map(cloneEntry);
  const horizontal = distribution === "horizontal";
  const ordered = entries.map(cloneEntry).sort((left, right) => horizontal ? left.frame.x - right.frame.x : left.frame.y - right.frame.y);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const start = horizontal ? first.frame.x : first.frame.y;
  const end = horizontal ? last.frame.x + last.frame.width : last.frame.y + last.frame.height;
  const occupied = ordered.reduce((sum, entry) => sum + (horizontal ? entry.frame.width : entry.frame.height), 0);
  const gap = (end - start - occupied) / (ordered.length - 1);
  let cursor = start;
  return ordered.map((entry) => {
    const frame = { ...entry.frame };
    if (horizontal) frame.x = Math.round(cursor);
    else frame.y = Math.round(cursor);
    cursor += (horizontal ? frame.width : frame.height) + gap;
    return { nodeId: entry.nodeId, frame };
  });
}

function cloneEntry(entry: DashboardFrameEntry): DashboardFrameEntry {
  return { nodeId: entry.nodeId, frame: { ...entry.frame } };
}
