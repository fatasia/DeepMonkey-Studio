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
});
