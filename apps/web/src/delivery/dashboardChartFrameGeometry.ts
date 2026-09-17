import type { ChartIR, ChartAxis, ChartSeries, ChartDataset } from "@bim-studio/deep-engine";
export type Point = [number, number];
export type Rect = [number, number, number, number];
/** Native `render_chart_with_windows` 的窗口线形式：[axisId, start, end]，start/end 归一到 [0,1]。 */
export type ChartZoomWindow = readonly [axisId: string, start: number, end: number];
export const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
/**
 * Native `render_domain::zoom_domain` 同式：窗口在域上做 `lo*(1-t)+hi*t` 插值
 * （对数轴先 log10 再 10^x 回去）；窗口退化（非有限或 hi<lo）时几何失败，不静默回退全域。
 */
export function zoomDomain(axis: ChartAxis | undefined, domain: Point, windows: readonly ChartZoomWindow[]): Point | undefined {
  const window = windows.find(([id]) => id === axis?.id);
  if (!window) return domain;
  const log = axis?.scale === "log";
  const a = log ? Math.log10(domain[0]) : domain[0], b = log ? Math.log10(domain[1]) : domain[1];
  const interpolate = (t: number) => log ? 10 ** (a * (1 - t) + b * t) : a * (1 - t) + b * t;
  const lo = interpolate(window[1]), hi = interpolate(window[2]);
  return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi ? [lo, hi] : undefined;
}
export function chartPlot(ir: ChartIR, width: number, height: number): Rect {
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value <= 16_777_216)) throw new Error("Invalid chart canvas");
  const plot: Rect = [8, 8, width - 16, height - 16];
  if (ir.legend.visible) switch (ir.legend.position) {
    case "top": plot[1] += 24; plot[3] -= 24; break;
    case "bottom": plot[3] -= 24; break;
    case "left": plot[0] += 120; plot[2] -= 120; break;
    case "right": plot[2] -= 120; break;
  }
  if (plot[2] <= 0 || plot[3] <= 0) throw new Error("Chart canvas is too small for legend and padding");
  return plot;
}
function domain(axis: ChartAxis | undefined, values: number[]): Point | undefined {
  let lo = Infinity, hi = -Infinity;
  for (const value of values) if (Number.isFinite(value) && (axis?.scale !== "log" || value > 0)) {
    lo = Math.min(lo, value); hi = Math.max(hi, value);
  }
  lo = axis?.min ?? lo; hi = axis?.max ?? hi;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi && (axis?.scale !== "log" || lo > 0 && hi > 0) ? [lo, hi] : undefined;
}
function mapper(axis: ChartAxis | undefined, [lo, hi]: Point, [start, end]: Point) {
  return (value: number) => {
    if (axis?.scale === "log") {
      const a = Math.log10(lo), b = Math.log10(hi);
      return a === b ? (start + end) * .5 : start + (Math.log10(Number.isFinite(value) && value > 0 ? value : lo) - a) / (b - a) * (end - start);
    }
    return lo === hi || !Number.isFinite(value) ? (start + end) * .5 : start + (value - lo) / (hi - lo) * (end - start);
  };
}
export function numeric(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
// Domain membership follows compiled series, independently of rendering order.
function axisValues(ir: ChartIR, channel: "x" | "y", axisId: string) {
  const values: number[] = []; let hasBar = false;
  for (const peer of ir.series) {
    if (!["bar", "line", "scatter"].includes(peer.type) || !("x" in peer) || !("y" in peer)) continue;
    if ((channel === "x" ? peer.xAxisId : peer.yAxisId) !== axisId) continue;
    hasBar ||= peer.type === "bar";
    const dataset = ir.datasets.find(value => value.id === peer.datasetId); if (!dataset) continue;
    const xi = dataset.dimensions.indexOf(peer.x), yi = dataset.dimensions.indexOf(peer.y);
    const logY = ir.axes.find(axis => axis.id === peer.yAxisId)?.scale === "log";
    for (const row of dataset.rows) {
      const y = numeric(row[yi]); if (y === undefined || logY && y <= 0) continue;
      const value = channel === "y" ? y : numeric(row[xi]);
      if (value !== undefined) values.push(value);
    }
  }
  return { values, hasBar };
}
// Native map_cartesian 同构：窗口先落在解析后的共享域（含 bar 归零与显式界）上，
// 类目轴不走连续域而是行带窗口（first=start*count, span=(end-start)*count）。
export function cartesian(ir: ChartIR, series: ChartSeries, dataset: ChartDataset, plot: Rect, windows: readonly ChartZoomWindow[] = []) {
  if (!("x" in series) || !("y" in series)) throw new Error("Expected cartesian series");
  const xi = dataset.dimensions.indexOf(series.x ?? ""), yi = dataset.dimensions.indexOf(series.y ?? "");
  if (xi < 0 || yi < 0) return undefined;
  const xa = ir.axes.find(axis => axis.id === series.xAxisId), ya = ir.axes.find(axis => axis.id === series.yAxisId);
  const xw = windows.find(([id]) => id === xa?.id);
  const numericX = xa?.scale !== "category" && dataset.rows.every(row => numeric(row[yi]) === undefined
    || numeric(row[xi]) !== undefined && (xa?.scale !== "log" || (row[xi] as number) > 0));
  const kept = dataset.rows.flatMap((row, index) => {
    const y = numeric(row[yi]);
    return y === undefined || ya?.scale === "log" && y <= 0 ? [] : [{ index, x: numeric(row[xi]), y }];
  });
  const sharedY = axisValues(ir, "y", series.yAxisId);
  const yd = domain(ya, sharedY.values); if (!yd) return undefined;
  // Bar length encodes magnitude: each automatic non-log bound includes zero.
  // Resolve first so an empty dataset remains empty, and preserve authored bounds.
  if (sharedY.hasBar && ya?.scale !== "log") {
    if (ya?.min == null) yd[0] = Math.min(yd[0], 0);
    if (ya?.max == null) yd[1] = Math.max(yd[1], 0);
  }
  const yz = zoomDomain(ya, yd, windows); if (!yz) return undefined;
  const [px, py, pw, ph] = plot, ym = mapper(ya, yz, [py + ph, py]);
  let xm: (row: typeof kept[number]) => number;
  if (numericX) {
    const xd = domain(xa, axisValues(ir, "x", series.xAxisId).values); if (!xd) return undefined;
    const xz = zoomDomain(xa, xd, windows); if (!xz) return undefined;
    const project = mapper(xa, xz, [px, px + pw]); xm = row => project(row.x ?? NaN);
  } else if (xw) {
    const count = Math.max(1, dataset.rows.length), first = xw[1] * count, span = (xw[2] - xw[1]) * count;
    xm = row => px + (row.index + .5 - first) / span * pw;
  } else xm = row => px + pw / Math.max(1, dataset.rows.length) * (row.index + .5);
  return { points: kept.map(row => [xm(row), ym(row.y)] as Point), indices: kept.map(row => row.index),
    band: pw / Math.max(1, dataset.rows.length) / (xw ? xw[2] - xw[1] : 1), baseline: clamp(ym(0), py, py + ph) };
}
export function arc(center: Point, radius: number, start: number, sweep: number, segments: number): Point[] {
  return Array.from({ length: segments + 1 }, (_, step) => {
    const angle = (start + sweep * step / segments) * (Math.PI / 180);
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}
export function circle(center: Point, radius: number, segments: number) { return arc(center, radius, 0, 360, segments).slice(0, -1); }
export function envelope(points: Point[], count: number): Point[] {
  const width = points.length / Math.min(count, points.length), groups: [number, number, number][] = [];
  let previous = -1;
  points.forEach(([x, y], index) => {
    const group = Math.min(Math.floor(index / width), count - 1);
    if (group === previous) { const last = groups[groups.length - 1]!; last[1] = Math.min(last[1], y); last[2] = Math.max(last[2], y); }
    else { groups.push([x, y, y]); previous = group; }
  });
  return [...groups.map(([x, y]) => [x, y] as Point), ...groups.slice().reverse().map(([x, , y]) => [x, y] as Point)];
}
