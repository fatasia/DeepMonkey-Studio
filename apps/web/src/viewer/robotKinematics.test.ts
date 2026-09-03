import { describe, expect, it } from "vitest";
import { createRobotKinematicsState, normalizeRobotKinematicsState, robotLoadCapabilityFromPrefab } from "./robotKinematics";

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
      loadCapability: { ratedPayloadKg: Number.NaN, maximumLoadCenterDistanceMeters: -.2, source: "author-confirmed" },
      toolLoad: { toolMassKg: -1, carriedPayloadKg: 0, tcpPositionMeters: { x: 0, y: 0, z: .2 }, source: "imported" },
    });

    expect(state.targetObjectIds).toEqual(["target"]);
    expect(state.joints[0]).toMatchObject({ length: 1, minAngleDeg: -360, maxAngleDeg: 180 });
    expect(state.loadCapability).toEqual({ source: "author-confirmed" });
    expect(state.toolLoad).toEqual({ carriedPayloadKg: 0, tcpPositionMeters: { x: 0, y: 0, z: .2 }, source: "imported" });
  });

  it("reuses only an explicit robot prefab payload as planning evidence", () => {
    expect(robotLoadCapabilityFromPrefab({
      definitionId: "robot.articulated-6", definitionVersion: "1.0.0", kind: "robot-arm",
      parameters: { payloadKg: 20 }, operatingState: "idle",
    })).toEqual({ ratedPayloadKg: 20, source: "configured-prefab", reference: "robot.articulated-6@1.0.0" });
    expect(robotLoadCapabilityFromPrefab({
      definitionId: "machine.cnc", definitionVersion: "1.0.0", kind: "machine",
      parameters: { payloadKg: 20 }, operatingState: "idle",
    })).toBeUndefined();
  });
});
