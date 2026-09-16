import { describe, expect, it } from "vitest";
import type { Deep2dCommand, Deep2dDisplayList } from "../../deep2dDisplayList.js";
import type { DashboardCandidateNode } from "../../runtimePackage/dashboardCandidateTypes.js";
import type { Deep2dRuntimePackage } from "../../runtimePackage/types.js";
import { buildDeep2dGpuFrame, type Deep2dFrameLayer } from "./frame.js";

const matrix = [1, 0, 0, 1, 0, 0] as const;
const node: DashboardCandidateNode = {
  node: { id: "node", revision: 1, frame: [0, 0, 16, 16], clip: null, zOrder: 0,
    visible: true, hitId: null, deep2d: "content", chart: null, chartSim: null },
  effectiveClip: [0, 0, 16, 16], deep2d: null, chart: null,
};

function command(id: string, zOrder: number, color: readonly [number, number, number, number]): Deep2dCommand {
  return { kind: "path", id, zOrder, transform: matrix, pathId: "rect", fill: color };
}

function layer(composition: Deep2dRuntimePackage["composition"], commands: readonly Deep2dCommand[],
  quads: Deep2dRuntimePackage["quads"] = [], source: readonly [number, number, number, number] = [0, 0, 1, 1]): Deep2dFrameLayer {
  const displayList: Deep2dDisplayList = { schemaVersion: 1, id: "paths", revision: 1,
    logicalWidth: 16, logicalHeight: 16, scaleFactor: 1,
    resources: [{ kind: "path", id: "rect", revision: 1, verbs: [
      { op: "move", x: 0, y: 0 }, { op: "line", x: 4, y: 0 },
      { op: "line", x: 4, y: 4 }, { op: "line", x: 0, y: 4 }, { op: "close" },
    ] }], commands };
  const hasAtlas = quads.length > 0;
  const content: Deep2dRuntimePackage = { schema: "deep-engine.deep2d-runtime", schemaVersion: 2,
    id: "content", revision: 1, composition, displayList,
    atlases: hasAtlas ? [{ id: "atlas", revision: 1, kind: "image", format: "rgba8unorm-srgb",
      width: 8, height: 4, sampling: "linear", dataBase64: "unused" }] : [],
    quads: quads.map(quad => ({ ...quad, source })) };
  return { node, content, atlasBytes: hasAtlas
    ? new Map([["atlas", new Uint8Array(8 * 4 * 4)]]) : new Map() };
}

function quad(id: string, zOrder: number, color: readonly [number, number, number, number]) {
  return { id, zOrder, transform: matrix, atlasId: "atlas", source: [0, 0, 1, 1] as const,
    destination: [6, 6, 4, 4] as const, color };
}

function colors(frame: ReturnType<typeof buildDeep2dGpuFrame>): number[][] {
  return frame.draws.map(draw => Array.from(draw.vertices.slice(2, 6), value => Math.round(value * 10) / 10));
}

describe("Deep2D GPU frame ordering", () => {
  const commands = [command("path-late", 2, [1, 0, 0, 1]), command("path-early", 0, [0, 1, 0, 1])];
  const quads = [quad("quad-late", 2, [0, 0, 1, 1]), quad("quad-early", 0, [1, 1, 0, 1])];

  it("matches Native (zOrder, kindOrder, sourceIndex) for z-ordered packages", () => {
    const frame = buildDeep2dGpuFrame([layer("z-ordered", commands, quads)], 16, 16, 16, 16);
    expect(colors(frame)).toEqual([[0, 1, 0, 1], [1, 1, 0, 1], [1, 0, 0, 1], [0, 0, 1, 1]]);
  });

  it("sorts each kind by (zOrder, sourceIndex) before path-then-atlas composition", () => {
    const frame = buildDeep2dGpuFrame([layer("path-then-atlas", commands, quads)], 16, 16, 16, 16);
    expect(colors(frame)).toEqual([[0, 1, 0, 1], [1, 0, 0, 1], [1, 1, 0, 1], [0, 0, 1, 1]]);
  });
});

it("keeps edge UVs while clamping a source sub-image to half-texel centers", () => {
  const frame = buildDeep2dGpuFrame([layer("z-ordered", [], [quad("one-wide", 0, [1, 1, 1, 1])], [2, 1, 1, 2])],
    16, 16, 16, 16);
  const vertices = frame.draws[0]!.vertices;
  expect(Array.from(vertices.slice(6, 12))).toEqual([0.25, 0.25, 0.3125, 0.375, 0.3125, 0.625]);
  expect(Array.from(vertices.slice(18, 24))).toEqual([0.375, 0.25, 0.3125, 0.375, 0.3125, 0.625]);
  const positions = Array.from({ length: vertices.length / 12 }, (_, index) =>
    Array.from(vertices.slice(index * 12, index * 12 + 2)));
  expect(positions.every(([x, y]) => Math.abs(x!) <= 0.25 && Math.abs(y!) <= 0.25)).toBe(true);
});
