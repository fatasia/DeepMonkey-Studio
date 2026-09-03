import type { WorkcellAuditInput } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { assessWorkcellPlanningEvidence } from "./planningEvidence.js";

describe("workcell planning evidence", () => {
  it("blocks unconfirmed scene-derived starter values", () => {
    const result = assessWorkcellPlanningEvidence(sceneDerivedInput("unconfirmed"), true);

    expect(result).toMatchObject({
      status: "needs-data",
      origin: "starter-values",
      clearanceThresholdMeters: .25,
      generatedTrajectorySpeedMps: .5,
      generatedTrajectoryTcpRadiusMeters: .1,
      missingFields: ["planning-confirmation"],
    });
    expect(result.evidenceCoverage).toBeLessThanOrEqual(.5);
  });

  it("accepts the same explicit values after engineer confirmation", () => {
    const result = assessWorkcellPlanningEvidence(sceneDerivedInput("engineer-confirmed"), true);

    expect(result).toMatchObject({ status: "confirmed", missingFields: [], evidenceCoverage: 1 });
  });

  it("does not silently replace a missing or mismatched TCP radius", () => {
    const input = sceneDerivedInput("engineer-confirmed");
    delete input.trajectories![0]!.tcpRadius;
    expect(assessWorkcellPlanningEvidence(input, true).missingFields).toContain("trajectory-tcp-radius");

    input.trajectories![0]!.tcpRadius = .2;
    expect(assessWorkcellPlanningEvidence(input, true).missingFields).toContain("trajectory-radius-mismatch");
  });

  it("keeps explicit author trajectories backward-compatible without inventing a threshold", () => {
    const input = sceneDerivedInput("engineer-confirmed");
    input.trajectories![0]!.precision = { source: "author-confirmed" };
    delete input.planningAssumptions;
    delete input.clearanceThreshold;

    expect(assessWorkcellPlanningEvidence(input, false)).toMatchObject({ status: "confirmed", missingFields: [] });
    expect(assessWorkcellPlanningEvidence(input, true).missingFields).toContain("clearance-threshold");
  });
});

function sceneDerivedInput(status: "unconfirmed" | "engineer-confirmed"): WorkcellAuditInput {
  return {
    sceneId: "scene",
    clearanceThreshold: .25,
    planningAssumptions: {
      origin: "starter-values",
      status,
      generatedTrajectorySpeedMps: .5,
      generatedTrajectoryTcpRadiusMeters: .1,
    },
    objects: [{ id: "robot", name: "机器人", role: "robot", position: { x: 0, y: 0, z: 0 } }],
    trajectories: [{
      id: "path", name: "候选轨迹", robotId: "robot", tcpRadius: .1,
      precision: { source: "scene-transform" },
      waypoints: [
        { id: "start", timeSec: 0, position: { x: 0, y: 0, z: 0 } },
        { id: "end", timeSec: 2, position: { x: 1, y: 0, z: 0 } },
      ],
    }],
  };
}
