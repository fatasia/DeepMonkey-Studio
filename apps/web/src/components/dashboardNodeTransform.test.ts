import { describe, expect, it } from "vitest";
import type { WidgetFrame } from "@bim-studio/contracts";
import { calculateDashboardNodeTransformFrames, createDashboardSnapCandidates } from "./dashboardNodeTransform";
import { snapDashboardFrame } from "./dashboardWorkspaceModel";

describe("dashboard node smart snap", () => {
  it("discovers canvas, visible guides and neighboring component centers as snap candidates", () => {
    const page = {
      width: 1000,
      height: 600,
      guides: [
        { id: "guide-v", orientation: "vertical" as const, position: 320 },
        { id: "guide-h", orientation: "horizontal" as const, position: 260 },
      ],
      nodes: [
        { id: "moving", visible: true, frame: { x: 40, y: 40, width: 100, height: 80 } },
        { id: "neighbor", visible: true, frame: { x: 200, y: 160, width: 100, height: 80 } },
      ],
    };

    const candidates = createDashboardSnapCandidates(page, ["moving"], true);

    expect(candidates.x).toEqual(expect.arrayContaining([500, 320, 250]));
    expect(candidates.y).toEqual(expect.arrayContaining([300, 260, 200]));
    expect(createDashboardSnapCandidates(page, ["moving"], false).x).not.toContain(320);
    expect(snapDashboardFrame({ x: 447, y: 258, width: 100, height: 80 }, "move", [500], [300], 6)).toEqual({
      frame: { x: 450, y: 260, width: 100, height: 80 },
      lines: { x: [500], y: [300] },
    });
    expect(snapDashboardFrame({ x: 147, y: 158, width: 100, height: 80 }, "move", [250], [200], 6)).toEqual({
      frame: { x: 150, y: 160, width: 100, height: 80 },
      lines: { x: [250], y: [200] },
    });
  });

  it("bypasses grid and smart guides while Alt is held", () => {
    const initialFrame: WidgetFrame = { x: 100, y: 100, width: 100, height: 80 };
    const base = {
      clientX: 3,
      clientY: 5,
      startX: 0,
      startY: 0,
      zoom: 1,
      mode: "move" as const,
      page: { width: 1000, height: 600 },
      node: { id: "moving" },
      initial: new Map([["moving", initialFrame]]),
      snapEnabled: true,
      xCandidates: [200],
      yCandidates: [200],
    };

    expect(calculateDashboardNodeTransformFrames({ ...base, bypassSnap: false })).toEqual({
      frames: { moving: { x: 100, y: 104, width: 100, height: 80 } },
      lines: { x: [200], y: [] },
    });
    expect(calculateDashboardNodeTransformFrames({ ...base, bypassSnap: true })).toEqual({
      frames: { moving: { x: 103, y: 105, width: 100, height: 80 } },
      lines: { x: [], y: [] },
    });
  });
});
