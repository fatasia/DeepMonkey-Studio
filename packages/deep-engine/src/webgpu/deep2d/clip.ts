import { cross, type Point } from "./path.js";
import type { Triangle } from "./fill.js";

/** Sutherland-Hodgman on each convex clip triangle; keeps every interpolated vertex attribute. */
export function clipVertices(vertices: readonly number[][], clips: readonly (readonly Triangle[])[]): number[][] {
  let output = [...vertices], work = 0;
  for (const triangles of clips) {
    const next: number[][] = [];
    for (let i = 0; i < output.length; i += 3) for (const triangle of triangles) {
      if (++work > 4_000_000) throw new Error("Deep2D clip work budget exceeded.");
      let polygon = output.slice(i, i + 3);
      const winding = Math.sign(cross(...triangle));
      for (let edge = 0; edge < 3 && polygon.length; edge++) {
        const a = triangle[edge]!, b = triangle[(edge + 1) % 3]!, input = polygon; polygon = [];
        const side = (p: number[]) => cross(a, b, p as unknown as Point) * winding;
        for (let j = 0; j < input.length; j++) {
          const from = input[j]!, to = input[(j + 1) % input.length]!, f = side(from), t = side(to);
          if (f >= 0) polygon.push(from);
          if ((f >= 0) !== (t >= 0)) {
            const alpha = f / (f - t); polygon.push(from.map((value, k) => value + (to[k]! - value) * alpha));
          }
        }
      }
      for (let j = 2; j < polygon.length; j++) next.push(polygon[0]!, polygon[j - 1]!, polygon[j]!);
      if (next.length > 2_000_000) throw new Error("Deep2D clipped vertex budget exceeded.");
    }
    output = next;
  }
  return output;
}
