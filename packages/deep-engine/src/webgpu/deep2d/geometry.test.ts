import { expect, it } from "vitest";
import { flattenPath, cross } from "./path.js";
import { fillPath, fillRings, type Triangle } from "./fill.js";
import { strokePath } from "./stroke.js";
import { clipVertices } from "./clip.js";
import { buildDeep2dGpuFrame } from "./frame.js";
import { decodeDeep2dAtlases } from "./resources.js";
import { build } from "../../runtimePackage/dashboardComposition.testUtils.js";
import { buildDashboardCandidateState } from "../../runtimePackage/dashboardCandidateState.js";
import type { DashboardRuntimeV1 } from "../../runtimePackage/dashboardCompositionTypes.js";
const identity = [1, 0, 0, 1, 0, 0] as const;
const area = (triangles: readonly Triangle[]) => triangles.reduce((sum, t) => sum + Math.abs(cross(...t)) / 2, 0);
const outer = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
it("fills concave rings and Native single-level holes without overdraw", () => {
  expect(area(fillRings([outer]))).toBe(100);
  expect(area(fillRings([[[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]]]))).toBe(75);
  const hole = [[2, 2], [8, 2], [8, 8], [2, 8]] as const;
  for (const rule of ["nonzero", "evenodd"] as const) expect(area(fillPath([
    { points: outer, closed: true }, { points: hole, closed: true },
  ], rule))).toBe(64);
  expect(() => fillRings([outer, [[20, 20], [22, 20], [20, 22]]], true)).toThrow(/inside/);
});
it("flattens quadratic/cubic curves at transformed physical tolerance", () => {
  const verbs = [{ op: "move", x: 0, y: 0 }, { op: "quadratic", cx: 50, cy: 100, x: 100, y: 0 },
    { op: "cubic", c1x: 100, c1y: -100, c2x: 0, c2y: -100, x: 0, y: 0 }, { op: "close" }] as const;
  const normal = flattenPath(verbs, identity, 1), enlarged = flattenPath(verbs, identity, 4);
  expect(enlarged[0]!.points.length).toBeGreaterThan(normal[0]!.points.length);
  expect(area(fillPath(normal))).toBeGreaterThan(9000);
});
it("rejects crossing, touching, open fills and excessive polygon work", () => {
  expect(() => flattenPath([{ op: "move", x: 0, y: 0 }, { op: "line", x: 10, y: 10 },
    { op: "line", x: 0, y: 10 }, { op: "line", x: 10, y: 0 }, { op: "close" }], identity, 1)).toThrow(/intersecting/);
  expect(() => fillPath([{ points: outer, closed: false }])).toThrow(/closed/);
  expect(() => fillRings([Array.from({ length: 513 }, (_, i) => [i, i] as const)])).toThrow(/budget/);
});
it("strokes open/closed paths with bounded dash, cap and join geometry", () => {
  const command = { kind: "path", id: "p", zOrder: 0, transform: identity, pathId: "p", stroke: [1, 0, 0, 1], strokeWidth: 2 } as const;
  const line = [{ points: [[0, 0], [10, 0]] as const, closed: false }];
  expect(area(strokePath(line, command, 0.25))).toBe(20);
  expect(area(strokePath(line, { ...command, lineCap: "square" }, 0.25))).toBe(24);
  expect(area(strokePath(line, { ...command, lineCap: "round" }, 0.25))).toBeGreaterThan(22);
  expect(area(strokePath(line, { ...command, dash: [2, 2] }, 0.25))).toBe(12);
  expect(area(strokePath([{ points: outer, closed: true }], command, 0.25))).toBe(80);
});
it("clips all interpolated attributes without losing atlas UVs", () => {
  const vertices = [[0, 0, 0, 0], [10, 0, 1, 0], [0, 10, 0, 1]];
  const clipped = clipVertices(vertices, [fillRings([[[0, 0], [5, 0], [5, 5], [0, 5]]])]);
  expect(clipped.length).toBeGreaterThan(0);
  for (const v of clipped) { expect(v[0]).toBeLessThanOrEqual(5); expect(v[1]).toBeLessThanOrEqual(5);
    expect(v[2]).toBeCloseTo(v[0]! / 10); expect(v[3]).toBeCloseTo(v[1]! / 10); }
});
it("consumes the real static composition payload and rejects aggregate surface budgets", () => {
  const value = build(), root = value.payloads[value.entrypoints.dashboard] as unknown as DashboardRuntimeV1;
  const state = buildDashboardCandidateState(value, root.pages[0]!, {
    packageHash: value.packageHash.value, pageId: root.entryPageId, generation: 1, deviceEpoch: 1,
  }, { deviceEpoch: 1 });
  const layers = state.page.nodes.filter(n => n.deep2d).map(node => ({ node, content: node.deep2d!, atlasBytes: decodeDeep2dAtlases(node.deep2d!) }));
  const frame = buildDeep2dGpuFrame(layers, 960, 640, 960, 640);
  expect(frame.draws.length).toBeGreaterThan(0); expect(frame.atlases.size).toBeGreaterThan(0);
  expect(frame.draws.every(draw => Array.from(draw.vertices).every(Number.isFinite))).toBe(true);
  expect(() => buildDeep2dGpuFrame(layers, 960, 640, 8192, 8192)).toThrow(/budget/);
});
