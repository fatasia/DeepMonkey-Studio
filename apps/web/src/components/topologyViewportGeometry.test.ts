import { describe, expect, it } from "vitest";
import type { TopologyNode } from "@bim-studio/contracts";
import { topologyCanvasOrigin, topologyContentBounds, topologyFitOrigin, topologyFitZoom } from "./topologyViewportGeometry";
import { topologyProjectedPosition } from "./topologyEditorRuntime";

const nodes: TopologyNode[] = [
  { id: "a", kind: "device", x: 120, y: 280, properties: {} },
  { id: "b", kind: "device", x: 1020, y: 180, properties: {} },
  { id: "c", kind: "agv", x: 570, y: 480, properties: {} },
];
describe("topology viewport geometry", () => {
  it("fits all node extents with screen-space padding, including narrow viewports below 60%", () => {
    const before = JSON.stringify(nodes);
    for (const mode of ["2d", "2.5d"] as const) {
      const bounds = topologyContentBounds(nodes, mode);
      for (const [width, height] of [[948, 700], [543, 630], [363, 540]] as const) {
        const zoom = topologyFitZoom(bounds, width, height);
        expect(bounds.width * zoom).toBeLessThanOrEqual(width - 64 + 0.001);
        expect(bounds.height * zoom).toBeLessThanOrEqual(height - 64 + 0.001);
        if (width === 543) expect(zoom).toBeLessThan(0.6);
      }
    }
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it("includes elevated negative projected nodes, badges and ports in the canvas origin", () => {
    const node = { id: "elevated", kind: "pump", x: 24, y: 24, properties: { elevation: 500 } };
    const bounds = topologyContentBounds([node], "2.5d");
    const point = topologyProjectedPosition(node, "2.5d");
    const origin = topologyCanvasOrigin(bounds);
    expect(bounds.y).toBeLessThan(0);
    expect(point.y + origin.y).toBeGreaterThanOrEqual(60);
    expect(bounds.x + origin.x).toBeGreaterThanOrEqual(32);
  });
  it("does not upscale small graphs and keeps empty/hidden viewports finite", () => {
    const bounds = topologyContentBounds(nodes.slice(0, 1), "2d");
    expect(topologyFitZoom(bounds, 1500, 800)).toBe(1);
    expect(topologyFitZoom(bounds, 0, 0)).toBe(1);
    expect(topologyFitZoom(topologyContentBounds([], "2d"), 550, 700)).toBe(1);
  });
  it("centers sparse content vertically without needing negative native scroll offsets", () => {
    const bounds = topologyContentBounds(nodes, "2d");
    const zoom = topologyFitZoom(bounds, 543, 630);
    const origin = topologyFitOrigin(bounds, 543, 630, zoom);
    expect((bounds.y + bounds.height / 2 + origin.y) * zoom).toBeCloseTo(315);
  });
});
