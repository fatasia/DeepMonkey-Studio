import type { WorkcellAuditObject, WorkcellErgonomicsProfile } from "@bim-studio/contracts";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { describe, expect, it } from "vitest";
import { analyzeHumanErgonomics } from "./ergonomicsScreening.js";
import { workcellAuditInputSchema } from "./workcellSchemas.js";

describe("human work planning screening", () => {
  it("keeps an unconfigured person in needs-data without population defaults", () => {
    const [check] = analyzeHumanErgonomics([{ id: "human-1", name: "人工装配", operatorObjectId: "person-1" }], objects());

    expect(check).toMatchObject({
      status: "needs-data",
      missingFields: expect.arrayContaining(["anthropometry-method", "stature", "work-point", "load-mass", "maximum-load"]),
      rules: expect.arrayContaining([expect.objectContaining({ id: "shoulder-reach", status: "needs-data" })]),
    });
    expect(check?.rules.some((item) => item.measuredValue === 0)).toBe(false);
  });

  it("returns pass and warning at explicit policy boundaries", () => {
    const profile = completeProfile();
    const passed = analyzeHumanErgonomics([profile], objects())[0]!;
    expect(passed.status).toBe("pass");
    expect(passed.evidenceCoverage).toBe(1);

    profile.task!.loadMassKg = 8;
    const warned = analyzeHumanErgonomics([profile], objects())[0]!;
    expect(warned.status).toBe("warn");
    expect(warned.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manual-load", status: "warn", utilization: .8 }),
    ]));
  });

  it("keeps a proven reach or handling failure blocking when other evidence is missing", () => {
    const profile = completeProfile();
    profile.task!.loadMassKg = 12;
    delete profile.task!.durationMinutes;
    const result = analyzeHumanErgonomics([profile], objects())[0]!;

    expect(result.status).toBe("fail");
    expect(result.missingFields).toContain("duration");
    expect(result.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "manual-load", status: "fail" }),
    ]));
  });

  it("does not accept the operator object itself as a work point", () => {
    const profile = completeProfile();
    profile.task!.workPointObjectId = profile.operatorObjectId;
    const result = analyzeHumanErgonomics([profile], objects())[0]!;

    expect(result.status).toBe("needs-data");
    expect(result.missingFields).toContain("work-point");
    expect(result.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "shoulder-reach", status: "needs-data" }),
    ]));
  });

  it("requires references for imported evidence and rejects invalid numeric inputs at the schema boundary", () => {
    const profile = completeProfile();
    profile.anthropometry!.source = "imported";
    expect(analyzeHumanErgonomics([profile], objects())[0]?.missingFields).toContain("anthropometry-reference");
    const input = { sceneId: "scene", objects: objects(), ergonomicsProfiles: [completeProfile()] };
    expect(validateCapabilityValue(workcellAuditInputSchema, input)).toEqual([]);
    input.ergonomicsProfiles[0]!.policy!.warningUtilizationRatio = 1.2;
    expect(validateCapabilityValue(workcellAuditInputSchema, input)).not.toEqual([]);
  });
});

function completeProfile(): WorkcellErgonomicsProfile {
  return {
    id: "human-1", name: "人工装配", operatorObjectId: "person-1",
    anthropometry: {
      method: "percentile", percentile: 50, statureMeters: 1.72, shoulderHeightMeters: 1.42,
      elbowHeightMeters: 1.08, functionalReachMeters: .75, source: "author-confirmed",
    },
    task: {
      workPointObjectId: "station-1", loadMassKg: 4, repetitionsPerHour: 30,
      durationMinutes: 45, source: "author-confirmed",
    },
    policy: {
      maximumLoadKg: 10, maximumRepetitionsPerHour: 60, maximumDurationMinutes: 60,
      neutralHeightToleranceMeters: .3, warningUtilizationRatio: .8, source: "author-confirmed",
    },
  };
}

function objects(): WorkcellAuditObject[] {
  return [
    { id: "person-1", name: "操作员", role: "equipment", position: { x: 0, y: 0, z: 0 } },
    { id: "station-1", name: "装配点", role: "target", position: { x: .35, y: 1.08, z: 0 } },
  ];
}
