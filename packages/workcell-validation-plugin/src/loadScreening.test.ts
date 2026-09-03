import type { WorkcellAuditObject } from "@bim-studio/contracts";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { describe, expect, it } from "vitest";
import { analyzeRobotLoadCapabilities } from "./loadScreening.js";
import { workcellAuditInputSchema } from "./workcellSchemas.js";

describe("robot load capability planning screen", () => {
  it("keeps absent measurements as needs-data without manufacturing defaults", () => {
    const [check] = analyzeRobotLoadCapabilities([robot(), tool()]);

    expect(check).toMatchObject({
      status: "needs-data",
      evidenceCoverage: 0.1,
      missingFields: expect.arrayContaining([
        "rated-payload", "rated-load-center", "capability-source", "tool-mass",
        "carried-payload", "tcp-position", "tcp-orientation", "combined-center-of-mass", "tool-load-source",
      ]),
    });
    expect(check).not.toHaveProperty("totalLoadKg");
    expect(check).not.toHaveProperty("ratedPayloadKg");
  });

  it("proves a planning-envelope pass only when every required field has evidence", () => {
    const configured = robot();
    configured.robot = {
      ...configured.robot!,
      loadCapability: {
        ratedPayloadKg: 20,
        maximumLoadCenterDistanceMeters: .35,
        source: "configured-prefab",
      },
      toolLoad: {
        toolMassKg: 4,
        carriedPayloadKg: 8,
        tcpPositionMeters: { x: 0, y: 0, z: .25 },
        tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
        combinedCenterOfMassMeters: { x: 0, y: 0, z: .2 },
        source: "author-confirmed",
      },
    };

    expect(analyzeRobotLoadCapabilities([configured, tool()])[0]).toMatchObject({
      status: "within-planning-envelope",
      missingFields: [],
      violations: [],
      ratedPayloadKg: 20,
      totalLoadKg: 12,
      payloadUtilization: .6,
      maximumLoadCenterDistanceMeters: .35,
      loadCenterDistanceMeters: .2,
      tcpOffsetDistanceMeters: .25,
      evidenceCoverage: 1,
    });
  });

  it("keeps a proven overload blocking even when another measurement is absent", () => {
    const configured = robot();
    configured.robot = {
      ...configured.robot!,
      loadCapability: { ratedPayloadKg: 10, source: "author-confirmed" },
      toolLoad: { toolMassKg: 7, carriedPayloadKg: 5, source: "author-confirmed" },
    };

    expect(analyzeRobotLoadCapabilities([configured, tool()])[0]).toMatchObject({
      status: "exceeds-planning-envelope",
      violations: ["payload"],
      totalLoadKg: 12,
      missingFields: expect.arrayContaining(["rated-load-center", "tcp-position", "tcp-orientation", "combined-center-of-mass"]),
    });
  });

  it("rejects invalid load measurements at the capability boundary", () => {
    const configured = robot();
    configured.robot = {
      ...configured.robot!,
      loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35, source: "imported" },
      toolLoad: {
        toolMassKg: 4, carriedPayloadKg: 8,
        tcpPositionMeters: { x: 0, y: 0, z: .2 }, tcpOrientationEulerDeg: { x: 0, y: 0, z: 0 },
        combinedCenterOfMassMeters: { x: 0, y: 0, z: .15 }, source: "author-confirmed",
      },
    };
    expect(validateCapabilityValue(workcellAuditInputSchema, { sceneId: "scene", objects: [configured, tool()] })).toEqual([]);

    configured.robot.loadCapability!.ratedPayloadKg = -1;
    expect(validateCapabilityValue(workcellAuditInputSchema, { sceneId: "scene", objects: [configured, tool()] })).not.toEqual([]);
  });
});

function robot(): WorkcellAuditObject {
  return {
    id: "robot-1", name: "机器人", role: "robot", position: { x: 0, y: 0, z: 0 },
    robot: {
      base: { x: 0, y: 0, z: 0 },
      toolObjectId: "tool-1",
      links: [{ id: "j1", name: "J1", length: 1, minAngleDeg: -180, maxAngleDeg: 180 }],
    },
  };
}

function tool(): WorkcellAuditObject {
  return { id: "tool-1", name: "抓手", role: "tool", position: { x: 0, y: 0, z: 1 } };
}
