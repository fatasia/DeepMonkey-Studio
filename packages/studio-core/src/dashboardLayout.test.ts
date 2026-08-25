import { describe, expect, it } from "vitest";
import { alignDashboardFrames, distributeDashboardFrames } from "./dashboardLayout.js";

const frames = [
  { nodeId: "a", frame: { x: 10, y: 20, width: 100, height: 50 } },
  { nodeId: "b", frame: { x: 180, y: 90, width: 80, height: 80 } },
  { nodeId: "c", frame: { x: 400, y: 220, width: 120, height: 60 } }
];

describe("dashboard layout", () => {
  it("aligns frames to every bounding-box edge and center", () => {
    expect(alignDashboardFrames(frames, "left").map((entry) => entry.frame.x)).toEqual([10, 10, 10]);
    expect(alignDashboardFrames(frames, "right").map((entry) => entry.frame.x)).toEqual([420, 440, 400]);
    expect(alignDashboardFrames(frames, "top").map((entry) => entry.frame.y)).toEqual([20, 20, 20]);
    expect(alignDashboardFrames(frames, "bottom").map((entry) => entry.frame.y)).toEqual([230, 200, 220]);
    expect(alignDashboardFrames(frames, "horizontal-center").map((entry) => entry.frame.x)).toEqual([215, 225, 205]);
    expect(alignDashboardFrames(frames, "vertical-center").map((entry) => entry.frame.y)).toEqual([125, 110, 120]);
  });

  it("distributes frames while preserving the outer bounds", () => {
    const horizontal = distributeDashboardFrames(frames, "horizontal");
    const vertical = distributeDashboardFrames(frames, "vertical");
    expect(horizontal.map((entry) => entry.frame.x)).toEqual([10, 215, 400]);
    expect(vertical.map((entry) => entry.frame.y)).toEqual([20, 105, 220]);
  });
});
