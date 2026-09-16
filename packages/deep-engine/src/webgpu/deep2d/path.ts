import type { Deep2dMatrix, Deep2dPathVerb } from "../../deep2dDisplayList.js";
export type Point = readonly [number, number];
export interface Subpath { readonly points: readonly Point[]; readonly closed: boolean }
export const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export const transform = (p: Point, m: Deep2dMatrix): Point => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export function epsilon(points: readonly Point[]): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return Math.max(1e-10, Math.max(x1 - x0, y1 - y0) * 1e-12);
}

/** Matches Native's 0.25 physical-pixel curve tolerance and bounded recursion. */
export function flattenPath(verbs: readonly Deep2dPathVerb[], matrix: Deep2dMatrix, physicalScale: number): Subpath[] {
  const tolerance = Math.max(1e-12, 0.25 / Math.max(1e-12, Math.hypot(...matrix.slice(0, 4)) * physicalScale));
  const result: Subpath[] = []; let points: Point[] = [], closed = false, emitted = 0;
  const push = (p: Point) => { if (++emitted > 16_384) throw new Error("Deep2D flattened segment budget exceeded."); points.push(p); };
  const finish = () => {
    if (!points.length) return;
    const e = epsilon(points);
    if (closed && points.length > 2 && distance(points[0]!, points.at(-1)!) <= e) points.pop();
    if (points.length < 2 || points.slice(1).some((p, i) => distance(p, points[i]!) <= e)) {
      throw new Error("Unsupported Deep2D zero-length subpath.");
    }
    result.push({ points, closed }); points = []; closed = false;
  };
  const curve = (control: readonly Point[], depth: number): void => {
    const start = control[0]!, end = control.at(-1)!, length = distance(start, end);
    if (control.slice(1, -1).every(p => (length > Number.EPSILON ? Math.abs(cross(start, end, p)) / length : distance(p, start)) <= tolerance)) {
      push(end); return;
    }
    if (depth >= 24) throw new Error("Deep2D curve recursion budget exceeded.");
    const left = [start], right = [end]; let row = [...control];
    while (row.length > 1) {
      row = row.slice(1).map((p, i) => midpoint(row[i]!, p)); left.push(row[0]!); right.unshift(row.at(-1)!);
    }
    curve(left, depth + 1); curve(right, depth + 1);
  };
  for (const verb of verbs) {
    if (verb.op === "move") { finish(); push([verb.x, verb.y]); continue; }
    if (!points.length || closed) throw new Error("Unsupported Deep2D geometry after close or before move.");
    if (verb.op === "close") { closed = true; continue; }
    if (verb.op === "line") push([verb.x, verb.y]);
    else if (verb.op === "quadratic") curve([points.at(-1)!, [verb.cx, verb.cy], [verb.x, verb.y]], 0);
    else if (verb.op === "cubic") curve([points.at(-1)!, [verb.c1x, verb.c1y], [verb.c2x, verb.c2y], [verb.x, verb.y]], 0);
  }
  finish(); if (!result.length) throw new Error("Empty Deep2D path.");
  validateIntersections(result);
  return result;
}

/** Native rejects crossing/touching non-adjacent segments; never silently choose another fill topology. */
export function validateIntersections(paths: readonly Subpath[]): void {
  const edges = paths.flatMap((path, subpath) => path.points.slice(0, path.closed ? undefined : -1).map((p, index) => ({
    a: p, b: path.points[(index + 1) % path.points.length]!, subpath, index,
    count: path.points.length, closed: path.closed,
  })));
  if (edges.length * (edges.length - 1) / 2 > 4_000_000) throw new Error("Deep2D intersection work budget exceeded.");
  const e = epsilon(paths.flatMap(p => [...p.points]));
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i]!, b = edges[j]!;
    if (a.subpath === b.subpath && (Math.abs(a.index - b.index) === 1
      || (a.closed && a.index === 0 && b.index === a.count - 1))) continue;
    if (intersects(a.a, a.b, b.a, b.b, e)) throw new Error("Unsupported Deep2D intersecting or touching path.");
  }
}
function intersects(a: Point, b: Point, c: Point, d: Point, e: number): boolean {
  const values = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
  if (values[0]! * values[1]! < 0 && values[2]! * values[3]! < 0) return true;
  const on = (p: Point, x: Point, y: Point) => p[0] >= Math.min(x[0], y[0]) - e && p[0] <= Math.max(x[0], y[0]) + e
    && p[1] >= Math.min(x[1], y[1]) - e && p[1] <= Math.max(x[1], y[1]) + e;
  return (Math.abs(values[0]!) <= e && on(c, a, b)) || (Math.abs(values[1]!) <= e && on(d, a, b))
    || (Math.abs(values[2]!) <= e && on(a, c, d)) || (Math.abs(values[3]!) <= e && on(b, c, d));
}
