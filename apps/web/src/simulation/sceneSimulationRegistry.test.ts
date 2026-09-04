import { describe, expect, it } from "vitest";
import { SCENE_SIMULATION_PANELS, sceneSimulationPanel } from "./sceneSimulationRegistry";

describe("scene simulation panel registry", () => {
  it("keeps the editor entries mapped to existing operations workbenches", () => {
    expect(SCENE_SIMULATION_PANELS.map((panel) => panel.id)).toEqual([
      "logistics",
      "workcell",
      "commissioning",
      "whatif",
    ]);
    expect(sceneSimulationPanel("logistics").operationsTab).toBe("logistics");
    expect(sceneSimulationPanel("workcell")).toMatchObject({
      operationsTab: "commissioning",
      commissioningStage: "screening",
    });
    expect(sceneSimulationPanel("commissioning")).toMatchObject({
      operationsTab: "commissioning",
      commissioningStage: "control",
    });
    expect(sceneSimulationPanel("whatif").operationsTab).toBe("whatif");
  });
});
