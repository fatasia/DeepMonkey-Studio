import type { Deep2dCommand } from "../../deep2dDisplayList.js";
import { cross, distance, type Point, type Subpath } from "./path.js";
import { fillRings, type Triangle } from "./fill.js";
type PathCommand = Extract<Deep2dCommand, { kind: "path" }>;
const add = (a: Point, b: Point, factor = 1): Point => [a[0] + b[0] * factor, a[1] + b[1] * factor];
const normal = (v: Point): Point => [-v[1], v[0]];
function unit(a: Point, b: Point): Point {
  const length = distance(a, b); if (length <= Number.EPSILON) throw new Error("Unsupported zero-length stroke.");
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
}
export function strokePath(paths: readonly Subpath[], command: PathCommand, tolerance: number): Triangle[] {
  const expanded = command.dash?.length ? paths.flatMap(p => dashed(p, command.dash!, command.dashOffset ?? 0)) : paths;
  return expanded.flatMap(path => outline(path, command, tolerance));
}
function outline(path: Subpath, command: PathCommand, tolerance: number): Triangle[] {
  const points = path.points, count = points.length, half = command.strokeWidth! / 2;
  if (count * 3 > 512 || (path.closed && count < 3)) throw new Error("Deep2D stroke point budget exceeded.");
  const left: Point[] = [], right: Point[] = [], fans: Point[][] = [];
  for (let i = 0; i < count; i++) {
    const p = points[i]!;
    if (!path.closed && (i === 0 || i === count - 1)) {
      const dir = i === 0 ? unit(p, points[1]!) : unit(points[i - 1]!, p), n = normal(dir);
      const center = command.lineCap === "square" ? add(p, dir, i === 0 ? -half : half) : p;
      left.push(add(center, n, half)); right.push(add(center, n, -half));
      if (command.lineCap === "round") {
        const angle = Math.atan2(dir[1], dir[0]) + (i === 0 ? Math.PI / 2 : -Math.PI / 2);
        fans.push(arc(p, half, angle, Math.PI, tolerance));
      }
      continue;
    }
    const prev = unit(points[(i + count - 1) % count]!, p), next = unit(p, points[(i + 1) % count]!);
    const turn = cross([0, 0], prev, next), dot = prev[0] * next[0] + prev[1] * next[1];
    if (Math.abs(turn) <= 1e-10) {
      if (dot <= 0) throw new Error("Unsupported stroke reversal.");
      left.push(add(p, normal(next), half)); right.push(add(p, normal(next), -half)); continue;
    }
    const tangent = unit([0, 0], add(prev, next)), miter = normal(tangent), n = normal(next);
    const denominator = miter[0] * n[0] + miter[1] * n[1];
    if (Math.abs(denominator) <= 1e-10) throw new Error("Unsupported unbounded stroke miter.");
    const length = half / denominator, bevel = command.lineJoin === "bevel" || Math.abs(length) > half * (command.miterLimit ?? 10);
    if (bevel && turn > 0) {
      left.push(add(p, miter, length)); right.push(add(p, normal(prev), -half), add(p, n, -half));
    } else if (bevel) {
      left.push(add(p, normal(prev), half), add(p, n, half)); right.push(add(p, miter, -length));
    } else { left.push(add(p, miter, length)); right.push(add(p, miter, -length)); }
    if (command.lineJoin === "round") {
      const direction = turn > 0 ? -1 : 1, a = normal(prev), b = normal(next);
      let start = Math.atan2(a[1] * direction, a[0] * direction), end = Math.atan2(b[1] * direction, b[0] * direction);
      let sweep = end - start;
      if (turn > 0 && sweep < 0) sweep += Math.PI * 2;
      if (turn < 0 && sweep > 0) sweep -= Math.PI * 2;
      fans.push(arc(p, half, start, sweep, tolerance));
    }
  }
  const body = path.closed ? (() => {
    const area = (r: Point[]) => Math.abs(r.reduce((n, p, i) => n + cross([0, 0], p, r[(i + 1) % r.length]!), 0));
    return area(left) > area(right) ? fillRings([left, right], true) : fillRings([right, left], true);
  })() : fillRings([[...left, ...right.reverse()]]);
  return [...body, ...fans.flatMap(fan => fillRings([fan]))];
}
function arc(center: Point, radius: number, start: number, sweep: number, tolerance: number): Point[] {
  const step = Math.acos(Math.max(-1, Math.min(1, 1 - Math.min(1, tolerance / radius))));
  const count = Math.max(3, Math.min(64, Math.ceil(Math.PI / Math.max(step, 1e-12))));
  return [center, ...Array.from({ length: count + 1 }, (_, i): Point => [
    center[0] + radius * Math.cos(start + sweep * i / count), center[1] + radius * Math.sin(start + sweep * i / count),
  ])];
}
function dashed(path: Subpath, source: readonly number[], offset: number): Subpath[] {
  const pattern = source.length % 2 ? [...source, ...source] : [...source], cycle = pattern.reduce((a, b) => a + b, 0);
  if (!(cycle > 0 && Number.isFinite(cycle)) || pattern.some(v => v <= 0)) throw new Error("Unsupported zero or invalid dash entry.");
  let phase = ((offset % cycle) + cycle) % cycle, index = 0;
  while (phase >= pattern[index]!) { phase -= pattern[index]!; index = (index + 1) % pattern.length; }
  const output: Subpath[] = []; let current: Point[] = [], emitted = 0;
  const finish = () => { if (current.length > 1) output.push({ points: current, closed: false }); current = []; };
  const steps = path.closed ? path.points.length : path.points.length - 1;
  for (let i = 0; i < steps; i++) {
    const a = path.points[i]!, b = path.points[(i + 1) % path.points.length]!, length = distance(a, b);
    let consumed = 0;
    while (length - consumed > 1e-10) {
      if (++emitted > 16_384) throw new Error("Deep2D dash expansion budget exceeded.");
      const step = Math.min(pattern[index]! - phase, length - consumed);
      const at = (t: number): Point => [a[0] + (b[0] - a[0]) * t / length, a[1] + (b[1] - a[1]) * t / length];
      if (index % 2 === 0) { if (!current.length) current.push(at(consumed)); current.push(at(consumed + step)); }
      consumed += step; phase += step;
      if (phase >= pattern[index]! - 1e-12) { phase = 0; index = (index + 1) % pattern.length; if (index % 2) finish(); }
    }
  }
  finish(); return output;
}
