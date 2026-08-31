import { describe, expect, it } from "vitest";
import { createRobotKinematicsState, normalizeRobotKinematicsState } from "./robotKinematics";

describe("robot kinematics state", () => {
  it("creates a stable joint chain from meaningful bones", () => {
    const state = createRobotKinematicsState([
      { path: "root/joint", name: "Joint", depth: 1, linkLength: 1.2 },
      { path: "root", name: "Root", depth: 0, linkLength: 0 },
      { path: "root/joint/tool", name: "Tool", depth: 2, linkLength: 0.4 },
    ]);

    expect(state.baseBonePath).toBe("root");
    expect(state.toolBonePath).toBe("root/joint/tool");
    expect(state.joints.map((joint) => joint.length)).toEqual([1.2, 0.4]);
  });

  it("normalizes unsafe imported values and removes duplicate targets", () => {
    const state = normalizeRobotKinematicsState({
      enabled: true,
      baseBonePath: "root",
      targetObjectIds: ["target", "target"],
      joints: [{ bonePath: "joint", name: "Joint", axis: "z", length: Number.NaN, minAngleDeg: -900, maxAngleDeg: Number.NaN }],
    });

    expect(state.targetObjectIds).toEqual(["target"]);
    expect(state.joints[0]).toMatchObject({ length: 1, minAngleDeg: -360, maxAngleDeg: 180 });
  });
});
