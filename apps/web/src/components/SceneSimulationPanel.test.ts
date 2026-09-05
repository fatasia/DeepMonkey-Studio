import { describe, expect, it } from "vitest";
import { constrainPanelLayout } from "./SceneSimulationPanel";

describe("SceneSimulationPanel layout", () => {
  it("keeps a moved or resized panel inside the 3D workspace", () => {
    expect(constrainPanelLayout({ left: -40, top: 900, width: 1_100, height: 900 }, 800, 600)).toEqual({
      left: 10,
      top: 10,
      width: 780,
      height: 580,
    });
  });

  it("adapts its minimum size to a narrow workspace", () => {
    expect(constrainPanelLayout({ left: 10, top: 10, width: 100, height: 100 }, 320, 300)).toEqual({
      left: 10,
      top: 10,
      width: 300,
      height: 280,
    });
  });

  it("does not escape workspaces smaller than its normal minimum", () => {
    expect(constrainPanelLayout({ left: 500, top: 500, width: 520, height: 610 }, 200, 180)).toEqual({ left: 10, top: 10, width: 180, height: 160 });
    expect(constrainPanelLayout({ left: 500, top: 500, width: 520, height: 610 }, 0, 0)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it("moves a compact header to the edge and restores a bounded expanded window", () => {
    const compact = constrainPanelLayout({ left: 999, top: 999, width: 520, height: 500 }, 800, 600, true);
    expect(compact).toEqual({ left: 470, top: 542, width: 520, height: 500 });
    expect(constrainPanelLayout(compact, 800, 600)).toEqual({ left: 270, top: 90, width: 520, height: 500 });
  });
});
