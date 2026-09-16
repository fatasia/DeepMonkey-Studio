import { cross, validateIntersections, type Point, type Subpath } from "./path.js";

export type Triangle = readonly [Point, Point, Point];
/** Bounded scanline trapezoids avoid an extra triangulation dependency; inputs are simple, disjoint rings. */
export function fillRings(rings: readonly (readonly Point[])[], holes = false): Triangle[] {
  if (!rings.length || rings.some(r => r.length < 3 || r.length > 512)
    || (holes && rings.reduce((n, r) => n + r.length + 2, -2) > 512)) throw new Error("Deep2D polygon point budget exceeded.");
  validateIntersections(rings.map(points => ({ points, closed: true })));
  if (holes) for (let i = 1; i < rings.length; i++) {
    if (!contains(rings[0]!, rings[i]![0]!) || rings.slice(1, i).some(r => contains(r, rings[i]![0]!) || contains(rings[i]!, r[0]!))) {
      throw new Error("Unsupported Deep2D hole must be inside the outer ring without nesting.");
    }
  }
  if (!holes && rings.length > 1) return rings.flatMap(r => fillRings([r]));
  const ys = [...new Set(rings.flatMap(r => r.map(p => p[1])))].sort((a, b) => a - b);
  const edges = rings.flatMap(r => r.map((a, i) => [a, r[(i + 1) % r.length]!] as const)).filter(([a, b]) => a[1] !== b[1]);
  const x = ([a, b]: readonly [Point, Point], y: number) => a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
  const triangles: Triangle[] = [];
  for (let i = 1; i < ys.length; i++) {
    const y0 = ys[i - 1]!, y1 = ys[i]!, mid = (y0 + y1) / 2;
    const active = edges.filter(([a, b]) => mid > Math.min(a[1], b[1]) && mid < Math.max(a[1], b[1])).sort((a, b) => x(a, mid) - x(b, mid));
    if (active.length % 2) throw new Error("Invalid Deep2D polygon crossings.");
    for (let j = 0; j < active.length; j += 2) {
      const a: Point = [x(active[j]!, y0), y0], b: Point = [x(active[j + 1]!, y0), y0];
      const c: Point = [x(active[j + 1]!, y1), y1], d: Point = [x(active[j]!, y1), y1];
      if (Math.abs(cross(a, b, c)) > 1e-16) triangles.push([a, b, c]);
      if (Math.abs(cross(a, c, d)) > 1e-16) triangles.push([a, c, d]);
    }
  }
  if (!triangles.length) throw new Error("Unsupported degenerate Deep2D polygon.");
  return triangles;
}
export function fillPath(paths: readonly Subpath[], fillRule?: "nonzero" | "evenodd"): Triangle[] {
  if (paths.some(p => !p.closed)) throw new Error("Deep2D fill requires explicitly closed paths.");
  // Native normalizes later subpaths as single-level holes for both authored fill rules.
  return fillRings(paths.map(p => p.points), fillRule !== undefined);
}
function contains(ring: readonly Point[], point: Point): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
